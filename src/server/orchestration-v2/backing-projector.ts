import {
  contextHandoffSchema, providerBackingSchema,
  type InheritedCoverage, type OrchestrationBackingEvent, type ProviderBacking,
} from "../../shared/orchestration-backings";
import {
  orchestrationAttemptSchema, orchestrationRunSchema, type OrchestrationAttempt, type OrchestrationRun,
} from "../../shared/orchestration-v2";
import { nativeControlSchema } from "../../shared/orchestration-native-control";
import { isAgentTurnTerminalStatus } from "../../shared/turn-lifecycle";
import { commandFingerprint } from "./json";
import { OrchestrationConflict, type OrchestrationEvent, type ProjectionReader, type ProjectionWrite } from "./types";

/**
 * Lookup rows the projector reads back (projection version 3): `backing-session` names the live backing of a native
 * session in one chat, provider instance and checkout; `attempt-handoff` names the handoff prepared for an attempt.
 * They let `provider.backing-forked` be checked from projections alone.
 */
const BACKING_SESSION = "backing-session";
const ATTEMPT_HANDOFF = "attempt-handoff";

function backingSessionKey(backing: Pick<ProviderBacking, "threadId" | "providerInstanceId" | "workspaceKey" | "nativeSessionId">): string {
  return commandFingerprint({ threadId: backing.threadId, instanceId: backing.providerInstanceId,
    workspaceKey: backing.workspaceKey, nativeSessionId: backing.nativeSessionId });
}

/** The live backing of `nativeSessionId` in the scope of `scope`, if the lookup row names one that still holds it. */
function liveSessionBacking(read: ProjectionReader, scope: ProviderBacking, nativeSessionId: string): ProviderBacking | null {
  const key = read(BACKING_SESSION, backingSessionKey({ ...scope, nativeSessionId }))?.value as { backingId?: unknown } | undefined;
  const row = typeof key?.backingId === "string" ? read("provider-backing", key.backingId) : null;
  const backing = row ? providerBackingSchema.parse(row.value) : null;
  return backing && backing.status !== "retired" && backing.threadId === scope.threadId && backing.nativeSessionId === nativeSessionId
    && backing.providerInstanceId === scope.providerInstanceId && backing.workspaceKey === scope.workspaceKey ? backing : null;
}

export function projectBackingEvent(event: OrchestrationBackingEvent, envelope: OrchestrationEvent,
  read: ProjectionReader): ProjectionWrite[] {
  const writes = projectBackingWrites(event, envelope, read);
  const lookups: ProjectionWrite[] = [];
  for (const write of writes) {
    if (write.kind === "provider-backing") {
      const backing = providerBackingSchema.parse(write.value);
      if (backing.status !== "retired") lookups.push({ kind: BACKING_SESSION, id: backingSessionKey(backing), value: { backingId: backing.id } });
    } else if (write.kind === "context-handoff" && event.type === "context.handoff-prepared") {
      const handoff = contextHandoffSchema.parse(write.value);
      lookups.push({ kind: ATTEMPT_HANDOFF, id: handoff.attemptId, value: { handoffId: handoff.id } });
    }
  }
  return [...writes, ...lookups];
}

function validCoverageLists(coveredItemIds: readonly string[], uncoveredItemIds: readonly string[] | undefined): boolean {
  const covered = new Set(coveredItemIds);
  if (covered.size !== coveredItemIds.length) return false;
  if (!uncoveredItemIds || uncoveredItemIds.length === 0) return true;
  const uncovered = new Set(uncoveredItemIds);
  if (uncovered.size !== uncoveredItemIds.length) return false;
  for (const item of uncovered) {
    if (covered.has(item)) return false;
  }
  return true;
}

function validRewoundInheritedCoverage(
  prior: InheritedCoverage | undefined,
  next: InheritedCoverage | undefined,
): boolean {
  if (next === undefined) return true;
  if (prior === undefined) return false;
  if (next === "complete") return prior === "complete";
  if (prior === "complete") return true;
  return next.forkId === prior.forkId && next.throughOrdinal <= prior.throughOrdinal;
}

