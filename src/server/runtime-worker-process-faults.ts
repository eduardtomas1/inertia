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
    readonly forceExit?: () => void;
    readonly forceExitAfterMs?: number;
  },
): void {
  let forcedExit: ReturnType<typeof setTimeout> | null = null;
  const record = (code: RuntimeWorkerFaultIncidentCode): void => {
    try { options.recordIncident(code); } catch {
      return;
    }
  };
  const restart = (): void => {
    const { forceExit, forceExitAfterMs } = options;
    if (forceExit && forceExitAfterMs !== undefined && forcedExit === null) {
      forcedExit = setTimeout(forceExit, forceExitAfterMs);
      forcedExit.unref?.();
    }
    options.requestRestart();
  };
  target.on("unhandledRejection", () => {
    if (!options.started()) {
      restart();
      return;
    }
    record("runtime.unhandled-rejection");
  });
  target.on("uncaughtException", () => {
    record("runtime.uncaught-exception");
    restart();
  });
}
