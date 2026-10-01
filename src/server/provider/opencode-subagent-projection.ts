import type { Event } from "@opencode-ai/sdk/v2";

import type { SubagentTaskUsage, SubagentTraceStatus } from "../../shared/contracts";
import type { AgentHarnessEmitter } from "./agent-harness";
import {
  openCodeContextTokens,
  openCodeMessageUsage,
  openCodeToolPartLabel,
} from "./opencode-event-projection";
import type { OpenCodeEventSessionScope } from "./opencode-session-ownership";
import {
  errorMessage,
  objectValue,
  openCodeEventSessionId,
  stringValue,
} from "./opencode-sdk-support";
import {
  boundedSubagentText,
  isTerminalSubagentStatus,
  MAX_SUBAGENT_DESCRIPTION_CHARS,
  MAX_SUBAGENT_RESULT_CHARS,
  MAX_SUBAGENT_TRACES_PER_TURN,
} from "./subagent-trace";

const MAX_SUBAGENT_LABEL_CHARS = 200;
const MAX_CHILD_MESSAGES = 2_048;
const MAX_RECENT_CHILD_MESSAGES = 128;
const MAX_CHILD_TOOL_PARTS = 4_096;
const MAX_CHILD_RESULT_PARTS = 128;
const SESSION_ERROR_FALLBACK = "OpenCode reported an error for this delegated task.";
const TASK_ERROR_FALLBACK = "OpenCode reported that this delegated task failed.";

type OpenCodeSubagentUpdate = Parameters<AgentHarnessEmitter["subagent"]>[0];
type OpenCodeSettledStatus = Extract<
  SubagentTraceStatus,
  "completed" | "failed" | "cancelled" | "lost"
>;

interface OpenCodeChildTrace {
  parentSessionId: string;
  name: string | null;
  description: string | null;
  status: SubagentTraceStatus;
  providerStatus: "busy" | "idle" | null;
  model: string | null;
  maxContextTokens: number | null;
  activity: string | null;
  messageTotals: Map<string, number | null | undefined>;
  uncountedMessages: boolean;
  totalTokens: number;
  unknownTotals: number;
  lastAssistantId: string | null;
  lastAssistantCreatedAt: number | null;
  recentAssistantIds: Set<string>;
  usage: SubagentTaskUsage | null;
  toolParts: Set<string>;
  uncountedToolParts: boolean;
  textParts: Map<string, string>;
  text: string | null;
  result: string | null;
  emitted: string | null;
}

export interface OpenCodeSubagentProjectionOptions {
  rootSessionId: string;
  emit: AgentHarnessEmitter["subagent"];
  contextLimit: (providerId: string, modelId: string) => number | null;
  redact: <T>(value: T) => T;
}

export class OpenCodeSubagentProjection {
  private readonly children = new Map<string, OpenCodeChildTrace>();
  private sequence = 0;
  private sealed = false;

  constructor(private readonly options: OpenCodeSubagentProjectionOptions) {}

  observe(
    event: Event,
    scope: Exclude<OpenCodeEventSessionScope, "unrelated">,
    active: boolean,
  ): void {
    if (this.sealed) return;
    if (scope === "root") {
      if (taskToolPart(event)) {
        this.attributeTask(
          this.options.rootSessionId,
          taskToolPart(this.options.redact(event)),
        );
      }
      return;
    }
    const sessionId = openCodeEventSessionId(event);
    if (!sessionId) return;
    if (event.type === "session.created") {
      if (active) this.spawn(sessionId, this.options.redact(event));
      return;
    }
    const child = this.children.get(sessionId);
    if (!child || isTerminalSubagentStatus(child.status)) return;
    const properties = event.properties as Record<string, unknown>;
    const sessionStatus = event.type === "session.status"
      ? objectValue(properties.status)?.type
      : undefined;
    if (event.type === "session.idle" || sessionStatus === "idle") {
      child.status = "waiting";
      child.providerStatus = "idle";
      child.activity = null;
      this.publish(sessionId, child);
      return;
    }
    if (event.type === "session.error") {
      const error = objectValue(this.options.redact(properties).error);
      this.settle(
        sessionId,
        child,
        error?.name === "MessageAbortedError" ? "cancelled" : "failed",
        error ? errorMessage(error) : SESSION_ERROR_FALLBACK,
      );
      return;
    }
    if (event.type === "session.deleted") {
      this.settle(sessionId, child, "lost", null);
      return;
    }
    if (!active && sessionStatus !== "busy" && sessionStatus !== "retry") return;
    child.status = "running";
    child.providerStatus = "busy";
    if (active && event.type === "message.updated") {
      this.message(child, objectValue(this.options.redact(properties).info));
    } else if (active && event.type === "message.part.updated") {
      this.part(sessionId, child, objectValue(this.options.redact(properties).part));
    }
    this.publish(sessionId, child);
  }

