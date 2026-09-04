import { z } from "zod";

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

export const appUpdatePreparationDiagnosticSchema = z.discriminatedUnion(
  "phase",
  [
    z.object({ phase: z.literal("inactive"), blocker: z.null() }).strict(),
    z.object({ phase: z.literal("preparing"), blocker: z.null() }).strict(),
    z.object({
      phase: z.literal("blocked"),
      blocker: z.enum(APP_UPDATE_PREPARATION_BLOCKERS),
    }).strict(),
  ],
);

export type AppUpdatePreparationDiagnostic = Readonly<z.infer<
  typeof appUpdatePreparationDiagnosticSchema
>>;

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
