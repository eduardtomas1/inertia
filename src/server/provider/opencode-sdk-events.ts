import { randomUUID } from "node:crypto";

import type { Event, OpencodeClient, QuestionInfo } from "@opencode-ai/sdk/v2";

import type { AgentHarnessStartOptions } from "./agent-harness";
import { createAgentHarnessEmitter } from "./agent-harness";
import { type ProviderRunFailure } from "./contracts";
import { CappedProviderBuffer } from "./io";
import {
  openCodeInteractionId,
  openCodeQuestionPayload,
  openCodeQuestions,
} from "./opencode-boundary";
import {
  emitOpenCodeNextActivity,
  emitOpenCodeUsage,
  emitOpenCodeUsageSnapshot,
  handleOpenCodeNextTextEvent,
  handleOpenCodePart,
  handleOpenCodePartDelta,
  rememberOpenCodeMessageRole,
  removeOpenCodeMessage,
  removeOpenCodePart,
  replayOpenCodeParts,
  type OpenCodeEventState,
  type OpenCodeUsageState,
} from "./opencode-event-projection";
import { OpenCodeRunOwnership } from "./opencode-run-ownership";
import {
  activityIdentity,
  bounded,
  errorMessage,
  finite,
  objectValue,
  openCodeApprovalDisplay,
  openCodeProviderFailure,
  stringValue,
  todoStep,
} from "./opencode-sdk-support";

const MAX_PENDING_INTERACTIONS = 64;
const MAX_OBSERVED_INTERACTIONS = 256;

export type OpenCodeInteractionProtocol = "legacy" | "v2";

export interface OpenCodePendingApproval {
  nativeId: string;
  protocol: OpenCodeInteractionProtocol;
  sessionId: string;
  settled: boolean;
  externalResolution: Promise<void>;
  resolveExternal(): void;
}

export interface OpenCodePendingInput {
  nativeId: string;
  protocol: OpenCodeInteractionProtocol;
  sessionId: string;
  questions: QuestionInfo[];
  settled: boolean;
  externalResolution: Promise<void>;
  resolveExternal(): void;
}

export interface OpenCodeInteractionState {
  approvals: Set<string>;
  inputs: Set<string>;
}

export function createOpenCodeInteractionState(): OpenCodeInteractionState {
  return { approvals: new Set(), inputs: new Set() };
}

export interface OpenCodePromptLifecycle {
  messageId: string;
  observed: boolean;
  activityObserved: boolean;
}

export interface OpenCodeFailureState {
  pending?: ProviderRunFailure;
  terminal?: ProviderRunFailure;
}

export function openCodeEventRequiresPromptAdmission(event: Event): boolean {
  return event.type === "permission.asked"
    || event.type === "permission.v2.asked"
    || event.type === "permission.replied"
    || event.type === "permission.v2.replied"
    || event.type === "question.asked"
    || event.type === "question.v2.asked"
    || event.type === "question.replied"
    || event.type === "question.v2.replied"
    || event.type === "question.rejected"
    || event.type === "question.v2.rejected";
}

