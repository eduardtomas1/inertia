import type { PrivateConnectRuntimeResponse } from "../../shared/private-connect/runtime-contract";
import { DATABASE_VACUUM_REFUSAL } from "./database-write-gate";

export interface PrivateConnectAdmissionState {
  updatePreparing(): boolean;
  safetyLocked(): boolean;
  safetyError(message: string): string;
  recoveryActive(): boolean;
  databaseVacuuming(): boolean;
}

export function privateConnectRefusal(
  state: PrivateConnectAdmissionState,
  requestId: string,
): PrivateConnectRuntimeResponse | null {
  const message = state.updatePreparing()
    ? "The runtime is preparing for an application update."
    : state.safetyLocked()
      ? state.safetyError("Private Connect changes are unavailable in recovery safety mode.")
      : state.recoveryActive()
        ? "Database recovery is in progress."
        : state.databaseVacuuming()
          ? DATABASE_VACUUM_REFUSAL
          : null;
  return message === null
    ? null
    : { type: "response", requestId, ok: false, code: "unavailable", message };
}
