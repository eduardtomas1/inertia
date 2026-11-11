// @inertia-e2e-resource primary-display
import { expect, test, type Locator } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { createLinuxSecretService, type LinuxSecretService } from "./support/linux-secret-service";
import { setAppearanceInPlace } from "./support/appearance";
import { ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";

const quotaObservedAt = Date.now();
const quotaResetEpoch = Math.floor(quotaObservedAt / 1000);
const nativeSource = `
if (process.argv[2] === "--help") { process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n"); process.exit(0); }
const send = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send(message.id, { userAgent: "usage-limits-fixture" });
  if (message.method === "config/read") send(message.id, { config: { cli_auth_credentials_store: "file" } });
  if (message.method === "account/read") send(message.id, { account: { type: "chatgpt", email: "work@example.test", planType: "pro" } });
  if (message.method === "account/rateLimits/read") send(message.id, { rateLimits: { limitId: "codex", primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: ${quotaResetEpoch}+5400 }, secondary: { usedPercent: 77, windowDurationMins: 10080, resetsAt: ${quotaResetEpoch}+172800 } }, rateLimitResetCredits: { availableCount: 2, credits: null } });
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

async function barGeometry(card: Locator): Promise<{ card: number; meta: number; bar: { left: number; right: number; height: number }; fill: number; hatch: number; mark: number; chipGap: number }> {
  return await card.evaluate((element) => {
    const rect = (selector: string): DOMRect => element.querySelector(selector)!.getBoundingClientRect();
    const bar = rect(".limit-bar");
    return {
      card: Math.round(element.getBoundingClientRect().height),
      meta: Math.round(rect(".limit-card-meta").width),
      bar: { left: bar.left, right: bar.right, height: Math.round(bar.height) },
      fill: rect(".limit-bar-fill").width / bar.width,
      hatch: rect(".limit-bar-hatch").width / bar.width,
      mark: (rect(".limit-bar-mark").left + 1 - bar.left) / bar.width,
      chipGap: Math.round(bar.right - rect(".limit-chip").right),
    };
  });
}

test("shows every account's limits in the Usage popup, the composer and the Usage surface in light, dark and narrow layouts", async ({ browserName: _browserName }, testInfo) => {
  test.setTimeout(150000);
  hub = createServer((request, response) => {
    void (async () => {
    response.setHeader("Content-Type", "application/json");
    if (request.headers.authorization !== "Bearer fixture-hub-key") { response.statusCode = 401; response.end("{}"); return; }
    if (request.url === "/v0/management/auth-files") {
      response.end(JSON.stringify({ files: [
        { id: "codex-local-copy", auth_index: "local", provider: "codex", email: "work@example.test", id_token: { chatgpt_account_id: "fixture-native-account", chatgpt_plan_type: "pro" } },
        { id: "codex-second", auth_index: "second", provider: "codex", email: "personal@example.test", id_token: { chatgpt_account_id: "fixture-second-account", chatgpt_plan_type: "pro" } },
        { id: "claude", auth_index: "claude", provider: "claude", email: "claude@example.test" },
        { id: "gemini", auth_index: "gemini", provider: "gemini", email: "gemini@example.test" },
      ] })); return;
    }
    let text = ""; for await (const chunk of request) text += String(chunk);
    const body = JSON.parse(text) as { url: string; auth_index: string };
    const reset = quotaResetEpoch;
    const weekly = new Date(quotaObservedAt + 3600000 * 78).toISOString();
    const value = body.url.endsWith("rate-limit-reset-credits") ? { credits: [{ id: `fixture-${body.auth_index}-credit`, status: "available", reset_type: "codex_rate_limits", expires_at: new Date(quotaObservedAt+86400000*20).toISOString() }] }
      : body.auth_index === "claude" ? { five_hour: { utilization: 10, resets_at: new Date(quotaObservedAt+3600000).toISOString() }, seven_day: { utilization: 16, resets_at: weekly },
        limits: [{ kind: "weekly_scoped", percent: 32, resets_at: weekly, scope: { model: { display_name: "Fable" } } }] }
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
  const page = app.page; await app.resizeWindow(1360, 1000);
  const capture = async (name: string): Promise<void> => { const path = testInfo.outputPath(`${name}.png`); await page.screenshot({ path, animations: "disabled" }); await testInfo.attach(name, { path, contentType: "image/png" }); };
  const popup = page.getByRole("dialog", { name: "Usage", exact: true });
  const tabs = popup.getByRole("group", { name: "Usage view", exact: true });
  const tab = (name: string): Locator => tabs.getByRole("button", { name, exact: true });
  const trigger = page.locator(".usage-popover-trigger");
  const sidebarUsage = page.locator(".sidebar-footer").getByRole("button", { name: "Usage", exact: true });

  await trigger.click();
  await page.getByRole("button", { name: "All provider limits", exact: true }).click();
  await expect(popup).toBeVisible();
  await expect(popup).toBeFocused();
  await expect(tab("Limits")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await expect(sidebarUsage).toHaveAttribute("aria-haspopup", "dialog");
  await sidebarUsage.click();
  await expect(popup).toBeVisible();
  await expect(page.locator("#workspace-content")).toHaveAttribute("data-view", "workspace");
  await page.keyboard.press("t");
  await expect(tab("Tokens")).toHaveAttribute("aria-pressed", "true");
  await expect(popup.getByRole("button", { name: "Period: Last 30 days", exact: true })).toBeVisible();
  await page.keyboard.press("c");
  await expect(tab("Cost")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("l");
  await expect(tab("Limits")).toHaveAttribute("aria-pressed", "true");
  await expect(popup.getByRole("button", { name: /^Sources:/u })).toHaveCount(0);
  await expect(popup.getByRole("button", { name: "Refresh limits", exact: true })).toBeEnabled();
  await popup.locator(".limits-sources summary").click();
  await popup.getByLabel("Hub name", { exact: true }).fill("Home hub");
  await popup.getByLabel("Hub URL", { exact: true }).fill(`http://127.0.0.1:${address.port}`);
  await popup.getByLabel("Management key", { exact: true }).fill("fixture-hub-key");
  await popup.getByRole("button", { name: "Add hub", exact: true }).click();
  await expect(popup.locator(".limits-source-row")).toContainText("Home hub");
  const codex = popup.getByRole("region", { name: "Codex limits", exact: true });
  const claude = popup.getByRole("region", { name: "Claude limits", exact: true });
  await expect(codex.locator(".limit-card-label")).toHaveText(["Session", "Weekly"]);
  await expect(codex.locator(".limit-card").first().locator(".limit-segment")).toHaveCount(2);
  await expect(codex.locator(".limit-card-figure strong")).toHaveText(["75%", "49%"]);
  await expect(claude.locator(".limit-card-label")).toHaveText(["Session", "Weekly", "Weekly · Fable"]);
  await expect(claude.locator(".limit-card-figure strong")).toHaveText(["90%", "84%", "68%"]);
  await expect(popup.getByRole("region", { name: "gemini limits", exact: true })).toContainText("This provider does not have a supported hub quota API.");
  await expect(popup.getByRole("button", { name: "Sources: All sources", exact: true })).toBeVisible();
  await popup.locator(".limits-sources summary").click();
  await expect(page.getByRole("button", { name: /^Dismiss .* quota notice$/ }))
    .toHaveCount(0, { timeout: 35_000 });
  await popup.locator(".usage-popup-body").evaluate((element) => element.scrollTo(0, 0));

  const shell = await popup.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const header = element.querySelector(".dialog-shell-header")!.getBoundingClientRect();
    const content = element.querySelector(".usage-popup-content")!.getBoundingClientRect();
    return { width: Math.round(bounds.width), height: Math.round(bounds.height), left: Math.round(bounds.left), right: Math.round(window.innerWidth - bounds.right),
      radius: getComputedStyle(element).borderTopLeftRadius, header: Math.round(header.height), content: Math.round(content.width),
      modal: element.getAttribute("aria-modal") };
  });
  expect(shell).toMatchObject({ width: 1280, left: 40, right: 40, radius: "16px", content: 1024, modal: "true" });
  expect(shell.height).toBeLessThanOrEqual(960);
  expect(shell.header).toBeGreaterThanOrEqual(48);
  const weekly = await barGeometry(claude.locator(".limit-card").nth(1));
  expect(weekly).toMatchObject({ meta: 176, bar: { height: 32 }, chipGap: 8 });
  expect(weekly.card).toBeGreaterThanOrEqual(92);
  expect(weekly.card).toBeLessThanOrEqual(98);
  expect(weekly.fill).toBeCloseTo(0.84, 2);
  expect(weekly.hatch).toBeCloseTo(0.16, 2);
  expect(weekly.mark).toBeGreaterThan(0.44);
  expect(weekly.mark).toBeLessThan(0.48);
  await expect(claude.locator(".limit-card").nth(1).locator(".limit-chip")).toHaveText(/^↻ 3d [56]h$/u);
  await expect(codex.locator(".limit-card").first().locator(".limit-chip").first()).toHaveText(/^↻ 1h \d+m·[12]$/u);
  await app.expectNoViewportOverflow(); await capture("limits-light");
  await setAppearanceInPlace(app, "dark");
  await capture("limits-dark");

  const firstAccount = codex.locator(".limit-segment").first();
  await firstAccount.focus(); await page.keyboard.press("Enter");
  await expect(firstAccount).toHaveAttribute("aria-expanded", "true");
  await expect(popup.getByText("Email hidden", { exact: false })).toBeVisible();
  await expect(popup.getByText("work@example.test", { exact: true })).toHaveCount(0);
  await capture("limits-account-details");
  await popup.getByRole("button", { name: "Use reset", exact: true }).click();
  await expect(popup.getByRole("button", { name: "Confirm reset", exact: true })).toBeFocused();
  await popup.getByRole("button", { name: "Cancel", exact: true }).click();
  await firstAccount.click();
  await popup.getByRole("button", { name: "Providers: All providers", exact: true }).click();
  await popup.getByRole("menuitemcheckbox", { name: "Claude", exact: true }).click();
  await expect(claude).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(popup).toBeVisible();
  await popup.getByRole("button", { name: /^Providers: \d+ providers$/u }).click();
  await popup.getByRole("menuitemcheckbox", { name: "All providers", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(claude).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);

  await page.locator(".activity-thread-select").first().click();
  await trigger.click();
  const composer = page.getByRole("dialog", { name: "Usage & context", exact: true });
  await expect(composer.locator(".usage-accounts-hint")).toContainText(/Account \d has more room/);
  await expect(composer.locator(".limit-row-label")).toHaveText(["Session", "Weekly"]);
  await expect(composer.getByRole("meter", { name: "Session remaining", exact: true })).toHaveAttribute("aria-valuenow", "58");
  await expect(composer.locator(".limit-row").first().locator(".limit-bar-mark")).toBeVisible();
  await capture("composer-usage");
  await page.keyboard.press("Escape");
  const panel = await ensureWorkspaceTools(page);
  await selectWorkspaceTool(panel, "Usage");
  const surface = page.getByRole("region", { name: "Usage", exact: true });
  await expect(surface.locator(".limit-row-label")).toHaveText(["Session", "Weekly"]);
  await expect(surface.locator(".limit-row-reset").first()).toHaveText(/^Resets in 1h \d+m$/u);
  await capture("usage-surface");
  await surface.getByRole("button", { name: "All accounts", exact: true }).click();
  await expect(tab("Limits")).toHaveAttribute("aria-pressed", "true");
  await expect(codex.locator(".limit-card").first().locator(".limit-segment")).toHaveCount(2);

  await app.resizeWindow(720, 900);
  await popup.locator(".usage-popup-body").evaluate((element) => element.scrollTo(0, 0));
  await expect(codex.locator(".limit-legend").first()).toBeVisible();
  await expect(codex.locator(".limit-segment-row").first()).toBeHidden();
  expect(await codex.locator(".limit-segment .limit-bar").first().evaluate((element) => Math.round(element.getBoundingClientRect().height))).toBe(20);
  await app.expectNoViewportOverflow(); await capture("limits-narrow");
  await page.keyboard.press("Escape");
  await app.resizeWindow(1360, 1000);
  await setAppearanceInPlace(app, "light");
  await writeFile(join(app.workspaceDirectory, "login"), 'setTimeout(() => process.stdout.write("Logged in using ChatGPT\\n"), 2500);');
  await app.restart();
  const restarted = app.page.getByRole("dialog", { name: "Usage", exact: true });
  await app.page.locator(".sidebar-footer").getByRole("button", { name: "Usage", exact: true }).click();
  await expect(restarted.getByRole("group", { name: "Usage view", exact: true }).getByRole("button", { name: "Limits", exact: true })).toHaveAttribute("aria-pressed", "true");
  const restartedCodex = restarted.getByRole("region", { name: "Codex limits", exact: true });
  await expect(restartedCodex.locator(".limit-card").first().locator(".limit-segment")).toHaveCount(2);
  await restarted.locator(".limits-sources summary").click(); await restarted.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(restarted.locator(".limits-source-row")).toHaveCount(0);
  await expect(restartedCodex.locator(".limit-card").first().locator(".limit-segment")).toHaveCount(1);
  expect(app.rendererErrors).toEqual([]);
});
