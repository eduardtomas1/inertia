import { providerActivityDetailSections } from "./activity-detail";
import type { AgentHarnessEmitter } from "./agent-harness";
import { CappedProviderBuffer } from "./io";

const MAX_EVENT_TEXT_CHARS = 1024 * 1024;
const MAX_TRACKED_MESSAGES = 2_048;
const MAX_TRACKED_PARTS = 4_096;
const MAX_PART_CHARS = 256 * 1024;
const MAX_RETAINED_PART_CHARS = 8 * 1024 * 1024;

interface OpenCodeMessageUsage {
  total: number | null;
  input: number | null;
  cachedRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  reasoning: number | null;
}

export interface OpenCodeUsageState {
  maxTokens: number | null;
  currentContextTokens: number | null;
  messages: Map<string, OpenCodeMessageUsage>;
  totalProcessedTokens: number;
  unknownTotalMessages: number;
  last: OpenCodeMessageUsage | null;
  compactsAutomatically: true | null;
}

interface OpenCodeTrackedPart {
  messageId: string;
  type: "text" | "reasoning" | null;
  snapshot: string;
}

export interface OpenCodeEventState {
  retainedPartChars: number;
  bufferedPartChars: number;
  messageRoles: Map<string, "assistant" | "other">;
  parts: Map<string, OpenCodeTrackedPart>;
  pendingDeltas: Map<string, string>;
}

export function createOpenCodeEventState(): OpenCodeEventState {
  return {
    retainedPartChars: 0,
    bufferedPartChars: 0,
    messageRoles: new Map(),
    parts: new Map(),
    pendingDeltas: new Map(),
  };
}

export function rememberOpenCodeMessageRole(
  messageId: string,
  role: "assistant" | "other",
  state: OpenCodeEventState,
): void {
  const previous = state.messageRoles.get(messageId);
  if (previous && previous !== role) {
    throw new Error("OpenCode changed a retained message's role identity.");
  }
  if (!previous && state.messageRoles.size >= MAX_TRACKED_MESSAGES) {
    throw new Error("OpenCode exceeded the bounded message budget.");
  }
  state.messageRoles.set(messageId, role);
}

export function replayOpenCodeParts(
  messageId: string,
  emittedParts: Map<string, string>,
  resultText: CappedProviderBuffer,
  emitter: AgentHarnessEmitter,
  state: OpenCodeEventState,
): void {
  for (const [partId, part] of state.parts) {
    if (part.messageId === messageId) {
      replayOpenCodePart(partId, emittedParts, resultText, emitter, state);
    }
  }
}

export function handleOpenCodePart(
  part: Record<string, unknown>,
  emittedParts: Map<string, string>,
  resultText: CappedProviderBuffer,
  emitter: AgentHarnessEmitter,
  usageState: OpenCodeUsageState,
  eventState: OpenCodeEventState,
): void {
  if (part.type === "compaction") {
    usageState.currentContextTokens = null;
    if (part.auto === true) usageState.compactsAutomatically = true;
    emitOpenCodeUsageSnapshot(usageState, emitter.rich);
  }
  const id = stringValue(part.id);
  const messageId = stringValue(part.messageID);
  if (!id || !messageId) return;
  if (
    (part.type === "text" || part.type === "reasoning")
    && typeof part.text === "string"
  ) {
    rememberOpenCodePart(id, messageId, part.type, part.text, eventState);
    if (eventState.messageRoles.get(messageId) === "assistant") {
      replayOpenCodePart(id, emittedParts, resultText, emitter, eventState);
    }
  } else if (part.type === "tool") {
    const state = objectValue(part.state);
    const status = stringValue(state?.status) ?? "pending";
    const phase = status === "completed"
      ? "completed"
      : status === "error"
        ? "failed"
        : "started";
    const tool = stringValue(part.tool) ?? "OpenCode tool";
    const input = objectValue(state?.input);
    const error = objectValue(state?.error);
    const detail = providerActivityDetailSections({
      command: input?.command,
      ...(phase === "failed"
        ? { error: stringValue(error?.message) ?? state?.error }
        : { output: state?.output }),
    });
    emitter.activity(
      tool === "bash" ? "command" : "tool",
      phase,
      bounded(stringValue(state?.title) ?? tool),
      {
        ...(stringValue(part.callID) ?? stringValue(part.id)
          ? { activityId: (stringValue(part.callID) ?? stringValue(part.id))! }
          : {}),
        ...(detail ? { detail } : {}),
      },
    );
  }
}