export function handleOpenCodeInteractionEvent(
  event: Event,
  options: AgentHarnessStartOptions,
  client: OpencodeClient,
  emitter: ReturnType<typeof createAgentHarnessEmitter>,
  approvals: Map<string, OpenCodePendingApproval>,
  inputs: Map<string, OpenCodePendingInput>,
  interactionState: OpenCodeInteractionState,
  promptLifecycle: OpenCodePromptLifecycle,
  ownership: OpenCodeRunOwnership,
  sourceScope: "root" | "verified-descendant",
  onFailure: (error: unknown) => void,
): boolean {
  if (!openCodeEventRequiresPromptAdmission(event)) return false;
  const properties = event.properties as Record<string, unknown>;
  if (
    sourceScope === "root"
    && !ownsOpenCodeInteractionSource(event.type, properties, ownership)
  ) return true;
  if (event.type === "permission.asked" || event.type === "permission.v2.asked") {
    promptLifecycle.activityObserved = true;
    const nativeId = openCodeInteractionId(properties.id, "permission");
    const protocol = event.type === "permission.v2.asked" ? "v2" : "legacy";
    const sessionId = stringValue(properties.sessionID);
    if (!sessionId) {
      throw new Error("OpenCode sent a permission without a session identity.");
    }
    if (!observeOpenCodeInteraction(
      interactionState.approvals,
      sessionId,
      nativeId,
    )) return true;
    const permission = stringValue(properties.permission)
      ?? stringValue(properties.action)
      ?? "tool";
    if (
      options.input.access === "full"
      || (options.input.access === "auto-edit" && permission === "edit")
    ) {
      void replyOpenCodePermission(client, protocol, sessionId, nativeId, "once")
        .catch(onFailure);
      return true;
    }
    const display = openCodeApprovalDisplay(properties, permission);
    if (!display) {
      void replyOpenCodePermission(client, protocol, sessionId, nativeId, "reject")
        .catch(onFailure);
      return true;
    }
    const { detail, resources, title } = display;
    const requestId = randomUUID();
    if (approvals.size >= MAX_PENDING_INTERACTIONS) {
      throw new Error("OpenCode exceeded the bounded approval budget.");
    }
    approvals.set(requestId, {
      nativeId,
      protocol,
      sessionId,
      settled: false,
      ...openCodeExternalResolution(),
    });
    emitter.rich({
      type: "approval",
      request: {
        requestId,
        kind: permission === "bash"
          ? "command"
          : permission === "edit"
            ? "file-change"
            : "permissions",
        title: bounded(title),
        detail: bounded(detail),
        cwd: options.input.cwd,
        permissionRoots: resources
          .map((path) => ({ path: bounded(path), access: "write" as const }))
          .slice(0, 20),
        availableDecisions: ["approve", "deny", "cancel"],
      },
    });
    return true;
  }
  if (event.type === "permission.replied" || event.type === "permission.v2.replied") {
    const nativeId = stringValue(properties.requestID);
    const sessionId = stringValue(properties.sessionID);
    if (nativeId && sessionId) {
      resolveOpenCodeApproval(
        nativeId,
        sessionId,
        properties.reply,
        approvals,
        emitter,
      );
    }
    return true;
  }
  if (event.type === "question.asked" || event.type === "question.v2.asked") {
    promptLifecycle.activityObserved = true;
    const nativeId = openCodeInteractionId(properties.id, "question");
    const protocol = event.type === "question.v2.asked" ? "v2" : "legacy";
    const sessionId = stringValue(properties.sessionID);
    if (!sessionId) {
      throw new Error("OpenCode sent a question without a session identity.");
    }
    if (!observeOpenCodeInteraction(
      interactionState.inputs,
      sessionId,
      nativeId,
    )) return true;
    const questions = openCodeQuestionPayload(properties.questions);
    const requestId = randomUUID();
    if (inputs.size >= MAX_PENDING_INTERACTIONS) {
      throw new Error("OpenCode exceeded the bounded question budget.");
    }
    inputs.set(requestId, {
      nativeId,
      protocol,
      sessionId,
      questions,
      settled: false,
      ...openCodeExternalResolution(),
    });
    emitter.rich({ type: "input", request: openCodeQuestions(requestId, questions) });
    return true;
  }
  const nativeId = stringValue(properties.requestID);
  const sessionId = stringValue(properties.sessionID);
  if (nativeId && sessionId) {
    resolveOpenCodeInput(nativeId, sessionId, inputs, emitter);
  }
  return true;
}

