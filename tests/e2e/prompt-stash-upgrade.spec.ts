// @inertia-e2e-resource primary-display
import { expect, test } from "@playwright/test";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

let app: AppFixture | undefined;
test.afterEach(async () => { await app?.close(); app = undefined; });

test("recovers a v54 scratch prompt through an explicit copy without changing the draft", async ({ browserName: _browserName }, info) => {
  app = await createAppFixture({ name: "prompt-stash-upgrade", initialState: "conversation", windowDisplay: "primary" });
  await app.resizeWindow(1200, 800);
  const key = "inertia:prompt-stash:v1";
  const content = "Review the release checklist.\nPreserve the existing conversation and attachments.";
  const raw = JSON.stringify({ version: 1, entries: [{
    id: "v54-saved-prompt", content, createdAt: "2026-09-08T10:00:00.000Z",
    route: { harnessId: "codex-app-server", backendProfileId: "native:codex:app-server", modelId: "gpt-5.6", reasoningEffort: "xhigh" },
  }] });
  await app.page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key, raw });
  const draft = "Leave this current draft intact.";
  await app.page.getByRole("textbox", { name: "Message", exact: true }).fill(draft);
  await app.page.getByRole("button", { name: "Scratch prompts", exact: true }).click();
  const recovery = app.page.getByRole("group", { name: "Prompts saved before this update" });
  await expect(recovery).toBeVisible();
  const screenshot = info.outputPath("legacy-scratch-prompts.png");
  await app.page.screenshot({ path: screenshot, animations: "disabled" });
  await info.attach("Existing saved prompt after upgrade", { path: screenshot, contentType: "image/png" });
  const copy = recovery.getByRole("menuitem", { name: /Review the release checklist/ });
  await copy.focus();
  await copy.press("Enter");
  await expect(recovery.getByRole("status")).toContainText("Copied.");
  expect(await app.electronApp.evaluate(({ clipboard }) => clipboard.readText())).toBe(content);
  await expect(app.page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(draft);
  expect(await app.page.evaluate((key) => localStorage.getItem(key), key)).toBe(raw);
  await app.expectNoViewportOverflow();
  await app.restart();
  await app.page.getByRole("button", { name: "Scratch prompts", exact: true }).click();
  await expect(app.page.getByRole("group", { name: "Prompts saved before this update" })).toContainText("Review the release checklist.");
  expect(await app.page.evaluate((key) => localStorage.getItem(key), key)).toBe(raw);
  expect(app.rendererErrors).toEqual([]);
});
