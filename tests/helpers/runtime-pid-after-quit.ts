export type BoundedQuitRequestResult =
  | { readonly status: "fulfilled"; readonly value: unknown }
  | { readonly status: "rejected"; readonly reason: unknown }
  | { readonly status: "timed-out" };

export interface ResolvedRuntimePid {
  /** Whether the quit response or a prior exact sample identified runtime state. */
  readonly confirmed: boolean;
  readonly pid: number | null;
}

function snapshotPid(value: unknown): ResolvedRuntimePid | null {
  if (!value || typeof value !== "object" || !("pid" in value)) return null;
  const phase = Reflect.get(value, "phase");
  if (![
    "idle",
    "starting",
    "ready",
    "restarting",
    "stopping",
    "stopped",
  ].includes(typeof phase === "string" ? phase : "")) return null;
  const pid = Reflect.get(value, "pid");
  if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0) {
    return { confirmed: true, pid };
  }
  if (pid !== null || phase !== "stopped") return null;

  // A null PID only proves absence when it belongs to the supervisor's clean,
  // terminal state. Synthetic "unavailable" values and stopped snapshots with
  // a recovery error/quarantine must fall back to an earlier exact PID sample.
  const lastError = Reflect.get(value, "lastError");
  const restartScheduled = Reflect.get(value, "restartScheduled");
  const hasQuarantinedProcesses = Reflect.get(
    value,
    "hasQuarantinedProcesses",
  );
  const quarantinedProcessCount = Reflect.get(
    value,
    "quarantinedProcessCount",
  );
  if (
    lastError !== null
    || restartScheduled !== false
    || hasQuarantinedProcesses === true
    || (typeof quarantinedProcessCount === "number"
      && quarantinedProcessCount !== 0)
  ) return null;
  return { confirmed: true, pid: null };
}

/** The live quit response supersedes an older sampled PID when available. */
export function runtimePidAfterQuit(
  request: BoundedQuitRequestResult,
  sampledPid: number | null,
): ResolvedRuntimePid {
  if (request.status === "fulfilled") {
    const current = snapshotPid(request.value);
    if (current) return current;
  }
  if (Number.isSafeInteger(sampledPid) && (sampledPid ?? 0) > 0) {
    return { confirmed: true, pid: sampledPid };
  }
  return { confirmed: false, pid: null };
}