function projectBackingWrites(event: OrchestrationBackingEvent, envelope: OrchestrationEvent,
  read: ProjectionReader): ProjectionWrite[] {
  if (event.type === "provider.backing-invalidated") {
    const row = read("provider-backing", event.payload.backingId);
    if (!row || row.threadId !== envelope.threadId) throw new OrchestrationConflict("scope-conflict");
    const backing = providerBackingSchema.parse(row.value);
    return [{ kind: "provider-backing", id: backing.id,
      value: { ...backing, status: "retired", updatedAt: envelope.createdAt } }];
  }
  if (event.type === "provider.backing-rewound") return rewound(event.payload, envelope, read);
  if (event.type === "provider.backing-restored") {
    const { backing: restored, runId } = event.payload;
    const row = read("provider-backing", restored.id);
    if (!row || row.threadId !== envelope.threadId) throw new OrchestrationConflict("scope-conflict");
    if (!validCoverageLists(restored.coveredItemIds, restored.uncoveredItemIds)) {
      throw new OrchestrationConflict("scope-conflict");
    }
    const current = providerBackingSchema.parse(row.value);
    if (current.status === "retired" || restored.status === "retired" || current.lastRunId !== runId
      || restored.lastRunId === runId || restored.threadId !== current.threadId || restored.projectId !== current.projectId
      || restored.providerInstanceId !== current.providerInstanceId || restored.workspaceKey !== current.workspaceKey
      || restored.nativeSessionId !== current.nativeSessionId || restored.createdAt !== current.createdAt) {
      throw new OrchestrationConflict("revision-conflict");
    }
    return [{ kind: "provider-backing", id: restored.id, value: { ...restored, updatedAt: envelope.createdAt } }];
  }
  const run = orchestrationRunSchema.parse(read("run", event.payload.runId)?.value);
  const attempt = orchestrationAttemptSchema.parse(read("attempt", event.payload.attemptId)?.value);
  if (run.threadId !== envelope.threadId || run.projectId !== envelope.projectId
    || attempt.id !== run.attemptId || attempt.runId !== run.id) throw new OrchestrationConflict("scope-conflict");
  if (event.type === "provider.backing-relocated") return relocated(event.payload, envelope, read, run, attempt);
  if (event.type === "provider.backing-forked") return forked(event.payload, envelope, read, run, attempt);
  if (event.type === "provider.session-cleared") {
    if (attempt.nativeSessionId !== event.payload.expectedNativeSessionId) throw new OrchestrationConflict("revision-conflict");
    return [{ kind: "attempt", id: attempt.id, value: { ...attempt, nativeSessionId: null,
      nativeThreadId: null, nativeTurnId: null } }];
  }
  if (event.type === "provider.backing-recorded") {
    const backing = event.payload.backing;
    const prior = read("provider-backing", backing.id);
    if (backing.threadId !== run.threadId || backing.projectId !== run.projectId
      || backing.providerInstanceId !== run.providerInstanceId || backing.workspaceKey !== run.workspaceKey
      || backing.providerId !== run.providerId || backing.lastRunId !== run.id || backing.lastTurnId !== run.turnId
      || !validCoverageLists(backing.coveredItemIds, backing.uncoveredItemIds)) throw new OrchestrationConflict("scope-conflict");
    if (prior) {
      const before = providerBackingSchema.parse(prior.value);
      if (before.nativeSessionId !== backing.nativeSessionId || before.createdAt !== backing.createdAt
        || before.workspaceKey !== backing.workspaceKey || before.providerInstanceId !== backing.providerInstanceId
        || before.status === "retired") throw new OrchestrationConflict("revision-conflict");
    }
    return [
      { kind: "provider-backing", id: backing.id, value: backing },
      { kind: "attempt", id: attempt.id, value: { ...attempt, nativeSessionId: backing.nativeSessionId } },
    ];
  }
  if (event.type === "context.handoff-prepared") {
    const handoff = event.payload;
    const offered = [...handoff.itemIds, ...handoff.omittedItemIds ?? []];
    if (read("context-handoff", handoff.id) || handoff.threadId !== run.threadId
      || handoff.state !== "prepared" || new Set(offered).size !== offered.length) {
      throw new OrchestrationConflict("scope-conflict");
    }
    if (handoff.targetBackingId) {
      const target = read("provider-backing", handoff.targetBackingId);
      if (!target) throw new OrchestrationConflict("scope-conflict");
      const backing = providerBackingSchema.parse(target.value);
      if (backing.threadId !== run.threadId || backing.workspaceKey !== run.workspaceKey
        || backing.providerInstanceId !== run.providerInstanceId || backing.status !== "ready"
        || handoff.nativeSessionId !== backing.nativeSessionId) throw new OrchestrationConflict("scope-conflict");
    }
    return [{ kind: "context-handoff", id: handoff.id, value: handoff }];
  }
  const prior = contextHandoffSchema.parse(read("context-handoff", event.payload.handoffId)?.value);
  // An inline handoff delivered by output goes back only when its run's provider dropped the prompt that carried it
  // (T3 `promptDropped`): the run's status change, recorded first, says so.
  const droppedInline = prior.method === "inline" && run.delivery !== undefined && run.promptDropped === true;
  const allowed: Record<string, readonly string[]> = { prepared: ["dispatching", "abandoned"], dispatching: ["delivered", "uncertain", "abandoned"],
    delivered: droppedInline ? ["abandoned"] : [], uncertain: [], abandoned: [] };
  const { state, targetBackingId, nativeSessionId } = event.payload;
  // An event without a method keeps the handoff's (every event before native injection). A method changes only
  // while dispatching, and staying in `dispatching` is allowed only to change it.
  const method = event.payload.method ?? prior.method;
  const methodChange = prior.state === "dispatching" && state === "dispatching" && method !== prior.method;
  if (prior.runId !== run.id || prior.attemptId !== attempt.id || prior.threadId !== run.threadId
    || (!allowed[prior.state]!.includes(state) && !methodChange)
    || (method !== prior.method && !methodChange)
    || (prior.targetBackingId !== null && prior.targetBackingId !== targetBackingId)
    || (prior.nativeSessionId !== null && prior.nativeSessionId !== nativeSessionId)) {
    throw new OrchestrationConflict("revision-conflict");
  }
  if (targetBackingId !== null) {
    const backing = providerBackingSchema.parse(read("provider-backing", targetBackingId)?.value);
    if (backing.threadId !== run.threadId || backing.providerInstanceId !== run.providerInstanceId
      || backing.nativeSessionId !== nativeSessionId) throw new OrchestrationConflict("scope-conflict");
  }
  return [{ kind: "context-handoff", id: prior.id, value: { ...prior, state, method, targetBackingId, nativeSessionId,
    updatedAt: envelope.createdAt } }];
}

