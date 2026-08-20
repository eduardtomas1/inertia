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
  if (ownedProcesses && !ownedProcesses.finishSession(
    record.runtimeGenerationId,
  )) return false;
  if (!receipts.publish(record.runtimeGenerationId)) return false;
  leases.refresh();
  if (!leases.clearRuntimeGeneration(record.runtimeGenerationId)) return false;
  record.generationCleanupConfirmed = true;
  return true;
}