export function handleOpenCodeEvent(
  event: Event,
  options: AgentHarnessStartOptions,
  client: OpencodeClient,
  resultText: CappedProviderBuffer,
  emitter: ReturnType<typeof createAgentHarnessEmitter>,
  approvals: Map<string, OpenCodePendingApproval>,
  inputs: Map<string, OpenCodePendingInput>,
  interactionState: OpenCodeInteractionState,
  emittedParts: Map<string, string>,
  usageState: OpenCodeUsageState,
  eventState: OpenCodeEventState,
  promptLifecycle: OpenCodePromptLifecycle,
  ownership: OpenCodeRunOwnership,
  failureState: OpenCodeFailureState,
  onFailure: (error: unknown) => void,
): void {
  const properties = event.properties as Record<string, unknown>;
  if (
    event.type === "session.next.prompt.admitted"
    || event.type === "session.next.prompted"
  ) {
    const promptId = stringValue(properties.messageID);
    if (promptId && ownership.acceptPrompt(promptId)) {
      if (promptId === promptLifecycle.messageId) {
        promptLifecycle.observed = true;
      }
    }
  }
  if (handleOpenCodeInteractionEvent(
    event,
    options,
    client,
    emitter,
    approvals,
    inputs,
    interactionState,
    promptLifecycle,
    ownership,
    "root",
    onFailure,
  )) return;
  if (event.type === "message.updated") {
    const info = objectValue(properties.info);
    const messageId = stringValue(info?.id);
    if (messageId) {
      const assistant = info?.role === "assistant";
      const ownedAssistant = assistant && ownership.claimAssistant(
        messageId,
        stringValue(info.parentID),
      );
      if (assistant && !ownedAssistant) return;
      rememberOpenCodeMessageRole(
        messageId,
        assistant ? "assistant" : "other",
        eventState,
      );
      if (messageId === promptLifecycle.messageId) promptLifecycle.observed = true;
      if (
        assistant
        && stringValue(info.parentID) === promptLifecycle.messageId
      ) {
        promptLifecycle.observed = true;
        promptLifecycle.activityObserved = true;
      }
      if (ownedAssistant) promptLifecycle.activityObserved = true;
    }
    if (info?.role === "assistant" && messageId) {
      const tokens = objectValue(info.tokens);
      if (tokens) emitOpenCodeUsage(messageId, tokens, usageState, emitter.rich);
      const error = objectValue(info.error);
      if (error) {
        const failure = openCodeProviderFailure(
          error,
          "message.updated",
          messageId,
          undefined,
          options.input.cwd,
        );
        failureState.pending = failure;
        emitter.activity("system", "failed", failure.message, {
          activityId: messageId,
          ...(failure.technicalDetail
            ? { detail: failure.technicalDetail }
            : {}),
        });
      } else if (failureState.pending?.activityId === messageId) {
        // message.updated is an authoritative snapshot. A later snapshot that
        // removes the error proves that this assistant attempt recovered.
        failureState.pending = undefined;
      }
      replayOpenCodeParts(
        messageId,
        emittedParts,
        resultText,
        emitter,
        eventState,
      );
    }
  } else if (event.type === "message.removed") {
    const messageId = stringValue(properties.messageID);
    ownership.markAssistantWork(messageId);
    if (messageId) {
      removeOpenCodeMessage(messageId, emittedParts, eventState, emitter);
    }
  } else if (event.type === "message.part.updated") {
    const part = objectValue(properties.part);
    if (part) {
      const messageId = stringValue(part.messageID);
      const ownedAssistant = ownership.ownsAssistant(messageId);
      if (ownedAssistant) {
        ownership.markAssistantWork(messageId);
        promptLifecycle.activityObserved = true;
      }
      if (
        !ownedAssistant
        && part.type !== "text"
        && part.type !== "reasoning"
      ) return;
      handleOpenCodePart(
        part,
        emittedParts,
        resultText,
        emitter,
        usageState,
        eventState,
      );
    }
  } else if (event.type === "message.part.removed") {
    const partId = stringValue(properties.partID);
    ownership.markAssistantWork(stringValue(properties.messageID));
    if (partId) removeOpenCodePart(partId, emittedParts, eventState, emitter);
  } else if (event.type === "message.part.delta") {
    const partId = stringValue(properties.partID);
    const messageId = stringValue(properties.messageID);
    const delta = stringValue(properties.delta);
    const ownedAssistant = ownership.ownsAssistant(messageId);
    if (ownedAssistant) {
      ownership.markAssistantWork(messageId);
      promptLifecycle.activityObserved = true;
    }
    if (
      ownedAssistant
      &&
      properties.field === "text"
      && partId
      && messageId
      && delta
    ) handleOpenCodePartDelta(
      partId,
      messageId,
      delta,
      emittedParts,
      resultText,
      emitter,
      eventState,
    );
  } else if (
    event.type === "session.next.text.started"
    || event.type === "session.next.text.delta"
    || event.type === "session.next.text.ended"
  ) {
    const assistantId = stringValue(properties.assistantMessageID);
    if (
      !assistantId
      || !ownership.claimAssistant(assistantId, undefined, true)
    ) return;
    promptLifecycle.activityObserved = true;
    handleOpenCodeNextTextEvent(
      event.type,
      properties,
      "text",
      emittedParts,
      resultText,
      emitter,
      eventState,
    );
  } else if (
    event.type === "session.next.reasoning.started"
    || event.type === "session.next.reasoning.delta"
    || event.type === "session.next.reasoning.ended"
  ) {
    const assistantId = stringValue(properties.assistantMessageID);
    if (
      !assistantId
      || !ownership.claimAssistant(assistantId, undefined, true)
    ) return;
    promptLifecycle.activityObserved = true;
    handleOpenCodeNextTextEvent(
      event.type,
      properties,
      "reasoning",
      emittedParts,
      resultText,
      emitter,
      eventState,
    );
  } else if (event.type === "session.next.agent.switched") {
    const messageIdentity = stringValue(properties.messageID);
    if (!ownership.ownsPromptOrAssistant(messageIdentity)) return;
    ownership.markActivePromptWork();
    promptLifecycle.activityObserved = true;
    const agent = stringValue(properties.agent);
    if (agent) {
      emitter.activity(
        "system",
        "info",
        bounded(`OpenCode switched to the ${agent} agent`),
        activityIdentity(properties.messageID),
      );
    }
  } else if (event.type === "session.next.model.switched") {
    const messageIdentity = stringValue(properties.messageID);
    if (!ownership.ownsPromptOrAssistant(messageIdentity)) return;
    ownership.markActivePromptWork();
    promptLifecycle.activityObserved = true;
    const model = objectValue(properties.model);
    const providerId = stringValue(model?.providerID);
    const modelId = stringValue(model?.modelID);
    const label = [providerId, modelId].filter(Boolean).join("/");
    if (label) {
      emitter.activity(
        "system",
        "info",
        bounded(`OpenCode switched to ${label}`),
        activityIdentity(properties.messageID),
      );
    }
  } else if (event.type === "session.next.step.started") {
    const messageId = stringValue(properties.assistantMessageID);
    if (
      !messageId
      || !ownership.claimAssistant(messageId, undefined, true)
    ) return;
    promptLifecycle.activityObserved = true;
    const agent = stringValue(properties.agent);
    const model = objectValue(properties.model);
    const providerId = stringValue(model?.providerID);
    const modelId = stringValue(model?.modelID);
    const modelLabel = [providerId, modelId].filter(Boolean).join("/");
    failureState.pending = undefined;
    emitter.activity(
      "turn",
      "started",
      bounded(agent ? `OpenCode started a ${agent} step` : "OpenCode started a step"),
      {
        ...(messageId ? { activityId: messageId } : {}),
        ...(modelLabel ? { detail: bounded(`Model: ${modelLabel}`) } : {}),
      },
    );
  } else if (event.type === "session.next.step.ended") {
    const messageId = stringValue(properties.assistantMessageID);
    if (!ownership.ownsAssistant(messageId)) return;
    ownership.markAssistantWork(messageId);
    promptLifecycle.activityObserved = true;
    const tokens = objectValue(properties.tokens);
    if (messageId && tokens) emitOpenCodeUsage(messageId, tokens, usageState, emitter.rich);
    if (messageId && failureState.pending?.activityId === messageId) {
      failureState.pending = undefined;
    }
    emitter.activity(
      "turn",
      "completed",
      bounded(
        stringValue(properties.finish)
          ? `OpenCode finished the step (${stringValue(properties.finish)})`
          : "OpenCode finished the step",
      ),
      activityIdentity(messageId),
    );
  } else if (event.type === "session.next.step.failed") {
    const error = objectValue(properties.error);
    const messageId = stringValue(properties.assistantMessageID);
    if (!ownership.ownsAssistant(messageId)) return;
    ownership.markAssistantWork(messageId);
    promptLifecycle.activityObserved = true;
    const failure = openCodeProviderFailure(
      error,
      "session.next.step.failed",
      messageId,
      "OpenCode step failed.",
      options.input.cwd,
    );
    failureState.pending = failure;
    emitter.activity(
      "turn",
      "failed",
      failure.message,
      {
        ...(messageId ? { activityId: messageId } : {}),
        ...(failure.technicalDetail
          ? { detail: failure.technicalDetail }
          : {}),
      },
    );
  } else if (event.type === "session.next.retried") {
    if (!ownership.markActivePromptWork()) return;
    promptLifecycle.activityObserved = true;
    const error = objectValue(properties.error);
    const attempt = finite(properties.attempt);
    failureState.pending = undefined;
    emitter.activity(
      "system",
      "info",
      bounded(`OpenCode retried the model${attempt === null ? "" : ` (attempt ${attempt})`}`),
      error ? { detail: bounded(errorMessage(error)) } : {},
    );
  } else if (
    event.type === "session.next.shell.started"
    || event.type === "session.next.shell.ended"
    || event.type === "session.next.tool.called"
    || event.type === "session.next.tool.progress"
    || event.type === "session.next.tool.success"
    || event.type === "session.next.tool.failed"
  ) {
    const callId = stringValue(properties.callID);
    if (event.type === "session.next.shell.started") {
      if (!ownership.ownsPromptOrAssistant(stringValue(properties.messageID))) {
        return;
      }
      ownership.markActivePromptWork();
    } else if (event.type === "session.next.shell.ended") {
      if (!callId || !eventState.activities.has(callId)) return;
      ownership.markActivePromptWork();
    } else {
      const assistantId = stringValue(properties.assistantMessageID);
      if (
        !assistantId
        || !ownership.claimAssistant(assistantId, undefined, true)
      ) return;
    }
    promptLifecycle.activityObserved = true;
    emitOpenCodeNextActivity(
      event.type,
      properties,
      emitter,
      eventState,
    );
  } else if (event.type === "todo.updated") {
    if (!ownership.markActivePromptWork()) return;
    promptLifecycle.activityObserved = true;
    const todos = Array.isArray(properties.todos) ? properties.todos : [];
    emitter.rich({ type: "plan", explanation: null, steps: todos.flatMap(todoStep) });
  } else if (event.type === "session.deleted") {
    const message = "OpenCode deleted the active session before the run completed.";
    failureState.terminal = {
      reason: "provider-error",
      message,
      phase: "session",
      terminalEvent: "session.deleted",
    };
    throw new Error(message);
  } else if (event.type === "session.status") {
    const status = objectValue(properties.status);
    if (status?.type === "retry") {
      if (!ownership.markActivePromptWork()) return;
      promptLifecycle.activityObserved = true;
      failureState.pending = undefined;
      const attempt = finite(status.attempt);
      const action = objectValue(status.action);
      emitter.activity(
        "system",
        "info",
        bounded(
          attempt === null
            ? "OpenCode is retrying the model"
            : `OpenCode is retrying the model (attempt ${attempt})`,
        ),
        {
          detail: bounded([
            stringValue(status.message),
            stringValue(action?.title),
            stringValue(action?.message),
          ].filter((value): value is string => Boolean(value)).join("\n")),
        },
      );
    } else if (status?.type === "busy") {
      if (!ownership.markActivePromptWork()) return;
      promptLifecycle.activityObserved = true;
      emitter.activity("turn", "started", "OpenCode is working");
    }
  } else if (event.type === "session.error") {
    const error = objectValue(properties.error);
    const failure = openCodeProviderFailure(
      error,
      "session.error",
      undefined,
      "OpenCode reported a session error.",
      options.input.cwd,
    );
    failureState.pending = failure;
    failureState.terminal = failure;
    emitter.activity(
      "system",
      "failed",
      failure.message,
      failure.technicalDetail ? { detail: failure.technicalDetail } : {},
    );
    throw new Error(failure.message);
  } else if (
    event.type === "session.compacted"
    || event.type === "session.next.compaction.ended"
  ) {
    if (!ownership.markActivePromptWork()) return;
    usageState.currentContextTokens = null;
    emitOpenCodeUsageSnapshot(usageState, emitter.rich);
    emitter.activity("system", "info", "OpenCode compacted the session context");
  }
}

