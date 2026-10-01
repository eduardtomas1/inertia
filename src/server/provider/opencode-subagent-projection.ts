import type { Event } from "@opencode-ai/sdk/v2";

import type { SubagentTaskUsage, SubagentTraceStatus } from "../../shared/contracts";
import type { AgentHarnessEmitter } from "./agent-harness";
import {
  openCodeContextTokens,
  openCodeMessageUsage,
  openCodeToolPartLabel,
  type OpenCodeMessageUsage,
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
const MAX_TRACKED_CHILD_MESSAGES = 2_048;
const MAX_TRACKED_CHILD_TOOL_PARTS = 4_096;
const SESSION_ERROR_FALLBACK = "OpenCode reported an error for this delegated task.";

type OpenCodeSubagentUpdate = Parameters<AgentHarnessEmitter["subagent"]>[0];

interface OpenCodeChildTrace {
  parentSessionId: string;
  name: string | null;
  description: string | null;
  status: SubagentTraceStatus;
  model: string | null;
  maxContextTokens: number | null;
  activity: string | null;
  messages: Map<string, OpenCodeMessageUsage | null>;
  totalTokens: number;
  unknownTotals: number;
  lastUsage: OpenCodeMessageUsage | null;
  usage: SubagentTaskUsage | null;
  toolParts: Set<string>;
  toolUseCount: number;
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
  private trackedMessages = 0;
  private trackedToolParts = 0;
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
    if (
      event.type === "session.idle"
      || (
        event.type === "session.status"
        && objectValue(properties.status)?.type === "idle"
      )
    ) {
      this.settle(sessionId, child, "completed", child.text);
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
    if (!active) return;
    if (child.status === "spawned") child.status = "running";
    if (event.type === "message.updated") {
      this.message(child, objectValue(this.options.redact(properties).info));
    } else if (event.type === "message.part.updated") {
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

  seal(): void {
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
      model: null,
      maxContextTokens: null,
      activity: null,
      messages: new Map(),
      totalTokens: 0,
      unknownTotals: 0,
      lastUsage: null,
      usage: null,
      toolParts: new Set(),
      toolUseCount: 0,
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
    if (!child.messages.has(messageId)) {
      if (this.trackedMessages >= MAX_TRACKED_CHILD_MESSAGES) {
        throw new Error("OpenCode exceeded the bounded delegated-agent message budget.");
      }
      this.trackedMessages += 1;
      child.messages.set(messageId, null);
    }
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
    const previous = child.messages.get(messageId);
    if (previous?.total === null) child.unknownTotals -= 1;
    else if (previous) child.totalTokens -= previous.total;
    if (usage.total === null) child.unknownTotals += 1;
    else child.totalTokens += usage.total;
    child.messages.set(messageId, usage);
    child.lastUsage = usage;
    child.usage = {
      totalTokens: child.unknownTotals === 0 ? child.totalTokens : null,
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
        if (this.trackedToolParts >= MAX_TRACKED_CHILD_TOOL_PARTS) {
          throw new Error("OpenCode exceeded the bounded delegated-agent tool budget.");
        }
        this.trackedToolParts += 1;
        child.toolParts.add(partId);
        child.toolUseCount += 1;
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
      && part.text.trim()
      && messageId
      && child.messages.has(messageId)
    ) {
      child.text = part.text.slice(0, MAX_SUBAGENT_RESULT_CHARS);
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
    this.publish(childId, child);
  }

  private settle(
    sessionId: string,
    child: OpenCodeChildTrace,
    status: Extract<SubagentTraceStatus, "completed" | "failed" | "cancelled" | "lost">,
    result: string | null,
  ): void {
    child.status = status;
    child.activity = null;
    child.result = boundedSubagentText(result, MAX_SUBAGENT_RESULT_CHARS);
    child.text = null;
    this.trackedMessages -= child.messages.size;
    this.trackedToolParts -= child.toolParts.size;
    child.messages.clear();
    child.toolParts.clear();
    this.publish(sessionId, child);
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
      status: child.status,
      isLive: live,
      description: child.description,
      progress: null,
      result: live ? null : child.result,
      ...(child.model ? { model: child.model } : {}),
      ...(live && child.activity ? { activity: child.activity } : {}),
      ...(child.usage ? { usage: child.usage } : {}),
      ...(child.toolUseCount > 0 ? { toolUseCount: child.toolUseCount } : {}),
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
