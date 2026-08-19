import { RuntimeGenerationLeaseJournal } from "../node/runtime-generation-leases.js";
import { RuntimeCleanupReceiptJournal } from "./runtime-cleanup-receipts.js";
import { recoverPriorRuntimeGenerations } from "./runtime-owned-process-recovery.js";

export class RuntimeSupervisorStartupRecovery {
  private active: Promise<boolean> | null = null;

  constructor(private readonly options: {
    dataDirectory: string;
    systemBootId: string;
    forceKillWaitMs: number;
    leases: RuntimeGenerationLeaseJournal;
    receipts: RuntimeCleanupReceiptJournal;
  }) {}

  begin(onFinished: () => void): Promise<boolean> | null {
    if (this.active) return this.active;
    const recovery = recoverPriorRuntimeGenerations({
      ...this.options,
      deadlineAt: Date.now() + this.options.forceKillWaitMs * 2,
    });
    if (!recovery) return null;
    const active = recovery.catch(() => false);
    this.active = active;
    void active.then(() => {
      if (this.active !== active) return;
      this.active = null;
      onFinished();
    });
    return active;
  }

  activePromise(): Promise<boolean> | null {
    return this.active;
  }
}