export async function replyOpenCodePermission(
  client: OpencodeClient,
  protocol: OpenCodeInteractionProtocol,
  sessionId: string,
  nativeId: string,
  reply: "once" | "reject",
): Promise<void> {
  if (protocol === "v2") {
    await client.v2.session.permission.reply(
      { sessionID: sessionId, requestID: nativeId, reply },
      { throwOnError: true },
    );
    return;
  }
  await client.permission.reply(
    { requestID: nativeId, reply },
    { throwOnError: true },
  );
}

function ownsOpenCodeInteractionSource(
  eventType: Event["type"],
  properties: Record<string, unknown>,
  ownership: OpenCodeRunOwnership,
): boolean {
  const source = eventType === "permission.v2.asked"
    ? objectValue(properties.source)
    : objectValue(properties.tool);
  const messageId = stringValue(source?.messageID);
  return messageId
    ? ownership.markAssistantWork(messageId)
    : ownership.markActivePromptWork();
}

function observeOpenCodeInteraction(
  observed: Set<string>,
  sessionId: string,
  nativeId: string,
): boolean {
  const identity = `${sessionId.length}:${sessionId}${nativeId}`;
  if (observed.has(identity)) return false;
  if (observed.size >= MAX_OBSERVED_INTERACTIONS) {
    throw new Error("OpenCode exceeded the bounded interaction replay budget.");
  }
  observed.add(identity);
  return true;
}