  cancelLive(): void {
    if (this.sealed) return;
    for (const [sessionId, child] of this.children) {
      if (!isTerminalSubagentStatus(child.status)) {
        this.settle(sessionId, child, "cancelled", null);
      }
    }
    this.sealed = true;
  }

  finish(completed: boolean): void {
    if (this.sealed) return;
    if (completed) {
      for (const [sessionId, child] of this.children) {
        if (child.status === "waiting") {
          this.settle(sessionId, child, "completed", child.text);
        }
      }
    }
    this.sealed = true;
  }

  private spawn(sessionId: string, event: Event): void {
    if (
      this.children.has(sessionId)
      || this.children.size >= MAX_SUBAGENT_TRACES_PER_TURN
    ) return;
    const info = objectValue(
      (event.properties as Record<string, unknown>).info,
    );
    const parentSessionId = stringValue(info?.parentID);
    if (!parentSessionId) return;
    const child: OpenCodeChildTrace = {
      parentSessionId,
      name: boundedSubagentText(info?.title, MAX_SUBAGENT_LABEL_CHARS),
      description: null,
      status: "spawned",
      providerStatus: null,
      model: null,
      maxContextTokens: null,
      activity: null,
      messageTotals: new Map(),
      uncountedMessages: false,
      totalTokens: 0,
      unknownTotals: 0,
      lastAssistantId: null,
      lastAssistantCreatedAt: null,
      recentAssistantIds: new Set(),
      usage: null,
      toolParts: new Set(),
      uncountedToolParts: false,
      textParts: new Map(),
      text: null,
      result: null,
      emitted: null,
    };
    this.children.set(sessionId, child);
    this.publish(sessionId, child);
  }

  private message(
    child: OpenCodeChildTrace,
    info: Record<string, unknown> | undefined,
  ): void {
    const messageId = stringValue(info?.id);
    if (!info || !messageId || info.role !== "assistant") return;
    const rawCreatedAt = objectValue(info.time)?.created;
    const createdAt = typeof rawCreatedAt === "number" && Number.isFinite(rawCreatedAt) && rawCreatedAt >= 0
      ? rawCreatedAt
      : null;
    const seen = messageId === child.lastAssistantId
      || child.messageTotals.has(messageId)
      || child.recentAssistantIds.has(messageId);
    // Usage accounting stops retaining new IDs at its cap. Track recent
    // identities separately, with provider timestamps covering older replays.
    if (!seen) {
      child.recentAssistantIds.add(messageId);
      if (child.recentAssistantIds.size > MAX_RECENT_CHILD_MESSAGES) {
        child.recentAssistantIds.delete(child.recentAssistantIds.values().next().value!);
      }
      if (
        child.lastAssistantCreatedAt === null
        || (createdAt !== null && createdAt >= child.lastAssistantCreatedAt)
      ) {
        child.lastAssistantId = messageId;
        child.textParts.clear();
        child.text = null;
      }
    }
    if (messageId === child.lastAssistantId && createdAt !== null) {
      child.lastAssistantCreatedAt = Math.max(child.lastAssistantCreatedAt ?? 0, createdAt);
    }
    if (!child.messageTotals.has(messageId)) {
      if (child.messageTotals.size < MAX_CHILD_MESSAGES) {
        child.messageTotals.set(messageId, undefined);
      } else {
        child.uncountedMessages = true;
      }
    }
    const counted = child.messageTotals.has(messageId);
    const providerId = stringValue(info.providerID);
    const modelId = stringValue(info.modelID);
    child.model = boundedSubagentText(
      [providerId, modelId].filter(Boolean).join("/"),
      MAX_SUBAGENT_LABEL_CHARS,
    ) ?? child.model;
    if (providerId && modelId) {
      child.maxContextTokens = this.options.contextLimit(providerId, modelId);
    }
    const tokens = objectValue(info.tokens);
    if (!tokens) return;
    const usage = openCodeMessageUsage(tokens);
    if (counted) {
      const previous = child.messageTotals.get(messageId);
      if (previous === null) child.unknownTotals -= 1;
      else if (previous !== undefined) child.totalTokens -= previous;
      if (usage.total === null) child.unknownTotals += 1;
      else child.totalTokens += usage.total;
      child.messageTotals.set(messageId, usage.total);
    }
    child.usage = {
      totalTokens: child.unknownTotals === 0 && !child.uncountedMessages
        ? child.totalTokens
        : null,
      inputTokens: usage.input,
      cachedInputTokens: usage.cachedRead,
      cacheWriteInputTokens: usage.cacheWrite,
      outputTokens: usage.output,
      reasoningOutputTokens: usage.reasoning,
      contextTokens: openCodeContextTokens(usage),
      maxContextTokens: child.maxContextTokens,
    };
  }

