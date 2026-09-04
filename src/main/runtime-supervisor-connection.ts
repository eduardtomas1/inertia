import type {
  DatabaseRecoveryStartupNotice,
  RuntimeConnection,
  RuntimeConnectionUnavailable,
} from "../shared/desktop.js";
import type { RuntimeDatabaseStartupRecoveryReport } from "../node/runtime-process-protocol.js";
import { mintDetachedRuntimeWebSocketUrl } from "../node/detached-runtime-capability.js";
import type { RuntimeSupervisorPhase } from "./runtime-supervisor-types.js";
import type { RuntimeStartupBlockerCode } from
  "../shared/runtime-startup-diagnostics.js";

interface RuntimeConnectionState {
  readonly phase: RuntimeSupervisorPhase;
  readonly generation: number;
  readonly websocketUrl: string | null;
  readonly databaseRecoveryReport: RuntimeDatabaseStartupRecoveryReport | null;
  readonly databaseRecoveryNoticePending: boolean;
  readonly startupBlockerCode: RuntimeStartupBlockerCode | null;
}

export class RuntimeConnectionUnavailableError extends Error {
  constructor(readonly connection: RuntimeConnectionUnavailable) {
    super(connection.message);
    this.name = "RuntimeConnectionUnavailableError";
  }
}

/** Projects one finite supervisor state into its typed unavailable error. */
export function runtimeConnectionUnavailableError(
  phase: RuntimeSupervisorPhase,
  startupBlockerCode: RuntimeStartupBlockerCode | null,
): RuntimeConnectionUnavailableError {
  return new RuntimeConnectionUnavailableError(unavailableRuntimeConnection({
    phase,
    startupBlockerCode,
  }));
}

export function unavailableRuntimeConnection(
  state: Pick<RuntimeConnectionState, "phase" | "startupBlockerCode">,
): RuntimeConnectionUnavailable {
  if (state.startupBlockerCode === "prior-runtime-cleanup-unconfirmed") {
    return {
      unavailable: true,
      code: state.startupBlockerCode,
      retryable: false,
      message: "Runtime startup is blocked because prior process cleanup remains unconfirmed. Review Lifecycle Integrity in Settings.",
    };
  }
  if (state.startupBlockerCode === "provider-installation-quarantined") {
    return {
      unavailable: true,
      code: state.startupBlockerCode,
      retryable: false,
      message: "Runtime startup is blocked because provider installation recovery requires manual attention. Review Lifecycle Integrity in Settings.",
    };
  }
  if (state.phase === "restarting") {
    return {
      unavailable: true,
      code: "runtime-restarting",
      retryable: true,
      message: "The local service is restarting. Try again in a moment.",
    };
  }
  if (state.phase === "idle" || state.phase === "starting") {
    return {
      unavailable: true,
      code: "runtime-starting",
      retryable: true,
      message: "The local service is starting. Try again in a moment.",
    };
  }
  if (state.phase === "stopping") {
    return {
      unavailable: true,
      code: "runtime-stopping",
      retryable: false,
      message: "The local service is stopping.",
    };
  }
  return {
    unavailable: true,
    code: "runtime-stopped",
    retryable: false,
    message: "The local service stopped. Review Lifecycle Integrity in Settings before restarting Inertia.",
  };
}

export function runtimeConnection(state: RuntimeConnectionState): {
  readonly connection: RuntimeConnection;
  readonly consumedRecoveryNotice: boolean;
} {
  if (state.phase !== "ready" || !state.websocketUrl) {
    throw new RuntimeConnectionUnavailableError(
      unavailableRuntimeConnection(state),
    );
  }
  const report = state.databaseRecoveryReport;
  let databaseRecoveryNotice: DatabaseRecoveryStartupNotice | undefined;
  if (
    state.databaseRecoveryNoticePending
    && report
    && (report.outcome === "restored" || report.outcome === "created-empty")
    && report.trigger !== "none"
  ) {
    databaseRecoveryNotice = {
      id: `runtime-${state.generation}-database-recovery`,
      outcome: report.outcome,
      trigger: report.trigger,
      preservedCorruptPrimary: report.preservedCorruptPrimary,
      preservedDatabaseFamilyMembers: report.preservedDatabaseFamilyMembers,
      invalidBackupsSkipped: report.invalidBackupsSkipped,
      unsupportedBackupsSkipped: report.unsupportedBackupsSkipped,
    };
  }
  return {
    connection: {
      websocketUrl: state.websocketUrl,
      ...(databaseRecoveryNotice ? { databaseRecoveryNotice } : {}),
    },
    consumedRecoveryNotice: databaseRecoveryNotice !== undefined,
  };
}

export function detachedRuntimeConnection(
  connection: RuntimeConnection,
  conversationId: string,
  clientId: string,
): RuntimeConnection {
  return {
    websocketUrl: mintDetachedRuntimeWebSocketUrl({
      websocketUrl: connection.websocketUrl,
      conversationId,
      clientId,
    }),
  };
}
