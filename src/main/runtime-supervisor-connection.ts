import type {
  DatabaseRecoveryStartupNotice,
  RuntimeConnection,
} from "../shared/desktop.js";
import type { RuntimeDatabaseStartupRecoveryReport } from "../node/runtime-process-protocol.js";
import { mintDetachedRuntimeWebSocketUrl } from "../node/detached-runtime-capability.js";
import type { RuntimeSupervisorPhase } from "./runtime-supervisor-types.js";

interface RuntimeConnectionState {
  readonly phase: RuntimeSupervisorPhase;
  readonly generation: number;
  readonly websocketUrl: string | null;
  readonly databaseRecoveryReport: RuntimeDatabaseStartupRecoveryReport | null;
  readonly databaseRecoveryNoticePending: boolean;
  readonly lastError: string | null;
}

export function runtimeConnection(state: RuntimeConnectionState): {
  readonly connection: RuntimeConnection;
  readonly consumedRecoveryNotice: boolean;
} {
  if (state.phase !== "ready" || !state.websocketUrl) {
    if (state.lastError) {
      throw new Error(`The local service is restarting. ${state.lastError}`);
    }
    throw new Error("The local service is starting. Try again in a moment.");
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
