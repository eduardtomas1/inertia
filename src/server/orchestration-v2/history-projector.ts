import { historyCursorSchema, type HistoryCursor, type HistoryEvent, type HistoryRollbackPlan } from "../../shared/orchestration-history";
import { OrchestrationConflict, type OrchestrationEvent, type ProjectionReader, type ProjectionWrite } from "./types";

export function rollbackWrites(envelope: OrchestrationEvent, read: ProjectionReader, rollbackId: string,
  plan: HistoryRollbackPlan, cursor: Omit<HistoryCursor, "threadId" | "rollbackId" | "retainedTurnId" | "runId" | "updatedAt">): ProjectionWrite[] {
  if ((plan.retainedTurnId && read("rolled-back-turn", plan.retainedTurnId))
    || plan.rolledBackTurnIds.some((turnId) => read("rolled-back-turn", turnId))) throw new OrchestrationConflict("revision-conflict");
  const value = historyCursorSchema.parse({ ...cursor, threadId: envelope.threadId, rollbackId,
    retainedTurnId: plan.retainedTurnId, runId: null, updatedAt: envelope.createdAt });
  return [...plan.rolledBackTurnIds.map((turnId) => ({ kind: "rolled-back-turn", id: turnId,
    value: { threadId: envelope.threadId, rollbackId } })), { kind: "history-cursor", id: envelope.threadId, value }];
}

const continuationTransitions: Record<HistoryCursor["continuationState"], readonly HistoryCursor["continuationState"][]> = {
  none: [], pending: ["attached"], attached: ["pending", "dispatched", "consumed"],
  dispatched: ["consumed", "uncertain"], consumed: [], uncertain: [],
};

export function projectHistoryEvent(event: HistoryEvent, envelope: OrchestrationEvent, read: ProjectionReader): ProjectionWrite[] {
  if (event.type === "history.rolled-back") {
    if (read("native-control", event.payload.id) || read("rolled-back", event.payload.id)) throw new OrchestrationConflict("scope-conflict");
    const current = read("native-control-current", envelope.threadId)?.value as { state: string } | undefined;
    if (current?.state === "running" || current?.state === "uncertain") throw new OrchestrationConflict("cleanup-pending");
    return [{ kind: "rolled-back", id: event.payload.id, value: { threadId: envelope.threadId } },
      ...rollbackWrites(envelope, read, event.payload.id, event.payload.plan, { transfer: "portable",
        providerInstanceId: null, workspaceKey: null, nativeConversationId: null, physicalHeadId: null,
        effectiveHeadId: null, continuation: null, continuationState: "none", reason: event.payload.reason })];
  }
  const row = read("history-cursor", envelope.threadId);
  if (!row) throw new OrchestrationConflict("scope-conflict");
  const cursor = historyCursorSchema.parse(row.value);
  const { rollbackId, runId, state } = event.payload;
  const run = read("run", runId)?.value as { threadId?: string } | undefined;
  if (cursor.rollbackId !== rollbackId || cursor.continuation === null || run?.threadId !== envelope.threadId
    || !continuationTransitions[cursor.continuationState].includes(state)
    || (cursor.runId !== null && cursor.runId !== runId)) throw new OrchestrationConflict("revision-conflict");
  return [{ kind: "history-cursor", id: envelope.threadId, value: { ...cursor, continuationState: state,
    runId: state === "pending" ? null : runId, updatedAt: envelope.createdAt } }];
}