export function handleOpenCodePartDelta(
  partId: string,
  messageId: string,
  delta: string,
  emittedParts: Map<string, string>,
  resultText: CappedProviderBuffer,
  emitter: AgentHarnessEmitter,
  state: OpenCodeEventState,
): void {
  const part = state.parts.get(partId);
  if (part && part.messageId !== messageId) {
    throw new Error("OpenCode changed a retained part's message identity.");
  }
  if (!part) {
    if (state.parts.size >= MAX_TRACKED_PARTS) {
      throw new Error("OpenCode exceeded the bounded part budget.");
    }
    state.parts.set(partId, { messageId, type: null, snapshot: "" });
  }
  const tracked = state.parts.get(partId)!;
  if (tracked.type && state.messageRoles.get(messageId) === "assistant") {
    if (tracked.snapshot || state.pendingDeltas.has(partId)) {
      replayOpenCodePart(partId, emittedParts, resultText, emitter, state);
    }
    appendOpenCodePartText(
      partId,
      tracked.type,
      delta,
      emittedParts,
      resultText,
      emitter,
      state,
    );
    return;
  }
  const previous = state.pendingDeltas.get(partId) ?? "";
  const next = `${previous}${delta}`;
  if (next.length > MAX_PART_CHARS) {
    throw new Error("OpenCode sent an oversized buffered message-part delta.");
  }
  const bufferedPartChars = state.bufferedPartChars - previous.length
    + next.length;
  assertOpenCodeRetainedBudget(state.retainedPartChars, bufferedPartChars);
  state.bufferedPartChars = bufferedPartChars;
  state.pendingDeltas.set(partId, next);
}

export function handleOpenCodeNextTextEvent(
  eventType:
    | "session.next.text.started"
    | "session.next.text.delta"
    | "session.next.text.ended"
    | "session.next.reasoning.started"
    | "session.next.reasoning.delta"
    | "session.next.reasoning.ended",
  properties: Record<string, unknown>,
  type: "text" | "reasoning",
  emittedParts: Map<string, string>,
  resultText: CappedProviderBuffer,
  emitter: AgentHarnessEmitter,
  state: OpenCodeEventState,
): void {
  const messageId = stringValue(properties.assistantMessageID);
  const partId = type === "text"
    ? stringValue(properties.textID)
    : stringValue(properties.reasoningID);
  if (!messageId || !partId) return;
  rememberOpenCodeMessageRole(messageId, "assistant", state);
  const suffix = eventType.split(".").at(-1);
  if (suffix === "started") {
    rememberOpenCodePart(partId, messageId, type, "", state);
    if (state.pendingDeltas.has(partId)) {
      replayOpenCodePart(partId, emittedParts, resultText, emitter, state);
    }
    return;
  }
  if (suffix === "delta") {
    const delta = stringValue(properties.delta);
    if (!delta) return;
    if (!state.parts.has(partId)) {
      rememberOpenCodePart(partId, messageId, type, "", state);
    }
    handleOpenCodePartDelta(
      partId,
      messageId,
      delta,
      emittedParts,
      resultText,
      emitter,
      state,
    );
    return;
  }
  if (typeof properties.text !== "string") return;
  rememberOpenCodePart(
    partId,
    messageId,
    type,
    properties.text,
    state,
  );
  replayOpenCodePart(partId, emittedParts, resultText, emitter, state);
}

export function emitOpenCodeNextActivity(
  eventType:
    | "session.next.shell.started"
    | "session.next.shell.ended"
    | "session.next.tool.called"
    | "session.next.tool.progress"
    | "session.next.tool.success"
    | "session.next.tool.failed",
  properties: Record<string, unknown>,
  emitter: AgentHarnessEmitter,
): void {
  const callId = stringValue(properties.callID);
  const shell = eventType.startsWith("session.next.shell.");
  const phase = eventType.endsWith(".ended")
    || eventType.endsWith(".success")
    ? "completed"
    : eventType.endsWith(".failed")
      ? "failed"
      : "started";
  const label = shell
    ? stringValue(properties.command) ?? "OpenCode shell"
    : stringValue(properties.tool) ?? "OpenCode tool";
  const detail = providerActivityDetailSections({
    ...(shell ? { command: properties.command } : {}),
    ...(phase === "failed"
      ? { error: objectValue(properties.error) ?? properties.error }
      : {
          output: properties.output
            ?? properties.result
            ?? properties.content
            ?? properties.structured,
        }),
  });
  emitter.activity(shell ? "command" : "tool", phase, bounded(label), {
    ...(callId ? { activityId: callId } : {}),
    ...(detail ? { detail } : {}),
  });
}

