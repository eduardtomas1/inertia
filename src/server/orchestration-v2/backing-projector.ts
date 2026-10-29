import {
  contextHandoffSchema, providerBackingSchema, type OrchestrationBackingEvent,
} from "../../shared/orchestration-backings";
import { orchestrationAttemptSchema, orchestrationRunSchema } from "../../shared/orchestration-v2";
import { OrchestrationConflict, type OrchestrationEvent, type ProjectionReader, type ProjectionWrite } from "./types";

export function projectBackingEvent(event: OrchestrationBackingEvent, envelope: OrchestrationEvent,
  read: ProjectionReader): ProjectionWrite[] {
  if (event.type === "provider.backing-invalidated") {
    const row = read("provider-backing", event.payload.backingId);
    if (!row || row.threadId !== envelope.threadId) throw new OrchestrationConflict("scope-conflict");
    const backing = providerBackingSchema.parse(row.value);
    return [{ kind: "provider-backing", id: backing.id,
      value: { ...backing, status: "retired", updatedAt: envelope.createdAt } }];
  }
  const run = orchestrationRunSchema.parse(read("run", event.payload.runId)?.value);
  const attempt = orchestrationAttemptSchema.parse(read("attempt", event.payload.attemptId)?.value);
  if (run.threadId !== envelope.threadId || run.projectId !== envelope.projectId
    || attempt.id !== run.attemptId || attempt.runId !== run.id) throw new OrchestrationConflict("scope-conflict");
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
      || new Set(backing.coveredItemIds).size !== backing.coveredItemIds.length) throw new OrchestrationConflict("scope-conflict");
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
    if (read("context-handoff", handoff.id) || handoff.threadId !== run.threadId
      || handoff.state !== "prepared" || new Set(handoff.itemIds).size !== handoff.itemIds.length) {
      throw new OrchestrationConflict("scope-conflict");
    }
    if (handoff.targetBackingId) {
      const backing = providerBackingSchema.parse(read("provider-backing", handoff.targetBackingId)?.value);
      if (backing.threadId !== run.threadId || backing.workspaceKey !== run.workspaceKey
        || backing.providerInstanceId !== run.providerInstanceId || backing.status !== "ready"
        || handoff.nativeSessionId !== backing.nativeSessionId) throw new OrchestrationConflict("scope-conflict");
    }
    return [{ kind: "context-handoff", id: handoff.id, value: handoff }];
  }
  const prior = contextHandoffSchema.parse(read("context-handoff", event.payload.handoffId)?.value);
  const allowed: Record<string, readonly string[]> = { prepared: ["dispatching", "abandoned"], dispatching: ["delivered", "uncertain", "abandoned"],
    delivered: [], uncertain: [], abandoned: [] };
  const { state, targetBackingId, nativeSessionId } = event.payload;
  if (prior.runId !== run.id || prior.attemptId !== attempt.id || prior.threadId !== run.threadId
    || !allowed[prior.state]!.includes(state)
    || (prior.targetBackingId !== null && prior.targetBackingId !== targetBackingId)
    || (prior.nativeSessionId !== null && prior.nativeSessionId !== nativeSessionId)) {
    throw new OrchestrationConflict("revision-conflict");
  }
  if (targetBackingId !== null) {
    const backing = providerBackingSchema.parse(read("provider-backing", targetBackingId)?.value);
    if (backing.threadId !== run.threadId || backing.providerInstanceId !== run.providerInstanceId
      || backing.nativeSessionId !== nativeSessionId) throw new OrchestrationConflict("scope-conflict");
  }
  return [{ kind: "context-handoff", id: prior.id, value: { ...prior, state, targetBackingId, nativeSessionId,
    updatedAt: envelope.createdAt } }];
}
