// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";

import { createAppFixture, type AppFixture, type RuntimeTestSnapshot } from "./support/app-fixture";
import { closeElectronAfterTest } from "./support/electron-failure-evidence";
import {
  declineNativeRecoverySheet,
  LIFECYCLE_PROVIDER_DONE,
  lifecycleCodexAppServer,
} from "./support/lifecycle-provider-fixture";

const MAX_CRASHES = 6;

let activeApp: AppFixture | undefined;
let bodyFailure: { error: unknown } | undefined;

test.afterEach(async () => {
  const app = activeApp;
  const failure = bodyFailure;
  activeApp = undefined;
  bodyFailure = undefined;
  if (app) await closeElectronAfterTest(() => app.close(), () => test.info(), failure);
});

async function crashRuntime(app: AppFixture): Promise<RuntimeTestSnapshot> {
  return await app.electronApp.evaluate(() => {
    const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as { crash: () => RuntimeTestSnapshot };
    return runtime.crash();
  });
}

async function crashUntilStopped(app: AppFixture): Promise<number> {
  for (let crashes = 1; crashes <= MAX_CRASHES; crashes += 1) {
    await expect.poll(async () => (await app.runtimeSnapshot()).phase, { timeout: 30_000 }).toBe("ready");
    const crashed = await crashRuntime(app);
    let phase = "";
    await expect.poll(async () => {
      const snapshot = await app.runtimeSnapshot();
      phase = snapshot.phase;
      return phase === "stopped"
        || (phase === "ready" && snapshot.pid !== null && snapshot.pid !== crashed.pid);
    }, { timeout: 30_000 }).toBe(true);
    if (phase === "stopped") return crashes;
  }
  throw new Error(`The runtime kept restarting after ${MAX_CRASHES} crashes.`);
}

test("restarts a stopped local service from the banner and runs a chat again", {
  tag: "@runtime-recovery",
}, async () => {
  test.setTimeout(150_000);
  const app = activeApp = await createAppFixture({
    name: "runtime-restart", initialState: "conversation", codexAppServerSource: lifecycleCodexAppServer,
  });
  try {
    const page = app.page;
    await declineNativeRecoverySheet(app);
    const crashes = await crashUntilStopped(app);
    test.info().annotations.push({ type: "crashes-until-stopped", description: String(crashes) });
    const banner = page.locator(".runtime-connection-banner");
    await expect(banner).toContainText("The local service stopped.", { timeout: 30_000 });
    await expect(page.locator(".app-shell")).not.toHaveAttribute("data-connection-status", "online");
    await banner.getByRole("button", { name: "Restart" }).click();
    await expect(page.locator(".app-shell")).toHaveAttribute("data-connection-status", "online", { timeout: 60_000 });
    await expect(banner).toBeHidden();
    expect((await app.runtimeSnapshot()).phase).toBe("ready");

    const composer = page.getByRole("region", { name: "Message composer" });
    const request = "Answer after the restart.";
    await composer.getByRole("textbox", { name: "Message" }).fill(request);
    await composer.getByRole("button", { name: "Send message" }).click();
    const turn = page.locator("[data-turn-id]").filter({ has: page.getByText(request, { exact: true }) });
    await expect(turn.getByText(LIFECYCLE_PROVIDER_DONE)).toBeVisible({ timeout: 30_000 });
    await expect(turn.locator('[data-turn-status="completed"]')).toBeVisible();
  } catch (error) {
    bodyFailure = { error };
    throw error;
  }
});
