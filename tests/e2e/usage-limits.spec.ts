// @inertia-e2e-resource primary-display
import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { createLinuxSecretService, type LinuxSecretService } from "./support/linux-secret-service";

const nativeSource = `
if (process.argv[2] === "--help") { process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n"); process.exit(0); }
const send = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send(message.id, { userAgent: "usage-limits-fixture" });
  if (message.method === "config/read") send(message.id, { config: { cli_auth_credentials_store: "file" } });
  if (message.method === "account/read") send(message.id, { account: { type: "chatgpt", email: "work@example.test", planType: "pro" } });
  if (message.method === "account/rateLimits/read") send(message.id, { rateLimits: { limitId: "codex", primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: Math.floor(Date.now()/1000)+5400 }, secondary: { usedPercent: 77, windowDurationMins: 10080, resetsAt: Math.floor(Date.now()/1000)+172800 } }, rateLimitResetCredits: { availableCount: 2, credits: null } });
  if (message.method === "model/list") send(message.id, { data: [{ model: "fixture-model", displayName: "Fixture model", isDefault: true, inputModalities: ["text"], supportedReasoningEfforts: [], defaultReasoningEffort: "medium" }], nextCursor: null });
  if (message.method === "account/rateLimitResetCredit/consume") send(message.id, { outcome: "nothingToReset" });
});
`;
let app: AppFixture | undefined; let hub: Server | undefined;
let secretService: LinuxSecretService | undefined;
test.afterEach(async () => {
  try { await app?.close(); }
  finally {
    try { await secretService?.close(); }
    finally { if (hub) await new Promise<void>((resolve) => hub!.close(() => resolve())); }
  }
});