/** The backing id of a native session relocated into `workspaceKey`; never the id of an earlier row. */
export function relocatedBackingId(source: ProviderBacking, workspaceKey: string): string {
  return commandFingerprint({ threadId: source.threadId, instanceId: source.providerInstanceId, workspaceKey,
    nativeSessionId: source.nativeSessionId, fromBackingId: source.id });
}

function relocated(payload: Extract<OrchestrationBackingEvent, { type: "provider.backing-relocated" }>["payload"],
  envelope: OrchestrationEvent, read: ProjectionReader, run: OrchestrationRun, attempt: OrchestrationAttempt): ProjectionWrite[] {
  const row = read("provider-backing", payload.fromBackingId);
  if (!row || row.threadId !== envelope.threadId) throw new OrchestrationConflict("scope-conflict");
  const source = providerBackingSchema.parse(row.value);
  if (source.providerInstanceId !== run.providerInstanceId || source.projectId !== run.projectId
    || payload.workspaceKey !== run.workspaceKey || source.workspaceKey === payload.workspaceKey
    || attempt.nativeSessionId !== source.nativeSessionId
    || payload.backingId !== relocatedBackingId(source, payload.workspaceKey)) throw new OrchestrationConflict("scope-conflict");
  if (source.status !== "ready" || !source.coverageComplete || read("provider-backing", payload.backingId)) {
    throw new OrchestrationConflict("revision-conflict");
  }
  return [{ kind: "provider-backing", id: source.id, value: { ...source, status: "retired", updatedAt: envelope.createdAt } },
    { kind: "provider-backing", id: payload.backingId, value: providerBackingSchema.parse({ ...source, id: payload.backingId,
      workspaceKey: payload.workspaceKey, createdAt: envelope.createdAt, updatedAt: envelope.createdAt }) }];
}

function forked(payload: Extract<OrchestrationBackingEvent, { type: "provider.backing-forked" }>["payload"],
  envelope: OrchestrationEvent, read: ProjectionReader, run: OrchestrationRun, attempt: OrchestrationAttempt): ProjectionWrite[] {
  const row = read("provider-backing", payload.backingId);
  if (!row || row.threadId !== envelope.threadId) throw new OrchestrationConflict("scope-conflict");
  const source = providerBackingSchema.parse(row.value);
  if (source.providerInstanceId !== run.providerInstanceId || source.projectId !== run.projectId
    || source.workspaceKey !== run.workspaceKey || source.lastRunId !== run.id
    || source.nativeSessionId !== payload.fromNativeSessionId || attempt.nativeSessionId !== payload.fromNativeSessionId
    || payload.nativeSessionId === payload.fromNativeSessionId) throw new OrchestrationConflict("scope-conflict");
  // Only while the run is live, never onto a session another live backing of this scope already holds, and the
  // run's handoff for this backing must move with it.
  if (source.status === "retired" || isAgentTurnTerminalStatus(run.status)
    || liveSessionBacking(read, source, payload.nativeSessionId)) throw new OrchestrationConflict("revision-conflict");
  const indexed = read(ATTEMPT_HANDOFF, attempt.id)?.value as { handoffId?: unknown } | undefined;
  const current = typeof indexed?.handoffId === "string" ? read("context-handoff", indexed.handoffId) : null;
  const active = current ? contextHandoffSchema.parse(current.value) : null;
  const expected = active && active.targetBackingId === source.id && (active.state === "prepared" || active.state === "dispatching")
    ? active.id : null;
  if (payload.handoffId !== expected) throw new OrchestrationConflict("scope-conflict");
  const writes: ProjectionWrite[] = [
    { kind: "provider-backing", id: source.id, value: { ...source, nativeSessionId: payload.nativeSessionId, updatedAt: envelope.createdAt } },
    { kind: "attempt", id: attempt.id, value: { ...attempt, nativeSessionId: payload.nativeSessionId } },
  ];
  if (payload.handoffId !== null) {
    const handoff = contextHandoffSchema.parse(read("context-handoff", payload.handoffId)?.value);
    if (handoff.runId !== run.id || handoff.attemptId !== attempt.id || handoff.targetBackingId !== source.id
      || handoff.nativeSessionId !== payload.fromNativeSessionId || !["prepared", "dispatching"].includes(handoff.state)) {
      throw new OrchestrationConflict("scope-conflict");
    }
    writes.push({ kind: "context-handoff", id: handoff.id, value: { ...handoff, nativeSessionId: payload.nativeSessionId,
      updatedAt: envelope.createdAt } });
  }
  return writes;
}

