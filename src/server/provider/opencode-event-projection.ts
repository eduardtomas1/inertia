import { providerActivityDetailSections } from "./activity-detail";
import type { AgentHarnessEmitter } from "./agent-harness";
import { CappedProviderBuffer } from "./io";

const MAX_EVENT_TEXT_CHARS = 1024 * 1024;
const MAX_TRACKED_MESSAGES = 2_048;
const MAX_TRACKED_PARTS = 4_096;
const MAX_ACTIVITY_LABEL_CHARS = 1_024;
const MAX_PART_CHARS = 256 * 1024;
const MAX_RETAINED_PART_CHARS = 8 * 1024 * 1024;
const MAX_CANONICAL_TEXT_CHARS = 4 * 1024 * 1024;

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
  /** Null means no authoritative snapshot is waiting to be projected. */
  snapshot: string | null;
}

interface OpenCodeTrackedActivity {
  kind: "command" | "tool";
  label: string;
}

export interface OpenCodeEventState {
  retainedPartChars: number;
  bufferedPartChars: number;
  settledText: string;
  settledTextTruncated: boolean;
  messageRoles: Map<string, "assistant" | "other">;
  parts: Map<string, OpenCodeTrackedPart>;
  pendingDeltas: Map<string, string>;
  activities: Map<string, OpenCodeTrackedActivity>;
}

