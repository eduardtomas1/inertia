import { forkLineageSchema } from "../../shared/orchestration-forks";
import { mergeBackSchema, type MergeBack, type MergeBackEvent } from "../../shared/orchestration-merge-back";
import { OrchestrationConflict, type OrchestrationEvent, type ProjectionReader, type ProjectionWrite } from "./types";

const transitions: Record<MergeBack["state"], readonly MergeBack["state"][]> = {
  prepared: ["attached", "withdrawn", "superseded"],
  attached: ["dispatched", "delivered", "undelivered"],
  dispatched: ["delivered", "uncertain"],
  delivered: [], undelivered: [], uncertain: [], withdrawn: [], superseded: [],
};

export function projectMergeBackEvent(event: MergeBackEvent, envelope: OrchestrationEvent, read: ProjectionReader): ProjectionWrite[] {
  if (event.type === "merge-back.prepared") {
    const merge = event.payload;
    const lineageRow = read("fork", merge.forkThreadId);
    const lineage = lineageRow ? forkLineageSchema.parse(lineageRow.value) : null;
    if (!lineage || read("merge-back", merge.id) || merge.state !== "prepared" || merge.runId !== null || merge.messageId !== null
      || merge.parentThreadId !== envelope.threadId || merge.projectId !== envelope.projectId
      || lineage.parentThreadId !== merge.parentThreadId || lineage.projectId !== merge.projectId
      || lineage.sourceTurnId !== merge.forkSourceTurnId || read("rolled-back-turn", merge.forkSourceTurnId)
      || merge.turnIds.some((turnId) => read("rolled-back-turn", turnId))) throw new OrchestrationConflict("scope-conflict");
    return [{ kind: "merge-back", id: merge.id, value: merge }];
  }
  const row = read("merge-back", event.payload.id);
  if (!row || row.threadId !== envelope.threadId) throw new OrchestrationConflict("scope-conflict");
  const merge = mergeBackSchema.parse(row.value);
  const { state, runId, messageId } = event.payload;
  const attaching = state === "attached";
  if (!transitions[merge.state].includes(state)
    || (attaching ? runId === null || messageId === null : runId !== merge.runId || messageId !== merge.messageId)
    || (attaching && (read("run", runId!)?.threadId !== envelope.threadId
      || merge.turnIds.some((turnId) => read("rolled-back-turn", turnId))))) {
    throw new OrchestrationConflict("revision-conflict");
  }
  return [{ kind: "merge-back", id: merge.id, value: { ...merge, state, runId, messageId, updatedAt: envelope.createdAt } }];
}
