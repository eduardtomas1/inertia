import type { RuntimeOwnedProcessFaultKind } from "../node/runtime-owned-process-diagnostic.js";

export type RuntimeWorkerFaultIncidentCode =
  | "runtime.unhandled-rejection"
  | "runtime.uncaught-exception";

export type RuntimeOwnedProcessFaultIncidentCode =
  | "runtime.process-start-rejected"
  | "runtime.process-quarantined"
  | "runtime.root-process-running";

const OWNED_PROCESS_FAULT_INCIDENT_CODES = {
  "admission-rejected": "runtime.process-start-rejected",
  quarantined: "runtime.process-quarantined",
  "root-descendant": "runtime.root-process-running",
} as const satisfies Record<RuntimeOwnedProcessFaultKind, RuntimeOwnedProcessFaultIncidentCode>;

export function runtimeOwnedProcessFaultIncidentCode(
  kind: RuntimeOwnedProcessFaultKind,
): RuntimeOwnedProcessFaultIncidentCode {
  return OWNED_PROCESS_FAULT_INCIDENT_CODES[kind];
}

interface RuntimeWorkerFaultTarget {
  on(event: "unhandledRejection" | "uncaughtException", listener: () => void): unknown;
}

export function installRuntimeWorkerFaultHandlers(
  target: RuntimeWorkerFaultTarget,
  options: {
    readonly started: () => boolean;
    readonly recordIncident: (code: RuntimeWorkerFaultIncidentCode) => void;
    readonly requestRestart: () => void;
  },
): void {
  const record = (code: RuntimeWorkerFaultIncidentCode): void => {
    try { options.recordIncident(code); } catch {
      return;
    }
  };
  target.on("unhandledRejection", () => {
    if (!options.started()) {
      options.requestRestart();
      return;
    }
    record("runtime.unhandled-rejection");
  });
  target.on("uncaughtException", () => {
    record("runtime.uncaught-exception");
    options.requestRestart();
  });
}