export function createOpenCodeEventState(): OpenCodeEventState {
  return {
    retainedPartChars: 0,
    bufferedPartChars: 0,
    settledText: "",
    settledTextTruncated: false,
    messageRoles: new Map(),
    parts: new Map(),
    pendingDeltas: new Map(),
    activities: new Map(),
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
    rememberOpenCodePart(
      id,
      messageId,
      part.type,
      part.text,
      eventState,
      true,
    );
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
    state.parts.set(partId, { messageId, type: null, snapshot: null });
  }
  const tracked = state.parts.get(partId)!;
  if (tracked.type && state.messageRoles.get(messageId) === "assistant") {
    if (tracked.snapshot !== null || state.pendingDeltas.has(partId)) {
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
    true,
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
  state: OpenCodeEventState,
): void {
  const callId = stringValue(properties.callID);
  const shell = eventType.startsWith("session.next.shell.");
  const phase = eventType.endsWith(".ended")
    || eventType.endsWith(".success")
    ? "completed"
    : eventType.endsWith(".failed")
      ? "failed"
      : "started";
  const explicitLabel = (shell
    ? stringValue(properties.command)
    : stringValue(properties.tool))?.slice(0, MAX_ACTIVITY_LABEL_CHARS);
  const kind = shell ? "command" : "tool";
  const retained = callId ? state.activities.get(callId) : undefined;
  if (
    callId
    && explicitLabel
    && retained
    && (retained.kind !== kind || retained.label !== explicitLabel)
  ) {
    throw new Error("OpenCode changed a retained tool activity's identity.");
  }
  if (callId && explicitLabel && !retained) {
    if (state.activities.size >= MAX_TRACKED_PARTS) {
      throw new Error("OpenCode exceeded the bounded tool-activity budget.");
    }
    state.activities.set(callId, { kind, label: explicitLabel });
  }
  const label = explicitLabel
    ?? retained?.label
    ?? (shell ? "OpenCode shell" : "OpenCode tool");
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
  emitter.activity(kind, phase, bounded(label), {
    ...(callId ? { activityId: callId } : {}),
    ...(detail ? { detail } : {}),
  });
  if (
    callId
    && (
      eventType.endsWith(".ended")
      || eventType.endsWith(".success")
      || eventType.endsWith(".failed")
    )
  ) state.activities.delete(callId);
}

export function removeOpenCodeMessage(
  messageId: string,
  emittedParts: Map<string, string>,
  state: OpenCodeEventState,
  emitter?: AgentHarnessEmitter,
): void {
  let corrected = false;
  state.messageRoles.delete(messageId);
  for (const [partId, part] of state.parts) {
    if (part.messageId === messageId) {
      corrected = removeOpenCodePartState(partId, emittedParts, state)
        || corrected;
    }
  }
  if (corrected && emitter) {
    emitter.textSnapshot(messageId, openCodeCanonicalResult(
      emittedParts,
      state,
    ).text);
  }
}

export function removeOpenCodePart(
  partId: string,
  emittedParts: Map<string, string>,
  state: OpenCodeEventState,
  emitter?: AgentHarnessEmitter,
): void {
  const corrected = removeOpenCodePartState(partId, emittedParts, state);
  if (corrected && emitter) {
    emitter.textSnapshot(partId, openCodeCanonicalResult(
      emittedParts,
      state,
    ).text);
  }
}

function removeOpenCodePartState(
  partId: string,
  emittedParts: Map<string, string>,
  state: OpenCodeEventState,
): boolean {
  const part = state.parts.get(partId);
  const pending = state.pendingDeltas.get(partId) ?? "";
  const emitted = emittedParts.get(partId) ?? "";
  state.bufferedPartChars -= (part?.snapshot?.length ?? 0) + pending.length;
  state.retainedPartChars -= emitted.length;
  state.parts.delete(partId);
  state.pendingDeltas.delete(partId);
  emittedParts.delete(partId);
  assertOpenCodeRetainedBudget(
    state.retainedPartChars,
    state.bufferedPartChars,
  );
  return part?.type === "text" && emitted.length > 0;
}

/**
 * Folds finalized assistant output into one bounded prefix and releases all
 * prompt-scoped correlation state. This makes limits concurrency bounds, not
 * lifetime limits for long sessions with many sequential prompts.
 */
export function settleOpenCodePromptOutput(
  promptId: string,
  assistantIds: readonly string[],
  emittedParts: Map<string, string>,
  state: OpenCodeEventState,
  usageState?: OpenCodeUsageState,
): void {
  const assistants = new Set(assistantIds);
  for (const [partId, part] of state.parts) {
    if (!assistants.has(part.messageId)) continue;
    const emitted = emittedParts.get(partId) ?? "";
    if (part.type === "text" && emitted) appendSettledText(emitted, state);
    removeOpenCodePartState(partId, emittedParts, state);
  }
  for (const assistantId of assistants) {
    state.messageRoles.delete(assistantId);
    usageState?.messages.delete(assistantId);
  }
  state.messageRoles.delete(promptId);
  // An idle boundary finalizes any provider activity that never received a
  // terminal notification, allowing later calls to reuse bounded storage.
  state.activities.clear();
}

export function openCodeCanonicalResult(
  emittedParts: ReadonlyMap<string, string>,
  state: OpenCodeEventState,
): { text: string; truncated: boolean } {
  let text = state.settledText;
  let truncated = state.settledTextTruncated;
  for (const [partId, part] of state.parts) {
    if (part.type !== "text") continue;
    const value = emittedParts.get(partId) ?? "";
    const available = MAX_CANONICAL_TEXT_CHARS - text.length;
    if (value.length > available) truncated = true;
    if (available > 0) text += value.slice(0, available);
  }
  return { text, truncated };
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
  authoritative = false,
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
  const pending = authoritative
    ? state.pendingDeltas.get(id) ?? ""
    : "";
  const bufferedPartChars = state.bufferedPartChars
    - (previous?.snapshot?.length ?? 0)
    - pending.length
    + safeSnapshot.length;
  assertOpenCodeRetainedBudget(state.retainedPartChars, bufferedPartChars);
  state.bufferedPartChars = bufferedPartChars;
  if (authoritative) state.pendingDeltas.delete(id);
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
  const snapshot = part.snapshot ?? "";
  // Pending deltas here necessarily arrived after the retained snapshot.
  // Authoritative snapshots discard older queued deltas in
  // rememberOpenCodePart, so concatenation follows transport order instead of
  // guessing based on repeated text content.
  const next = `${snapshot}${pending}`;
  state.bufferedPartChars -= snapshot.length + pending.length;
  state.pendingDeltas.delete(partId);
  const hadAuthoritativeSnapshot = part.snapshot !== null;
  state.parts.set(partId, { ...part, snapshot: null });
  if (next || hadAuthoritativeSnapshot) {
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
  const extendsPrevious = next.startsWith(previous);
  const delta = extendsPrevious ? next.slice(previous.length) : "";
  trackOpenCodePart(partId, previous, next, emittedParts, state);
  emittedParts.set(partId, next);
  if (!extendsPrevious) {
    if (type === "text") {
      emitter.textSnapshot(
        partId,
        openCodeCanonicalResult(emittedParts, state).text,
      );
    }
    return;
  }
  if (!delta) return;
  if (type === "reasoning") {
    emitter.rich({ type: "reasoning-summary", text: delta });
  } else {
    emitOpenCodeText(delta, partId, resultText, emitter.text);
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
    emitOpenCodeText(delta, partId, resultText, emitter.text);
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
  itemId: string,
  buffer: CappedProviderBuffer,
  emit: (value: string, itemId?: string) => void,
): void {
  const safe = bounded(value);
  buffer.append(safe);
  emit(safe, itemId);
}

function appendSettledText(
  value: string,
  state: OpenCodeEventState,
): void {
  const available = MAX_CANONICAL_TEXT_CHARS - state.settledText.length;
  if (value.length > available) state.settledTextTruncated = true;
  if (available > 0) state.settledText += value.slice(0, available);
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
