// @inertia-e2e-resource isolated
import { expect, test, type Page } from "@playwright/test";

import { DEFAULT_PROVIDER_CANCEL_GRACE_MS } from "../../src/server/provider/run-cleanup-settlement";
import { executableProcessExists } from "../helpers/executable-process";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { closeElectronAfterTest } from "./support/electron-failure-evidence";
import {
  installLifecycleKimi,
  LIFECYCLE_PROVIDER_OUTPUT,
  lifecycleMetadataOnlyCodex,
  lifecycleProviderEvents,
  lifecycleTurnProcess,
} from "./support/lifecycle-provider-fixture";

let activeApp: AppFixture | undefined;
let bodyFailure: { error: unknown } | undefined;

test.afterEach(async () => {
  const app = activeApp;
  const failure = bodyFailure;
  activeApp = undefined;
  bodyFailure = undefined;
  if (app) await closeElectronAfterTest(() => app.close(), () => test.info(), failure);
});

function exitObservedAt(pid: number): Promise<number> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (executableProcessExists(pid)) return;
      clearInterval(timer);
      resolve(Date.now());
    }, 20);
  });
}

async function startIgnoringKimiTurn(name: string): Promise<{ app: AppFixture; page: Page; pid: number; exitedAt: Promise<number> }> {
  const additionalEnvironment: Record<string, string> = {};
  const app = activeApp = await createAppFixture({
    name, initialState: "conversation", additionalEnvironment,
    codexAppServerSource: lifecycleMetadataOnlyCodex,
    beforeLaunch: async ({ testDirectory, workspaceDirectory }) => {
      await installLifecycleKimi(testDirectory, workspaceDirectory, additionalEnvironment);
    },
  });
  const page = app.page;
  const composer = page.getByRole("region", { name: "Message composer" });
  await composer.getByRole("textbox", { name: "Message" }).fill("Keep working and ignore every cancel request.");
  await composer.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByText(LIFECYCLE_PROVIDER_OUTPUT, { exact: true })).toBeVisible({ timeout: 30_000 });
  const { pid } = await lifecycleTurnProcess(app.workspaceDirectory);
  return { app, page, pid, exitedAt: exitObservedAt(pid) };
}

async function cancelRequestedAt(app: AppFixture, pid: number): Promise<number> {
  let at = 0;
  await expect.poll(async () => {
    at = (await lifecycleProviderEvents(app.workspaceDirectory))
      .find((event) => event.pid === pid && event.event === "interrupt")?.at ?? 0;
    return at;
  }).toBeGreaterThan(0);
  return at;
}

async function expectStoppedAndReady(page: Page): Promise<void> {
  const composer = page.getByRole("region", { name: "Message composer" });
  await expect(page.locator('[data-turn-status="cancelled"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-active-work-state]")).toHaveCount(0);
  await expect(composer.getByRole("button", { name: "Send message" })).toBeVisible();
}

test("waits the protocol grace before forcing a provider that ignores Stop", {
  tag: "@runtime-recovery",
}, async () => {
  test.setTimeout(90_000);
  try {
    const { app, page, pid, exitedAt } = await startIgnoringKimiTurn("stop-escalates-single");
    const composer = page.getByRole("region", { name: "Message composer" });
    await composer.getByRole("button", { name: "Stop agent" }).click();
    await expect(page.locator('[data-active-work-state="cancelling"]')).toBeVisible();
    const cancelledAt = await cancelRequestedAt(app, pid);
    const exitMs = (await exitedAt) - cancelledAt;
    test.info().annotations.push({ type: "provider-exit-after-cancel-ms", description: String(exitMs) });
    expect(exitMs).toBeGreaterThanOrEqual(DEFAULT_PROVIDER_CANCEL_GRACE_MS);
    await expectStoppedAndReady(page);
    expect(app.rendererErrors).toEqual([]);
  } catch (error) {
    bodyFailure = { error };
    throw error;
  }
});

test("forces the stop at once when Stop is pressed again while stopping", {
  tag: "@runtime-recovery",
}, async () => {
  test.setTimeout(90_000);
  try {
    const { app, page, pid, exitedAt } = await startIgnoringKimiTurn("stop-escalates-double");
    const composer = page.getByRole("region", { name: "Message composer" });
    await composer.getByRole("button", { name: "Stop agent" }).click();
    const stopping = page.locator('[data-active-work-state="cancelling"]').locator(".turn-stop-action");
    await expect(stopping).toHaveText("Stopping");
    await stopping.click();
    const cancelledAt = await cancelRequestedAt(app, pid);
    const exitMs = (await exitedAt) - cancelledAt;
    test.info().annotations.push({ type: "provider-exit-after-cancel-ms", description: String(exitMs) });
    expect(exitMs).toBeLessThan(DEFAULT_PROVIDER_CANCEL_GRACE_MS);
    await expectStoppedAndReady(page);
    expect(app.rendererErrors).toEqual([]);
  } catch (error) {
    bodyFailure = { error };
    throw error;
  }
});
