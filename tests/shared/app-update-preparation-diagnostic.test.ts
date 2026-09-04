import { describe, expect, it } from "vitest";

import {
  APP_UPDATE_PREPARATION_BLOCKERS,
  appUpdatePreparationDiagnostic,
  lifecycleActionableStateWithUpdate,
} from "../../src/shared/app-update-preparation-diagnostic";

describe("application update preparation diagnostics", () => {
  it("freezes the complete safe blocker-code vocabulary", () => {
    expect(APP_UPDATE_PREPARATION_BLOCKERS).toEqual([
      "active-work",
      "terminal",
      "maintenance",
      "database-recovery",
      "local-operation",
      "runtime-transition",
      "private-connect",
      "shutdown",
    ]);
  });

  it.each([
    [null, { phase: "inactive", blocker: null }],
    [
      { state: "installing", installBlocker: null },
      { phase: "preparing", blocker: null },
    ],
    [
      { state: "downloaded", installBlocker: "active-work" as const },
      { phase: "blocked", blocker: "active-work" },
    ],
    [
      { state: "failed", installBlocker: "shutdown" as const },
      { phase: "blocked", blocker: "shutdown" },
    ],
    [
      { state: "available", installBlocker: "active-work" as const },
      { phase: "inactive", blocker: null },
    ],
  ] as const)("projects only a consistent updater status %#", (status, expected) => {
    expect(appUpdatePreparationDiagnostic(status)).toEqual(expected);
  });

  it("selects the update action without hiding stronger lifecycle locks", () => {
    const blocked = appUpdatePreparationDiagnostic({
      state: "downloaded",
      installBlocker: "active-work",
    });
    expect(lifecycleActionableStateWithUpdate("safe-and-ready", blocked))
      .toBe("update-blocked-by-active-work");
    expect(lifecycleActionableStateWithUpdate(
      "previous-runtime-cleanup-unconfirmed",
      blocked,
    )).toBe("previous-runtime-cleanup-unconfirmed");
  });

  it("drops arbitrary blocker text", () => {
    expect(appUpdatePreparationDiagnostic({
      state: "downloaded",
      installBlocker: "prompt=/home/person/private",
    } as never)).toEqual({ phase: "inactive", blocker: null });
  });
});