test("inspects pooled accounts, private details and composer limits in light, dark and narrow layouts", async ({ browserName: _browserName }, testInfo) => {
  test.setTimeout(120000);
  hub = createServer((request, response) => {
    void (async () => {
    response.setHeader("Content-Type", "application/json");
    if (request.headers.authorization !== "Bearer fixture-hub-key") { response.statusCode = 401; response.end("{}"); return; }
    if (request.url === "/v0/management/auth-files") {
      response.end(JSON.stringify({ files: [
        { id: "codex-local-copy", auth_index: "local", provider: "codex", email: "work@example.test", id_token: { chatgpt_account_id: "fixture-native-account", chatgpt_plan_type: "pro" } },
        { id: "codex-second", auth_index: "second", provider: "codex", email: "personal@example.test", id_token: { chatgpt_account_id: "fixture-second-account", chatgpt_plan_type: "pro" } },
        { id: "claude", auth_index: "claude", provider: "claude", email: "claude@example.test" },
      ] })); return;
    }
    let text = ""; for await (const chunk of request) text += String(chunk);
    const body = JSON.parse(text) as { url: string; auth_index: string };
    const reset = Math.floor(Date.now()/1000);
    const value = body.url.endsWith("rate-limit-reset-credits") ? { credits: [{ id: `fixture-${body.auth_index}-credit`, status: "available", reset_type: "codex_rate_limits", expires_at: new Date(Date.now()+86400000*20).toISOString() }] }
      : body.auth_index === "claude" ? { five_hour: { utilization: 10, resets_at: new Date(Date.now()+3600000).toISOString() }, seven_day: { utilization: 53, resets_at: new Date(Date.now()+86400000*4).toISOString() } }
        : { plan_type: "pro", rate_limit: { primary_window: { used_percent: body.auth_index === "local" ? 42 : 9, limit_window_seconds: 18000, reset_at: reset+5400 }, secondary_window: { used_percent: body.auth_index === "local" ? 77 : 25, limit_window_seconds: 604800, reset_at: reset+172800 } } };
    response.end(JSON.stringify({ status_code: 200, body: JSON.stringify(value) }));
    })().catch(() => { response.statusCode = 500; response.end("{}"); });
  });
  await new Promise<void>((resolve) => hub!.listen(0, "127.0.0.1", resolve));
  const address = hub.address(); if (!address || typeof address === "string") throw new Error("Hub fixture address missing");
  secretService = await createLinuxSecretService();
  const environment: Record<string, string> = { ...secretService?.environment, CODEX_ACCESS_TOKEN: "", CODEX_API_KEY: "", OPENAI_API_KEY: "" };
  app = await createAppFixture({ name: "usage-limits", initialState: "conversation", windowDisplay: "primary", codexAppServerSource: nativeSource,
    electronMainEntry: secretService?.electronMainEntry,
    claudeAuthSource: "process.exit(1);", additionalEnvironment: environment,
    beforeLaunch: async ({ testDirectory, workspaceDirectory }) => {
      const codexHome = join(testDirectory, "fixture-codex-home"); await mkdir(codexHome);
      await writeFile(join(codexHome, "auth.json"), JSON.stringify({ tokens: { account_id: "fixture-native-account" } })); environment.CODEX_HOME = codexHome;
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false }); store.updateSettings({ theme: "light" }); store.close();
    } });
  await writeFile(testInfo.outputPath("fixture-ownership.json"), JSON.stringify({ testDirectory: app.testDirectory, launcherPid: app.electronApp.process().pid, workspace: app.workspaceDirectory }, null, 2));
  if (secretService) {
    const storage = await app.electronApp.evaluate(async ({ safeStorage }) => ({
      backend: safeStorage.getSelectedStorageBackend(), available: await safeStorage.isAsyncEncryptionAvailable(),
    }));
    expect(storage).toEqual({ backend: "gnome_libsecret", available: true });
    const path = testInfo.outputPath("secure-storage.json");
    await writeFile(path, JSON.stringify(storage));
    await testInfo.attach("secure-storage", { path, contentType: "application/json" });
  }
  const page = app.page; await app.resizeWindow(1280, 820);
  await page.locator(".usage-popover-trigger").click();
  await page.getByRole("button", { name: "All provider limits", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Provider usage limits", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Provider usage limits", exact: true })).toHaveCount(0);
  await page.locator(".usage-popover-trigger").click();
  await page.getByRole("button", { name: "All provider limits", exact: true }).click();
  await expect(page.getByRole("button", { name: "Close provider limits", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".usage-popover-trigger")).toBeFocused();
  await page.getByRole("button", { name: "Usage", exact: true }).click();
  await page.getByRole("button", { name: "Limits", exact: true }).click();
  await expect(page.getByRole("button", { name: "Refresh limits", exact: true })).toBeEnabled();
  await page.locator(".limits-sources summary").click();
  await page.getByLabel("Hub name", { exact: true }).fill("Home hub");
  await page.getByLabel("Hub URL", { exact: true }).fill(`http://127.0.0.1:${address.port}`);
  await page.getByLabel("Management key", { exact: true }).fill("fixture-hub-key");
  await page.getByRole("button", { name: "Add hub", exact: true }).click();
  await expect(page.locator(".limits-source-row")).toContainText("Home hub");
  await expect(page.getByRole("region", { name: "Codex limits", exact: true }).locator("h3")).toContainText("2 accounts");
  await page.locator(".limits-sources summary").click();
  const capture = async (name: string): Promise<void> => { const path = testInfo.outputPath(`${name}.png`); await page.screenshot({ path, animations: "disabled" }); await testInfo.attach(name, { path, contentType: "image/png" }); };
  for (const button of await page.getByRole("button", { name: /^Dismiss .* quota notice$/ }).all()) await button.click();
  await page.locator(".usage-view").evaluate((element) => element.scrollTo(0, 0));
  await app.expectNoViewportOverflow(); await capture("limits-light");
  await page.getByRole("button", { name: "Change theme (current: light)" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark"); await capture("limits-dark");
  const codex = page.getByRole("region", { name: "Codex limits", exact: true });
  await codex.locator(".limits-account-trigger").first().focus(); await page.keyboard.press("Enter");
  await expect(page.getByText("Email hidden", { exact: false })).toBeVisible();
  await expect(page.getByText("work@example.test", { exact: true })).toHaveCount(0);
  await codex.locator(".limits-account-trigger").first().evaluate((element) => element.scrollIntoView({ block: "start" }));
  await capture("limits-account-details");
  await page.getByRole("button", { name: "Use reset", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm reset", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await app.resizeWindow(720, 900);
  const closeNavigation = page.getByRole("button", { name: "Close navigation", exact: true }).last();
  if (await closeNavigation.isVisible()) await closeNavigation.click();
  await page.locator(".usage-view").evaluate((element) => element.scrollTo(0, 0));
  await app.expectNoViewportOverflow(); await capture("limits-narrow");
  await app.resizeWindow(1280, 820);
  await page.getByRole("button", { name: /Change theme \(current: dark\)/ }).click();
  await app.restart();
  await app.page.getByRole("button", { name: "Usage", exact: true }).click(); await app.page.getByRole("button", { name: "Limits", exact: true }).click();
  await expect(app.page.getByRole("region", { name: "Codex limits", exact: true }).locator("h3")).toContainText("2 accounts");
  await app.page.locator(".limits-sources summary").click(); await app.page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(app.page.locator(".limits-source-row")).toHaveCount(0);
  await expect(app.page.getByRole("region", { name: "Codex limits", exact: true }).locator("h3")).toContainText("1 account");
  expect(app.rendererErrors).toEqual([]);
});