  private part(
    sessionId: string,
    child: OpenCodeChildTrace,
    part: Record<string, unknown> | undefined,
  ): void {
    const partId = stringValue(part?.id);
    if (!part || !partId) return;
    if (part.type === "tool") {
      if (!child.toolParts.has(partId)) {
        if (child.toolParts.size < MAX_CHILD_TOOL_PARTS) child.toolParts.add(partId);
        else child.uncountedToolParts = true;
      }
      const status = objectValue(part.state)?.status;
      if (status === "pending" || status === "running") {
        child.activity = boundedSubagentText(
          openCodeToolPartLabel(part),
          MAX_SUBAGENT_LABEL_CHARS,
        ) ?? child.activity;
      }
      this.attributeTask(sessionId, part);
      return;
    }
    const messageId = stringValue(part.messageID);
    if (
      part.type === "text"
      && part.synthetic !== true
      && typeof part.text === "string"
      && messageId
      && messageId === child.lastAssistantId
    ) {
      if (!child.textParts.has(partId) && child.textParts.size >= MAX_CHILD_RESULT_PARTS) return;
      child.textParts.set(partId, part.text.slice(0, MAX_SUBAGENT_RESULT_CHARS));
      // Keep each bounded snapshot so shortening an earlier part can reveal
      // later text again, without requiring the provider to resend that part.
      let text = "";
      for (const snapshot of child.textParts.values()) {
        const remaining = MAX_SUBAGENT_RESULT_CHARS - text.length;
        if (remaining === 0) break;
        text += snapshot.slice(0, remaining);
      }
      child.text = text || null;
    }
  }

  private attributeTask(
    sessionId: string,
    part: Record<string, unknown> | undefined,
  ): void {
    if (part?.tool !== "task") return;
    const state = objectValue(part.state);
    const childId = stringValue(objectValue(state?.metadata)?.sessionId);
    const child = childId ? this.children.get(childId) : undefined;
    if (
      !childId
      || !child
      || child.parentSessionId !== sessionId
      || isTerminalSubagentStatus(child.status)
    ) return;
    const input = objectValue(state?.input);
    child.description = boundedSubagentText(
      input?.prompt,
      MAX_SUBAGENT_DESCRIPTION_CHARS,
    ) ?? boundedSubagentText(
      input?.description,
      MAX_SUBAGENT_DESCRIPTION_CHARS,
    ) ?? child.description;
    if (state?.status === "completed") {
      this.settle(childId, child, "completed", child.text);
    } else if (state?.status === "error") {
      const error = objectValue(state.error);
      this.settle(
        childId,
        child,
        "failed",
        error ? errorMessage(error) : stringValue(state.error) ?? TASK_ERROR_FALLBACK,
      );
    } else {
      this.publish(childId, child);
    }
  }

  private settle(
    sessionId: string,
    child: OpenCodeChildTrace,
    status: OpenCodeSettledStatus,
    result: string | null,
  ): void {
    child.status = status;
    child.activity = null;
    child.result = boundedSubagentText(result, MAX_SUBAGENT_RESULT_CHARS);
    child.textParts.clear();
    child.text = null;
    this.publish(sessionId, child);
    child.messageTotals.clear();
    child.recentAssistantIds.clear();
    child.toolParts.clear();
  }

  private publish(sessionId: string, child: OpenCodeChildTrace): void {
    const live = !isTerminalSubagentStatus(child.status);
    const update: Omit<OpenCodeSubagentUpdate, "sequence"> = {
      providerTaskId: null,
      providerAgentId: sessionId,
      parentProviderAgentId: child.parentSessionId === this.options.rootSessionId
        ? null
        : child.parentSessionId,
      parentProviderToolUseId: null,
      providerToolUseId: null,
      providerRole: null,
      providerName: child.name,
      ...(child.providerStatus ? { providerStatus: child.providerStatus } : {}),
      status: child.status,
      isLive: live,
      description: child.description,
      progress: null,
      result: live ? null : child.result,
      ...(child.model ? { model: child.model } : {}),
      ...(live && child.activity ? { activity: child.activity } : {}),
      ...(child.usage ? { usage: child.usage } : {}),
      ...(child.toolParts.size > 0 && !child.uncountedToolParts
        ? { toolUseCount: child.toolParts.size }
        : {}),
    };
    const emitted = JSON.stringify(update);
    if (emitted === child.emitted) return;
    child.emitted = emitted;
    this.sequence += 1;
    this.options.emit({ sequence: this.sequence, ...update });
  }
}

function taskToolPart(event: Event): Record<string, unknown> | undefined {
  if (event.type !== "message.part.updated") return undefined;
  const part = objectValue((event.properties as Record<string, unknown>).part);
  return part?.type === "tool" && part.tool === "task" ? part : undefined;
}