export function removeOpenCodeMessage(
  messageId: string,
  emittedParts: Map<string, string>,
  state: OpenCodeEventState,
): void {
  state.messageRoles.delete(messageId);
  for (const [partId, part] of state.parts) {
    if (part.messageId === messageId) {
      removeOpenCodePart(partId, emittedParts, state);
    }
  }
}

export function removeOpenCodePart(
  partId: string,
  emittedParts: Map<string, string>,
  state: OpenCodeEventState,
): void {
  const part = state.parts.get(partId);
  const pending = state.pendingDeltas.get(partId) ?? "";
  const emitted = emittedParts.get(partId) ?? "";
  state.bufferedPartChars -= (part?.snapshot.length ?? 0) + pending.length;
  state.retainedPartChars -= emitted.length;
  state.parts.delete(partId);
  state.pendingDeltas.delete(partId);
  emittedParts.delete(partId);
  assertOpenCodeRetainedBudget(
    state.retainedPartChars,
    state.bufferedPartChars,
  );
}

export function emitOpenCodeUsage(
  messageId: string,
  tokens: Record<string, unknown>,
  state: OpenCodeUsageState,
  emit: AgentHarnessEmitter["rich"],
): void {
  const input = finite(tokens.input);
  const output = finite(tokens.output);
  const reasoning = finite(tokens.reasoning);
  const cache = objectValue(tokens.cache);
  const cachedRead = finite(cache?.read);
  const cacheWrite = finite(cache?.write);
  const messageUsage: OpenCodeMessageUsage = {
    total: finite(tokens.total)
      ?? sumTokenParts([input, output, reasoning, cachedRead, cacheWrite]),
    input,
    cachedRead,
    cacheWrite,
    output,
    reasoning,
  };
  const previous = state.messages.get(messageId);
  if (!previous && state.messages.size >= MAX_TRACKED_MESSAGES) {
    throw new Error("OpenCode exceeded the bounded usage-message budget.");
  }
  if (previous?.total === null) state.unknownTotalMessages -= 1;
  else if (previous) state.totalProcessedTokens -= previous.total;
  if (messageUsage.total === null) state.unknownTotalMessages += 1;
  else state.totalProcessedTokens += messageUsage.total;
  state.messages.set(messageId, messageUsage);
  state.last = messageUsage;
  state.currentContextTokens = sumTokenParts([
    input,
    cachedRead,
    cacheWrite,
  ]);
  emitOpenCodeUsageSnapshot(state, emit);
}

export function emitOpenCodeUsageSnapshot(
  state: OpenCodeUsageState,
  emit: AgentHarnessEmitter["rich"],
): void {
  const last = state.last;
  emit({
    type: "usage",
    usage: {
      usedTokens: state.currentContextTokens,
      totalProcessedTokens: state.messages.size > 0
        && state.unknownTotalMessages === 0
        ? state.totalProcessedTokens
        : null,
      totalProcessedScope: "run",
      maxTokens: state.maxTokens,
      inputTokens: last?.input ?? null,
      cachedInputTokens: last?.cachedRead ?? null,
      cacheWriteInputTokens: last?.cacheWrite ?? null,
      outputTokens: last?.output ?? null,
      reasoningOutputTokens: last?.reasoning ?? null,
      compactsAutomatically: state.compactsAutomatically,
    },
  });
}

function rememberOpenCodePart(
  id: string,
  messageId: string,
  type: "text" | "reasoning",
  snapshot: string,
  state: OpenCodeEventState,
): void {
  const safeSnapshot = bounded(snapshot);
  if (safeSnapshot.length > MAX_PART_CHARS) {
    throw new Error("OpenCode sent an oversized retained message part.");
  }
  const previous = state.parts.get(id);
  if (previous && previous.messageId !== messageId) {
    throw new Error("OpenCode changed a retained part's message identity.");
  }
  if (!previous && state.parts.size >= MAX_TRACKED_PARTS) {
    throw new Error("OpenCode exceeded the bounded part budget.");
  }
  const bufferedPartChars = state.bufferedPartChars
    - (previous?.snapshot.length ?? 0)
    + safeSnapshot.length;
  assertOpenCodeRetainedBudget(state.retainedPartChars, bufferedPartChars);
  state.bufferedPartChars = bufferedPartChars;
  state.parts.set(id, { messageId, type, snapshot: safeSnapshot });
}

