import type {
  RuntimeLifecycleDiagnosticSnapshot,
} from "./lifecycle-diagnostics";

export const APP_UPDATE_PREPARATION_BLOCKERS = [
  "active-work",
  "terminal",
  "maintenance",
  "database-recovery",
  "local-operation",
  "runtime-transition",
  "private-connect",
  "shutdown",
] as const;

export type AppUpdatePreparationBlocker =
  (typeof APP_UPDATE_PREPARATION_BLOCKERS)[number];

export type AppUpdatePreparationDiagnostic = Readonly<
  | { phase: "inactive" | "preparing"; blocker: null }
  | { phase: "blocked"; blocker: AppUpdatePreparationBlocker }
>;

export function isAppUpdatePreparationDiagnostic(
  value: unknown,
): value is AppUpdatePreparationDiagnostic {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2
    || !Object.hasOwn(record, "phase")
    || !Object.hasOwn(record, "blocker")
  ) return false;
  if (record.phase === "inactive" || record.phase === "preparing") {
    return record.blocker === null;
  }
  return record.phase === "blocked"
    && typeof record.blocker === "string"
    && APP_UPDATE_PREPARATION_BLOCKERS.includes(
      record.blocker as AppUpdatePreparationBlocker,
    );
}

/**
 * Main- and renderer-safe projection of update preparation. It deliberately
 * retains only fixed state and blocker codes from the privileged updater.
 */
export function appUpdatePreparationDiagnostic(
  status: Readonly<{
    state: string;
    installBlocker: AppUpdatePreparationBlocker | null;
  }> | null,
): AppUpdatePreparationDiagnostic {
  if (
    status?.installBlocker
    && (status.state === "downloaded" || status.state === "failed")
    && APP_UPDATE_PREPARATION_BLOCKERS.includes(status.installBlocker)
  ) {
    return Object.freeze({ phase: "blocked", blocker: status.installBlocker });
  }
  return Object.freeze({
    phase: status?.state === "installing" ? "preparing" : "inactive",
    blocker: null,
  });
}

export function lifecycleActionableStateWithUpdate(
  state: RuntimeLifecycleDiagnosticSnapshot["actionableState"],
  update: AppUpdatePreparationDiagnostic | null | undefined,
): RuntimeLifecycleDiagnosticSnapshot["actionableState"] {
  return state === "safe-and-ready"
    && update?.phase === "blocked"
    && update.blocker === "active-work"
    ? "update-blocked-by-active-work"
    : state;
}