function openCodeExternalResolution(): Pick<
  OpenCodePendingApproval,
  "externalResolution" | "resolveExternal"
> {
  let resolveExternal!: () => void;
  const externalResolution = new Promise<void>((resolve) => {
    resolveExternal = resolve;
  });
  return { externalResolution, resolveExternal };
}

function resolveOpenCodeApproval(
  nativeId: string,
  sessionId: string,
  reply: unknown,
  approvals: Map<string, OpenCodePendingApproval>,
  emitter: ReturnType<typeof createAgentHarnessEmitter>,
): void {
  for (const [requestId, pending] of approvals) {
    if (
      pending.nativeId !== nativeId
      || pending.sessionId !== sessionId
    ) continue;
    pending.settled = true;
    approvals.delete(requestId);
    pending.resolveExternal();
    emitter.rich({
      type: "approval-resolved",
      requestId,
      decision: reply === "reject" ? "deny" : "approve",
    });
  }
}

function resolveOpenCodeInput(
  nativeId: string,
  sessionId: string,
  inputs: Map<string, OpenCodePendingInput>,
  emitter: ReturnType<typeof createAgentHarnessEmitter>,
): void {
  for (const [requestId, pending] of inputs) {
    if (
      pending.nativeId !== nativeId
      || pending.sessionId !== sessionId
    ) continue;
    pending.settled = true;
    inputs.delete(requestId);
    pending.resolveExternal();
    emitter.rich({ type: "input-resolved", requestId });
  }
}
