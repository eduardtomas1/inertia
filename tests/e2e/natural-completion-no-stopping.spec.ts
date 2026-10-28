// @inertia-e2e-resource isolated
import { expect, test, type Page } from "@playwright/test";

import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { closeElectronAfterTest } from "./support/electron-failure-evidence";
import {
  declineNativeRecoverySheet,
  LIFECYCLE_PROVIDER_DONE,
  lifecycleCodexAppServer,
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

async function observeWorkingStates(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen = new Set<string>();
    Reflect.set(window, "__lifecycleWorkingStates", seen);
    const record = (): void => {
      for (const element of document.querySelectorAll("[data-active-work-state]")) {
        seen.add(`state:${element.getAttribute("data-active-work-state") ?? ""}`);
      }
      if (document.querySelector('[aria-label="Stopping agent"]')) seen.add("composer:stopping");
      if (document.body.textContent?.includes("Stopping")) seen.add("text:stopping");
    };
    record();
    new MutationObserver(record).observe(document.body, {
      subtree: true, childList: true, attributes: true, characterData: true,
    });
  });
}

async function observedWorkingStates(page: Page): Promise<string[]> {
  return await page.evaluate(() => [...(Reflect.get(window, "__lifecycleWorkingStates") as Set<string>)].sort());
}

async function expectCompletionWithoutStopping(request: string): Promise<void> {
  const app = activeApp = await createAppFixture({
    name: "natural-completion", initialState: "conversation", codexAppServerSource: lifecycleCodexAppServer,
  });
  try {
    const page = app.page;
    await declineNativeRecoverySheet(app);
    await observeWorkingStates(page);
    expect(await observedWorkingStates(page)).toEqual([]);
    const composer = page.getByRole("region", { name: "Message composer" });
    await composer.getByRole("textbox", { name: "Message" }).fill(request);
    await composer.getByRole("button", { name: "Send message" }).click();
    const turn = page.locator("[data-turn-id]").filter({ has: page.getByText(request, { exact: true }) });
    await expect(turn.getByText(LIFECYCLE_PROVIDER_DONE)).toBeVisible({ timeout: 30_000 });
    await expect(turn.locator('[data-turn-status="completed"]')).toBeVisible();
    await expect(page.locator("[data-active-work-state]")).toHaveCount(0);
    await expect(composer.getByRole("button", { name: "Send message" })).toBeVisible();
    const observed = await observedWorkingStates(page);
    expect(observed).toContain("state:running");
    expect(observed.filter((state) => /stopping|cancelling/u.test(state))).toEqual([]);
    await expect(page.locator(".app-shell")).toHaveAttribute("data-connection-status", "online");
    expect(app.rendererErrors).toEqual([]);
  } catch (error) {
    bodyFailure = { error };
    throw error;
  }
}

test("never shows Stopping while a streamed turn completes on its own", {
  tag: "@runtime-recovery",
}, async () => {
  test.setTimeout(90_000);
  await expectCompletionWithoutStopping("Stream for a while and finish. lifecycle:stream=4000");
});

test("never shows Stopping when a turn that ran a command completes on its own", {
  tag: "@runtime-recovery",
}, async () => {
  test.setTimeout(90_000);
  await expectCompletionWithoutStopping("Run a command, stream and finish. lifecycle:run-command lifecycle:stream=3000");
});
