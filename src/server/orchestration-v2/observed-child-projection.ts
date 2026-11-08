import type { SubagentTrace } from "../../shared/contracts";
import {
  MAX_OBSERVED_CHILD_DEPTH,
  MAX_OBSERVED_CHILD_DESCRIPTION_BYTES,
  MAX_OBSERVED_CHILD_DURATION_MS,
  MAX_OBSERVED_CHILD_IDENTIFIER_CHARS,
  MAX_OBSERVED_CHILD_LABEL_CHARS,
  MAX_OBSERVED_CHILD_PROGRESS_BYTES,
  MAX_OBSERVED_CHILD_RESULT_BYTES,
  MAX_OBSERVED_CHILD_TOOL_USE_COUNT,
  OBSERVED_CHILD_READ_ONLY_REASON,
  OBSERVED_CHILD_STATUSES,
  observedChildThreadSchema,
  type ObservedChildControl,
  type ObservedChildControlCode,
  type ObservedChildControlSet,
  type ObservedChildLineage,
  type ObservedChildThread,
  type ObservedChildUnsupportedControl,
} from "../../shared/observed-child-thread";
import { orchestrationIdSchema } from "../../shared/orchestration-identities";
import type { ProviderId } from "../../shared/provider";
import { productionProviderCapabilityManifests } from "../provider/capability-manifest";
import {
  boundedSubagentCount,
  boundedSubagentLabel,
  isTerminalSubagentStatus,
  scrubSubagentSecrets,
} from "../provider/subagent-trace";
import { validateSubagentTaskUsage } from "../provider/usage-values";
import {
  boundedUntrustedAgentText,
  neutralizeUntrustedAgentText,
} from "../runtime/untrusted-agent-text";

export interface ObservedChildActiveTurn {
  conversationId: string;
  runId: string;
  turnId: string;
}

export interface ObservedChildDerivation {
  children: ObservedChildThread[];
  controls: Record<string, ObservedChildControlSet>;
  omitted: number;
}

export type ObservedChildStopSupport = "exact-live-trace" | "unsupported";

export const OBSERVED_CHILD_STOP_MATRIX: Readonly<Record<ProviderId, ObservedChildStopSupport>> = Object.freeze({
  claude: "exact-live-trace",
  codex: "unsupported",
  opencode: "unsupported",
  cursor: "unsupported",
  kimi: "unsupported",
  antigravity: "unsupported",
  pi: "unsupported",
});

const STOP_UNSUPPORTED_REASONS: Readonly<Record<ProviderId, string>> = Object.freeze({
  claude: "This provider build does not declare individual agent stop.",
  codex: "Codex stops its agents only together with the whole turn.",
  opencode: "OpenCode does not offer individual agent stop.",
  cursor: "This provider does not offer individual agent stop.",
  kimi: "This provider does not offer individual agent stop.",
  antigravity: "This provider does not offer individual agent stop.",
  pi: "This provider does not offer individual agent stop.",
});

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const LABEL_WHITESPACE = /[\u0000-\u001f\u007f]+/gu;
const TEXT_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const KNOWN_STATUSES = new Set<string>(OBSERVED_CHILD_STATUSES);

const DECLARED_INDIVIDUAL_STOP = new Set<ProviderId>(
  productionProviderCapabilityManifests()
    .filter((manifest) => manifest.capabilities.some((capability) =>
      capability.id === "subagent-stop" && capability.support !== "unavailable"))
    .map((manifest) => manifest.providerId),
);

function unsupported(code: ObservedChildControlCode, reason: string): ObservedChildUnsupportedControl {
  return { supported: false, code, reason };
}

export function observedChildProviderStopsIndividually(providerId: ProviderId): boolean {
  return Object.hasOwn(OBSERVED_CHILD_STOP_MATRIX, providerId)
    && OBSERVED_CHILD_STOP_MATRIX[providerId] === "exact-live-trace"
    && DECLARED_INDIVIDUAL_STOP.has(providerId);
}

function nativeIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const identifier = value.trim();
  if (!identifier || CONTROL_CHARACTERS.test(identifier)) return null;
  return identifier.length <= MAX_OBSERVED_CHILD_IDENTIFIER_CHARS ? identifier : null;
}