function replayOpenCodePart(
  partId: string,
  emittedParts: Map<string, string>,
  resultText: CappedProviderBuffer,
  emitter: AgentHarnessEmitter,
  state: OpenCodeEventState,
): void {
  const part = state.parts.get(partId);
  if (
    !part
    || !part.type
    || state.messageRoles.get(part.messageId) !== "assistant"
  ) return;
  const pending = state.pendingDeltas.get(partId) ?? "";
  const snapshot = part.snapshot;
  const next = snapshot && pending
    ? snapshot.includes(pending) ? snapshot : `${snapshot}${pending}`
    : snapshot || pending;
  state.bufferedPartChars -= snapshot.length + pending.length;
  state.pendingDeltas.delete(partId);
  state.parts.set(partId, { ...part, snapshot: "" });
  if (next) {
    appendOpenCodePartSnapshot(
      partId,
      part.type,
      next,
      emittedParts,
      resultText,
      emitter,
      state,
    );
  }
}

function appendOpenCodePartSnapshot(
  partId: string,
  type: "text" | "reasoning",
  next: string,
  emittedParts: Map<string, string>,
  resultText: CappedProviderBuffer,
  emitter: AgentHarnessEmitter,
  state: OpenCodeEventState,
): void {
  const previous = emittedParts.get(partId) ?? "";
  if (previous && !next.startsWith(previous)) return;
  const delta = next.slice(previous.length);
  trackOpenCodePart(partId, previous, next, emittedParts, state);
  emittedParts.set(partId, next);
  if (!delta) return;
  if (type === "reasoning") {
    emitter.rich({ type: "reasoning-summary", text: delta });
  } else {
    emitOpenCodeText(delta, resultText, emitter.text);
  }
}

function appendOpenCodePartText(
  partId: string,
  type: "text" | "reasoning",
  delta: string,
  emittedParts: Map<string, string>,
  resultText: CappedProviderBuffer,
  emitter: AgentHarnessEmitter,
  state: OpenCodeEventState,
): void {
  const previous = emittedParts.get(partId) ?? "";
  const next = `${previous}${delta}`;
  trackOpenCodePart(partId, previous, next, emittedParts, state);
  emittedParts.set(partId, next);
  if (type === "reasoning") {
    emitter.rich({ type: "reasoning-summary", text: delta });
  } else {
    emitOpenCodeText(delta, resultText, emitter.text);
  }
}

function assertOpenCodeRetainedBudget(
  retainedPartChars: number,
  bufferedPartChars: number,
): void {
  if (retainedPartChars < 0 || bufferedPartChars < 0) {
    throw new Error("OpenCode retained-text accounting became inconsistent.");
  }
  if (retainedPartChars + bufferedPartChars > MAX_RETAINED_PART_CHARS) {
    throw new Error("OpenCode exceeded the bounded retained-text budget.");
  }
}

function trackOpenCodePart(
  id: string,
  previous: string,
  next: string,
  parts: Map<string, string>,
  state: OpenCodeEventState,
): void {
  if (!parts.has(id) && parts.size >= MAX_TRACKED_PARTS) {
    throw new Error("OpenCode exceeded the bounded part budget.");
  }
  if (next.length > MAX_PART_CHARS) {
    throw new Error("OpenCode sent an oversized retained message part.");
  }
  const retainedPartChars = state.retainedPartChars - previous.length
    + next.length;
  assertOpenCodeRetainedBudget(retainedPartChars, state.bufferedPartChars);
  state.retainedPartChars = retainedPartChars;
}

function sumTokenParts(values: Array<number | null>): number | null {
  return values.every((value): value is number => value !== null)
    ? values.reduce((sum, value) => sum + value, 0)
    : null;
}

function emitOpenCodeText(
  value: string,
  buffer: CappedProviderBuffer,
  emit: (value: string) => void,
): void {
  const safe = bounded(value);
  buffer.append(safe);
  emit(safe);
}

function bounded(value: string): string {
  return value.slice(0, MAX_EVENT_TEXT_CHARS);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}
