import type {
  RuntimeUpdatePreparationBlocker,
  RuntimeUpdatePreparationResult,
} from "../node/runtime-process-protocol.js";

interface RuntimeUpdatePreparationAuthority {
  isClosed: () => boolean;
  activeRuntimeCommands: () => number;
  databaseRecoveryActive: () => boolean;
  agentWorkActive: () => boolean;
  terminalActivity: () => boolean;
  providerMaintenanceActive: () => boolean;
  providerRefreshActive: () => boolean;
  artifactReconciliationActive: () => boolean;
  holdTerminalAdmission: () => void;
  releaseTerminalAdmission: () => void;
  drainAdditionalOperations: () => Promise<void>;
}

export class RuntimeUpdatePreparationGate {
  private operationId: string | null = null;
  private activeDatabaseRecoveryOperations = 0;
  private readonly activeRuntimeOperations = new Set<Promise<unknown>>();

  constructor(
    private readonly authority: RuntimeUpdatePreparationAuthority,
  ) {}

  isAdmissionClosed(): boolean {
    return this.operationId !== null;
  }

  track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.authority.isClosed()) {
      return Promise.reject(new Error("The runtime is shutting down."));
    }
    if (this.operationId) {
      return Promise.reject(new Error(
        "The runtime is preparing for an application update.",
      ));
    }
    const active = Promise.resolve().then(operation);
    this.activeRuntimeOperations.add(active);
    void active.then(
      () => this.activeRuntimeOperations.delete(active),
      () => this.activeRuntimeOperations.delete(active),
    );
    return active;
  }

  async drainTracked(): Promise<void> {
    while (this.activeRuntimeOperations.size > 0) {
      await Promise.allSettled(this.activeRuntimeOperations);
    }
  }

  async runDatabaseRecovery<T>(operation: () => Promise<T>): Promise<T> {
    if (this.operationId) {
      throw new Error("The runtime is preparing for an application update.");
    }
    this.activeDatabaseRecoveryOperations += 1;
    try {
      return await this.track(operation);
    } finally {
      this.activeDatabaseRecoveryOperations -= 1;
    }
  }

  async prepare(operationId: string): Promise<RuntimeUpdatePreparationResult> {
    if (this.authority.isClosed()) {
      return { ready: false, blocker: "runtime-operation" };
    }
    if (this.operationId) {
      return this.operationId === operationId
        ? { ready: true }
        : { ready: false, blocker: "runtime-operation" };
    }

    this.operationId = operationId;
    this.authority.holdTerminalAdmission();
    const immediateBlocker = this.blocker();
    if (immediateBlocker) return this.releaseBlocked(operationId, immediateBlocker);
    try {
      await this.drainTracked();
      await this.authority.drainAdditionalOperations();
    } catch {
      return this.releaseBlocked(operationId, "runtime-operation");
    }
    if (this.operationId !== operationId || this.authority.isClosed()) {
      return { ready: false, blocker: "runtime-operation" };
    }
    const finalBlocker = this.blocker();
    if (finalBlocker) return this.releaseBlocked(operationId, finalBlocker);
    if (
      this.authority.activeRuntimeCommands() > 0
      || this.activeRuntimeOperations.size > 0
      || this.authority.artifactReconciliationActive()
    ) return this.releaseBlocked(operationId, "runtime-operation");
    return { ready: true };
  }

  release(operationId: string): boolean {
    if (this.operationId !== operationId || this.authority.isClosed()) return false;
    this.operationId = null;
    this.authority.releaseTerminalAdmission();
    return true;
  }

  private blocker(): RuntimeUpdatePreparationBlocker | null {
    if (
      this.activeDatabaseRecoveryOperations > 0
      || this.authority.databaseRecoveryActive()
    ) return "database-recovery";
    if (this.authority.agentWorkActive()) return "agent-work";
    if (this.authority.terminalActivity()) return "terminal";
    if (this.authority.providerMaintenanceActive()) return "provider-maintenance";
    if (this.authority.providerRefreshActive()) return "provider-refresh";
    return null;
  }

  private releaseBlocked(
    operationId: string,
    blocker: RuntimeUpdatePreparationBlocker,
  ): { ready: false; blocker: RuntimeUpdatePreparationBlocker } {
    if (this.operationId === operationId) {
      this.operationId = null;
      this.authority.releaseTerminalAdmission();
    }
    return { ready: false, blocker };
  }
}