function exactId(value: unknown): string | null {
  return orchestrationIdSchema.safeParse(value).success ? value as string : null;
}

function observedLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const flattened = value.replace(LABEL_WHITESPACE, " ").trim();
  if (!flattened) return null;
  return boundedSubagentLabel(
    neutralizeUntrustedAgentText(scrubSubagentSecrets(flattened)),
    MAX_OBSERVED_CHILD_LABEL_CHARS,
  );
}

function observedText(value: unknown, maximumBytes: number): { text: string | null; truncated: boolean } {
  if (typeof value !== "string") return { text: null, truncated: false };
  const cleaned = value.replace(TEXT_CONTROL_CHARACTERS, "").trim();
  if (!cleaned) return { text: null, truncated: false };
  const bounded = boundedUntrustedAgentText(scrubSubagentSecrets(cleaned), maximumBytes);
  const text = bounded.text.trim();
  return { text: text || null, truncated: bounded.truncated };
}

function liveTrace(trace: SubagentTrace): boolean {
  return trace.isLive === true
    && KNOWN_STATUSES.has(trace.status)
    && !isTerminalSubagentStatus(trace.status);
}

/**
 * Decides individual stop for one observed trace against the exact active
 * turn. It is evaluated on every read and every stop; nothing it returns is
 * stored, so observation never becomes a cancellation right.
 */
export function observedChildStopControl(
  trace: SubagentTrace,
  active: ObservedChildActiveTurn | null,
): ObservedChildControl {
  const providerId = trace.providerId;
  if (!Object.hasOwn(OBSERVED_CHILD_STOP_MATRIX, providerId)) {
    return unsupported("provider-unsupported", "This provider does not offer individual agent stop.");
  }
  if (!observedChildProviderStopsIndividually(providerId)) {
    return unsupported("provider-unsupported", STOP_UNSUPPORTED_REASONS[providerId]);
  }
  if (!liveTrace(trace)) {
    return unsupported("not-live", "This agent has already finished.");
  }
  if (nativeIdentifier(trace.providerTaskId) === null) {
    return unsupported("no-provider-task", "The provider has not reported a task id for this agent.");
  }
  if (!active) {
    return unsupported("no-active-turn", "This chat has no active turn.");
  }
  if (
    active.conversationId !== trace.conversationId
    || active.runId !== trace.runId
    || active.turnId !== trace.turnId
  ) {
    return unsupported("not-active-turn", "This agent belongs to a turn that is no longer active.");
  }
  return { supported: true, code: null, reason: null };
}

export function observedChildControls(
  trace: SubagentTrace,
  active: ObservedChildActiveTurn | null,
): ObservedChildControlSet {
  return {
    stop: observedChildStopControl(trace, active),
    send: { supported: false, code: "read-only", reason: OBSERVED_CHILD_READ_ONLY_REASON },
    transcript: unsupported("transcript-unavailable", "Inertia does not store provider-managed agent transcripts."),
    pin: unsupported("not-a-conversation", "Provider-managed agents are not chats and cannot be pinned."),
    snooze: unsupported("not-a-conversation", "Provider-managed agents are not chats and cannot be snoozed."),
    archive: unsupported("not-a-conversation", "Provider-managed agents are not chats and cannot be archived."),
    settle: unsupported("not-a-conversation", "Provider-managed agents are not chats and cannot be settled."),
    manage: unsupported("not-a-delegated-task", "Provider-managed agents cannot be managed or own delegated tasks."),
    wake: unsupported("not-a-delegated-task", "Provider-managed agents never continue a chat on their own."),
  };
}

function lineageOf(
  trace: SubagentTrace,
  byId: ReadonlyMap<string, SubagentTrace>,
): { depth: number; lineage: ObservedChildLineage } {
  let depth = 1;
  const visited = new Set<string>([trace.id]);
  let parentId = trace.parentTraceId;
  while (parentId !== null) {
    if (visited.has(parentId)) return { depth, lineage: "cycle" };
    const parent = byId.get(parentId);
    if (
      !parent
      || parent.conversationId !== trace.conversationId
      || parent.runId !== trace.runId
    ) return { depth, lineage: "detached" };
    if (depth >= MAX_OBSERVED_CHILD_DEPTH) return { depth, lineage: "depth-bounded" };
    depth += 1;
    visited.add(parentId);
    parentId = parent.parentTraceId;
  }
  return { depth, lineage: "complete" };
}

