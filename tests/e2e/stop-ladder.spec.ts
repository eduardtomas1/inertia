// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";

import { forceTerminationBudgetMs } from "../../src/server/process-lifecycle";
import { DEFAULT_PROVIDER_CANCEL_GRACE_MS } from "../../src/server/provider/run-cleanup-settlement";
import { executableProcessExists } from "../helpers/executable-process";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { closeElectronAfterTest } from "./support/electron-failure-evidence";
import {
  LIFECYCLE_PROVIDER_DONE,
  LIFECYCLE_PROVIDER_OUTPUT,
  lifecycleCodexAppServer,
  lifecycleTurnProcess,
} from "./support/lifecycle-provider-fixture";

const UNCONFIRMED_NOTE = "The provider process could not be confirmed stopped; it may still be running.";

let activeApp: AppFixture | undefined;
let frozenGuardian: number | null = null;
let bodyFailure: { error: unknown } | undefined;

function resumeGuardian(): void {
  const pid = frozenGuardian;
  frozenGuardian = null;
  if (pid !== null && executableProcessExists(pid)) process.kill(pid, "SIGCONT");
}

test.afterEach(async () => {
  resumeGuardian();
  const app = activeApp;
  const failure = bodyFailure;
  activeApp = undefined;
  bodyFailure = undefined;
  if (app) await closeElectronAfterTest(() => app.close(), () => test.info(), failure);
});

test("releases a chat whose provider tree cannot be confirmed stopped within the platform budget", {
  tag: "@runtime-recovery",
}, async () => {
  test.skip(process.platform === "win32", "Freezing the process guardian needs POSIX job control.");
  const ladderMs = DEFAULT_PROVIDER_CANCEL_GRACE_MS + forceTerminationBudgetMs(process.platform);
  test.setTimeout(ladderMs + 90_000);
  const app = activeApp = await createAppFixture({
    name: "stop-ladder", initialState: "conversation", codexAppServerSource: lifecycleCodexAppServer,
  });
  try {
    const page = app.page;
    const composer = page.getByRole("region", { name: "Message composer" });
    const input = composer.getByRole("textbox", { name: "Message" });
    const request = "Keep working and ignore interrupts. lifecycle:hold";
    await input.fill(request);
    await composer.getByRole("button", { name: "Send message" }).click();
    const turn = page.locator("[data-turn-id]").filter({ has: page.getByText(request, { exact: true }) });
    await expect(turn.getByText(LIFECYCLE_PROVIDER_OUTPUT)).toBeVisible({ timeout: 30_000 });
    const provider = await lifecycleTurnProcess(app.workspaceDirectory);
    expect(provider.parentPid).toBeGreaterThan(1);
    process.kill(provider.parentPid, "SIGSTOP");
    frozenGuardian = provider.parentPid;

    const stopRequestedAt = Date.now();
    await composer.getByRole("button", { name: "Stop agent" }).click();
    const live = page.locator('[data-active-work-state="cancelling"]');
    await expect(live).toBeVisible();
    await expect(live.locator(".turn-stop-action")).toHaveText("Stopping");
    await expect(live.locator(".turn-stop-action")).toBeEnabled();
    await expect(composer.getByRole("button", { name: "Stopping agent" })).toBeEnabled();
    await expect(turn.locator('[data-turn-status="cancelled"]')).toBeVisible({ timeout: ladderMs + 10_000 });
    const settledAfterMs = Date.now() - stopRequestedAt;
    expect(settledAfterMs).toBeGreaterThanOrEqual(ladderMs);
    expect(settledAfterMs).toBeLessThan(ladderMs + 10_000);
    await expect(live).toHaveCount(0);
    expect(executableProcessExists(provider.pid)).toBe(true);
    await turn.getByRole("button", { name: /^Details: Interrupted/u }).click();
    await expect(turn.getByText(`Interrupted: Stopped. ${UNCONFIRMED_NOTE}`, { exact: true })).toBeVisible();

    const followUp = "Answer after the stop.";
    await input.fill(followUp);
    await composer.getByRole("button", { name: "Send message" }).click();
    const next = page.locator("[data-turn-id]").filter({ has: page.getByText(followUp, { exact: true }) });
    await expect(next.getByText(LIFECYCLE_PROVIDER_DONE)).toBeVisible({ timeout: 30_000 });
    await expect(next.locator('[data-turn-status="completed"]')).toBeVisible();
    await expect(page.locator("[data-turn-id]")).toHaveCount(2);

    resumeGuardian();
    await expect.poll(() => executableProcessExists(provider.pid), { timeout: 30_000 }).toBe(false);

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Help", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Diagnostics", exact: true, level: 3 })).toBeVisible();
    await page.getByRole("searchbox", { name: "Search diagnostics" }).fill("provider.cleanup-unconfirmed");
    await expect(page.locator(".diagnostics-event-row")
      .filter({ hasText: "A provider process could not be confirmed stopped" })).toHaveCount(1);
    expect(app.rendererErrors).toEqual([]);
  } catch (error) {
    bodyFailure = { error };
    throw error;
  }
});
