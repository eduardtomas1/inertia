import { RuntimeGenerationLeaseJournal } from "../node/runtime-generation-leases.js";
import { RuntimeOwnedProcessJournal } from "../node/runtime-owned-processes.js";
import { RuntimeCleanupReceiptJournal } from "./runtime-cleanup-receipts.js";
import type { RuntimeProcessRecord } from "./runtime-supervisor-types.js";

export function persistRuntimeGenerationCleanup(
  record: RuntimeProcessRecord,
  receipts: RuntimeCleanupReceiptJournal,
  leases: RuntimeGenerationLeaseJournal,
  ownedProcesses?: RuntimeOwnedProcessJournal,
): boolean {
  if (record.generationCleanupConfirmed) return true;
  const runtimeGenerationId = record.runtimeGenerationId;
  if (ownedProcesses) {
    if (receipts.has(runtimeGenerationId)) {
      const session = ownedProcesses.sessionExact(runtimeGenerationId);
      if (
        session === undefined
        || (session && !ownedProcesses.finishSessionExact(session))
      ) return false;
    } else if (!ownedProcesses.finishSession(
      runtimeGenerationId,
      () => receipts.publish(runtimeGenerationId),
    )) return false;
  } else if (
    !receipts.has(runtimeGenerationId)
    && !receipts.publish(runtimeGenerationId)
  ) return false;
  leases.refresh();
  if (!leases.clearRuntimeGeneration(runtimeGenerationId)) return false;
  record.generationCleanupConfirmed = true;
  return true;
}