function strongestReference(
  taskId: string | null,
  agentId: string | null,
  toolUseId: string | null,
): ObservedChildThread["nativeRef"]["strongest"] {
  if (taskId !== null) return "task";
  if (agentId !== null) return "agent";
  return toolUseId !== null ? "tool-use" : null;
}

/**
 * Projects one persisted provider trace into a read-only observed child.
 * Returns null for a trace whose identities cannot be represented exactly.
 */
export function observedChildFromTrace(
  trace: SubagentTrace,
  byId: ReadonlyMap<string, SubagentTrace>,
  active: ObservedChildActiveTurn | null,
): ObservedChildThread | null {
  const traceId = exactId(trace.id);
  const conversationId = exactId(trace.conversationId);
  const runId = exactId(trace.runId);
  const turnId = exactId(trace.turnId);
  if (!traceId || !conversationId || !runId || !turnId) return null;
  if (!KNOWN_STATUSES.has(trace.status)) return null;
  const rawParent = trace.parentTraceId === null ? null : exactId(trace.parentTraceId);
  if (trace.parentTraceId !== null && rawParent === null) return null;
  const { depth, lineage } = rawParent === null
    ? { depth: 1, lineage: "complete" as const }
    : lineageOf({ ...trace, parentTraceId: rawParent }, byId);
  const taskId = nativeIdentifier(trace.providerTaskId);
  const agentId = nativeIdentifier(trace.providerAgentId);
  const toolUseId = nativeIdentifier(trace.providerToolUseId);
  const description = observedText(trace.description, MAX_OBSERVED_CHILD_DESCRIPTION_BYTES);
  const progress = observedText(trace.progress, MAX_OBSERVED_CHILD_PROGRESS_BYTES);
  const result = observedText(trace.result, MAX_OBSERVED_CHILD_RESULT_BYTES);
  const candidate: ObservedChildThread = {
    id: traceId,
    authority: "observed",
    transcript: "unavailable",
    parent: { conversationId, runId, turnId, parentTraceId: rawParent },
    depth,
    lineage,
    providerId: trace.providerId,
    nativeRef: {
      taskId,
      agentId,
      toolUseId,
      strongest: strongestReference(taskId, agentId, toolUseId),
    },
    role: observedLabel(trace.providerRole),
    name: observedLabel(trace.providerName),
    description: description.text,
    model: observedLabel(trace.model),
    status: trace.status,
    providerStatus: observedLabel(trace.providerStatus),
    isLive: liveTrace(trace),
    progress: progress.text,
    result: result.text,
    truncated: {
      description: description.truncated,
      progress: progress.truncated,
      result: result.truncated,
    },
    usage: validateSubagentTaskUsage(trace.usage),
    toolUseCount: boundedSubagentCount(trace.toolUseCount, MAX_OBSERVED_CHILD_TOOL_USE_COUNT),
    durationMs: boundedSubagentCount(trace.durationMs, MAX_OBSERVED_CHILD_DURATION_MS),
    controls: observedChildControls(trace, active),
    createdAt: trace.createdAt,
    updatedAt: trace.updatedAt,
  };
  const parsed = observedChildThreadSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Derives observed child threads and their controls from provider traces.
 * Observed children are not conversations: they carry no pin, snooze,
 * archive, settle, management, task or wake state.
 */
export function deriveObservedChildren(
  traces: readonly SubagentTrace[],
  active: ObservedChildActiveTurn | null,
): ObservedChildDerivation {
  const byId = new Map<string, SubagentTrace>();
  for (const trace of traces) {
    if (typeof trace.id === "string" && !byId.has(trace.id)) byId.set(trace.id, trace);
  }
  const children: ObservedChildThread[] = [];
  const seen = new Set<string>();
  let omitted = 0;
  for (const trace of traces) {
    const child = seen.has(trace.id) ? null : observedChildFromTrace(trace, byId, active);
    if (!child) {
      omitted += 1;
      continue;
    }
    seen.add(child.id);
    children.push(child);
  }
  const controls: Record<string, ObservedChildControlSet> = Object.fromEntries(
    children.map((child) => [child.id, child.controls]),
  );
  return { children, controls, omitted };
}
