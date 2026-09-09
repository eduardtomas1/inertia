// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { prepareElectronPrivilegedCleanup } from "./support/electron-runtime-shutdown";

let app: AppFixture;
test.afterAll(async () => { await app?.close(); });

test("real operation failures survive restart and remain readable/copyable after runtime termination", async ({ browserName: _browserName }, testInfo) => {
  app = await createAppFixture({ name: "diagnostics", initialState: "conversation",
    // A real supervised provider process that cannot start its app server.
    // The fixture pins this executable, independent of installed/authenticated CLIs.
    codexAppServerSource: 'process.stderr.write("fixture startup refused"); process.exit(1);',
  });
  let page = app.page;
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Discord", exact: true }).click();
  // Invoke the actual privileged Discord operation through its production bridge.
  // Unsupported host validation must prevent both network and credential access.
  const failed = await page.evaluate(async () => window.inertia.sendDiscordReleaseInfo({ repositoryUrl: "https://unsupported.invalid/project" }));
  expect(failed).toMatchObject({ sent: false, code: "discord.repository-missing", incidentId: expect.any(String) });
  if (!failed.incidentId) throw new Error("Main did not return an incident reference");
  const originalId = failed.incidentId;
  await page.getByRole("button", { name: "Diagnostics", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Diagnostics", exact: true, level: 3 })).toBeVisible();
  await expect(page.getByText("A release repository is needed")).toBeVisible();
  await expect.poll(async () => (await page.evaluate(() => window.inertia.queryDiagnostics({ subsystem: "provider", providerId: "codex" }))).total)
    .toBeGreaterThan(0);
  const providerIncident = (await page.evaluate(() => window.inertia.queryDiagnostics({ subsystem: "provider", providerId: "codex" }))).records[0]!;
  expect(["provider.start-failed", "provider.connection-failed"]).toContain(providerIncident.code);
  const summary = page.locator(".diagnostics-incident summary").filter({ hasText: "Codex" }).first();
  await summary.focus(); await summary.press("Enter");
  await expect(page.getByRole("button", { name: "Open provider settings", exact: true })).toBeVisible();

  for (const theme of ["dark", "light"] as const) {
    await page.getByRole("button", { name: "General", exact: true }).click();
    await page.getByRole("radio", { name: theme === "dark" ? "Dark" : "Light", exact: true }).click();
    await page.getByRole("button", { name: "Discord", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Discord release repository URL" })).toBeVisible();
    // Discord must own its field styles; obsolete provider selectors previously
    // left labels, help text and inputs running together on direct navigation.
    const fields = await page.locator(".discord-field").evaluateAll((labels) => labels.map((label) => {
      const help = label.querySelector("span")!.getBoundingClientRect();
      const input = label.querySelector("input")!.getBoundingClientRect();
      return { gap: input.top - help.bottom, height: input.height, width: input.width, left: input.left - help.left };
    }));
    expect(fields).toHaveLength(2);
    for (const field of fields) {
      expect(field.gap).toBeGreaterThanOrEqual(8);
      expect(field.height).toBeGreaterThanOrEqual(34);
      expect(field.width).toBeGreaterThan(200);
      expect(Math.abs(field.left)).toBeLessThan(1);
    }
    await app.expectNoViewportOverflow();
    const discord = testInfo.outputPath(`discord-${theme}.png`);
    await page.screenshot({ path: discord, animations: "disabled" });
    await testInfo.attach(`discord-${theme}`, { path: discord, contentType: "image/png" });
    await page.getByRole("button", { name: "Diagnostics", exact: true }).click();
    await expect(page.locator(".diagnostics-incident").first()).toBeVisible();
    await app.expectNoViewportOverflow();
    const gutters = await page.locator(".diagnostics-center").evaluate((element) => {
      const content = element.closest(".settings-content")!.getBoundingClientRect();
      const inner = element.getBoundingClientRect();
      return [inner.left - content.left, content.right - inner.right];
    });
    for (const gutter of gutters) expect(gutter).toBeGreaterThanOrEqual(20);
    const path = testInfo.outputPath(`diagnostics-${theme}.png`);
    await page.screenshot({ path, animations: "disabled" });
    await testInfo.attach(`diagnostics-${theme}`, { path, contentType: "image/png" });
    await page.locator(".diagnostics-incident summary").filter({ hasText: "Codex" }).first().click();
    await expect(page.getByRole("button", { name: "Open provider settings", exact: true })).toBeVisible();
    const detail = testInfo.outputPath(`diagnostics-detail-${theme}.png`);
    await page.screenshot({ path: detail, animations: "disabled" });
    await testInfo.attach(`diagnostics-detail-${theme}`, { path: detail, contentType: "image/png" });
  }
  await app.resizeWindow(900, 760);
  await app.expectNoViewportOverflow();
  for (const control of await page.locator(".diagnostics-filters select").all()) {
    const box = await control.boundingBox();
    expect(box?.width).toBeGreaterThan(90);
  }
  const narrow = testInfo.outputPath("diagnostics-narrow.png");
  await page.screenshot({ path: narrow, animations: "disabled" });
  await testInfo.attach("diagnostics-narrow", { path: narrow, contentType: "image/png" });

  const restarted = await app.restart(); page = restarted.page;
  await app.resizeWindow(1440, 1050);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Diagnostics", exact: true }).click();
  await expect.poll(async () => (await page.evaluate((incidentId) => window.inertia.queryDiagnostics({ incidentId }), originalId)).records[0]?.id)
    .toBe(originalId);
  const cleanup = await prepareElectronPrivilegedCleanup(restarted.electronApp);
  expect(cleanup.cleanupConfirmed).toBe(true);
  await expect(page.getByText("Runtime offline · diagnostics available")).toBeVisible();
  // Search and native keyboard expansion still work after runtime/SQLite shutdown.
  await page.getByRole("searchbox", { name: "Search diagnostics" }).fill("discord.repository-missing");
  await expect(page.locator(".diagnostics-incident")).toHaveCount(1);
  const row = page.locator(".diagnostics-incident summary").filter({ hasText: "A release repository is needed" });
  await row.focus(); await row.press("Enter");
  await page.getByRole("button", { name: "Copy incident", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Incident copied" })).toBeVisible();
  const clipboard = await restarted.electronApp.evaluate(async ({ clipboard }) => await clipboard.readText());
  expect(clipboard).toContain("discord.repository-missing");
  expect(clipboard).not.toContain(originalId);
  expect(clipboard).not.toContain("fixture-only-not-a-real-credential");
  await page.getByRole("heading", { name: "Diagnostics", exact: true, level: 3 }).scrollIntoViewIfNeeded();
  const offlineScreenshot = testInfo.outputPath("diagnostics-offline.png");
  await page.screenshot({ path: offlineScreenshot, animations: "disabled" });
  await testInfo.attach("diagnostics-offline", { path: offlineScreenshot, contentType: "image/png" });
  const exportPath = testInfo.outputPath("offline-diagnostics.json");
  await restarted.electronApp.evaluate(({ dialog }, path) => {
    // Only the OS file picker is substituted; production IPC, privacy filtering
    // and the atomic main-process file writer remain real.
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, exportPath);
  await page.getByRole("button", { name: "Export filtered", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Filtered diagnostics saved" })).toBeVisible();
  const exported = JSON.parse(await readFile(exportPath, "utf8"));
  expect(exported.records).toHaveLength(1);
  expect(exported.records[0].code).toBe("discord.repository-missing");
  expect(JSON.stringify(exported)).not.toContain(originalId);
  const offline = await page.evaluate(() => window.inertia.queryDiagnostics({}));
  expect(offline.runtime).toBe("unavailable"); expect(offline.total).toBeGreaterThan(0);
  expect(app.rendererErrors).toEqual([]);
});