function rewound(payload: Extract<OrchestrationBackingEvent, { type: "provider.backing-rewound" }>["payload"],
  envelope: OrchestrationEvent, read: ProjectionReader): ProjectionWrite[] {
  const controlRow = read("native-control", payload.rollbackId);
  const row = read("provider-backing", payload.backingId);
  if (!controlRow || !row || controlRow.threadId !== envelope.threadId || row.threadId !== envelope.threadId) {
    throw new OrchestrationConflict("scope-conflict");
  }
  const control = nativeControlSchema.parse(controlRow.value);
  const prior = providerBackingSchema.parse(row.value);
  const covered = new Set(prior.coveredItemIds);
  const watermarkLowered = prior.coveredThroughOrdinal !== undefined
    && payload.coveredThroughOrdinal !== undefined
    && payload.coveredThroughOrdinal < prior.coveredThroughOrdinal;
  const watermarkInvalid = payload.coveredThroughOrdinal !== undefined
    && (prior.coveredThroughOrdinal === undefined
      ? payload.coveredThroughOrdinal > 0
      : payload.coveredThroughOrdinal > prior.coveredThroughOrdinal);
  if (control.request.kind !== "rollback" || control.state !== "completed" || prior.status !== "ready"
    || prior.providerInstanceId !== control.request.source.identity.providerInstanceId
    || prior.workspaceKey !== control.sourceWorkspaceKey
    || prior.nativeSessionId !== control.request.source.nativeConversationId
    || payload.nativeSessionId !== control.backing?.nativeConversationId
    || !validCoverageLists(payload.coveredItemIds, payload.uncoveredItemIds)
    || watermarkInvalid
    || (!watermarkLowered && payload.coveredItemIds.some((item) => !covered.has(item)))
    || (payload.legacyCovered === true && prior.legacyCovered !== true)
    || !validRewoundInheritedCoverage(prior.inheritedCoverage, payload.inheritedCoverage)
    || (payload.coverageComplete && !prior.coverageComplete)) throw new OrchestrationConflict("scope-conflict");
  const {
    coveredThroughOrdinal: _priorOrdinal,
    uncoveredItemIds: _priorUncovered,
    inheritedCoverage: _priorInherited,
    legacyCovered: _priorLegacy,
    ...priorBase
  } = prior;
  const coverage = {
    coveredItemIds: payload.coveredItemIds,
    coverageComplete: payload.coverageComplete,
    ...(payload.coveredThroughOrdinal !== undefined ? { coveredThroughOrdinal: payload.coveredThroughOrdinal } : {}),
    ...(payload.uncoveredItemIds !== undefined ? { uncoveredItemIds: payload.uncoveredItemIds } : {}),
    ...(payload.inheritedCoverage !== undefined ? { inheritedCoverage: payload.inheritedCoverage } : {}),
    ...(payload.legacyCovered !== undefined ? { legacyCovered: payload.legacyCovered } : {}),
    updatedAt: envelope.createdAt,
  };
  if (payload.nativeSessionId === prior.nativeSessionId) {
    return [{ kind: "provider-backing", id: prior.id, value: providerBackingSchema.parse({ ...priorBase, ...coverage, status: "ready" }) }];
  }
  const id = commandFingerprint({ threadId: prior.threadId, instanceId: prior.providerInstanceId,
    workspaceKey: prior.workspaceKey, nativeSessionId: payload.nativeSessionId });
  if (read("provider-backing", id)) throw new OrchestrationConflict("revision-conflict");
  return [{ kind: "provider-backing", id: prior.id, value: { ...prior, status: "retired", updatedAt: envelope.createdAt } },
    { kind: "provider-backing", id, value: providerBackingSchema.parse({ ...priorBase, ...coverage, id,
      nativeSessionId: payload.nativeSessionId, status: "ready", createdAt: envelope.createdAt }) }];
}
