// @inertia-e2e-resource primary-display
import { expect, test } from "@playwright/test";
import { createCanvas } from "@napi-rs/canvas";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { snapshotFixture } from "../helpers/snapshot-fixture";
import { createAppFixture } from "./support/app-fixture";
import { closeWorkspaceTools } from "./support/workspace-tools";
import { closeElectronAfterTest } from "./support/electron-failure-evidence";
import { startPrivateX11Desktop } from "./support/private-x11-desktop";

function fixturePixels(): number[] {
  const canvas = createCanvas(800, 500); const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#f8f6f1"; ctx.fillRect(0, 0, 800, 500);
  ctx.fillStyle = "#e9e6df"; ctx.fillRect(0, 0, 800, 42);
  ctx.fillStyle = "#35352f"; ctx.font = "18px sans-serif"; ctx.fillText("Notes — Release checklist", 24, 28);
  ctx.font = "bold 30px sans-serif"; ctx.fillText("Release checklist", 40, 105);
  ctx.font = "19px sans-serif"; ctx.fillText("Check keyboard navigation and restore focus after preview.", 40, 148);
  ctx.fillStyle = "#242424"; ctx.fillRect(40, 180, 320, 36);
  ctx.fillStyle = "#ddd9ce"; ctx.fillRect(640, 420, 100, 32);
  ctx.fillStyle = "#35352f"; ctx.font = "16px sans-serif"; ctx.fillText("Publish", 662, 443);
  return [...canvas.toBuffer("image/png")];
}

for (const theme of ["dark", "light"] as const) test(`reviews ${theme} snapshot attachments and retained compaction receipts with native IPC and keyboard focus`, async ({ browserName: _browserName }, testInfo) => {
  let conversationId = "";
  const app = await createAppFixture({ name: "snapshots-compaction", initialState: "conversation", windowDisplay: "primary", beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
    const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
    try {
      const conversation = store.shellSnapshot().conversations[0]!;
      conversationId = conversation.id;
      store.updateConversation(conversationId, { title: "Review the release checklist" });
      const requestedAt = new Date(Date.now() - 20000).toISOString();
      const completedAt = new Date(Date.now() - 10000).toISOString();
      const { turn } = store.beginAgentTurn({ conversationId, runId: "snapshot-visual-run", content: "Review the release checklist and keep the remaining context.", providerId: conversation.providerId, modelSelection: conversation.modelSelection, reasoningEffort: "", interactionMode: "build", accessMode: "supervised", configurationRevision: conversation.modelSelection.backendConfigurationRevision, association: "authoritative", requestedAt });
      store.updateAgentTurnLifecycle(turn.id, { status: "running", startedAt: requestedAt, updatedAt: requestedAt });
      const answer = store.createMessage(conversationId, "The capture and accessibility details are ready to review. Keep keyboard navigation working before publishing.", "assistant", [], turn.id, completedAt);
      store.updateAgentTurnLifecycle(turn.id, { status: "completed", completedAt, updatedAt: completedAt, terminalAssistantMessageId: answer.id, terminalReason: "provider-completed" });
      store.createTurnGitArtifact({ turnId: turn.id, branch: "main", createdAt: completedAt });
      store.completeTurnGitArtifact(turn.id, { files: [], insertions: 0, deletions: 0, status: "ready", completeness: "complete", patchState: "none", capturedAt: completedAt, terminalAssistantMessageId: answer.id, updatedAt: completedAt });
      store.createMessage(conversationId, "/compact", "system", [], null, undefined, { compaction: { providerId: "codex", beforeTokens: 173000, afterTokens: 5690, instructionForwarded: false } });
      store.updateSettings({ theme });
    } finally { store.close(); }
  } });
  let bodyFailure: { error: unknown } | undefined;
  try {
    const page = app.page; await app.resizeWindow(1100, 760);
    await closeWorkspaceTools(page);
    const separator = page.getByRole("separator", { name: "Compacted context 173K → 5.69K tokens" });
    await expect(separator).toBeVisible();
    await page.reload(); await expect(separator).toBeVisible();
    // Controlled desktop fixture: real import lease/PNG validation/IPC/preview,
    // synthetic source metadata. Native OS capture is covered separately.
    const selection = await page.evaluate(async (bytes) => {
      const batchId = await window.inertia.beginAttachmentImport();
      const attachments = await window.inertia.importAttachments(batchId, [{ name: "snapshot.png", mimeType: "image/png", data: new Uint8Array(bytes).buffer }]);
      return { batchId, attachments };
    }, fixturePixels());
    await app.electronApp.evaluate(({ BrowserWindow }, delivery) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed() && candidate.webContents.getURL().includes("index.html"));
      if (!window) throw new Error("Workbench window unavailable");
      window.webContents.send("inertia:snapshot-ready", delivery);
    }, { conversationId, selection: { ...selection, attachments: selection.attachments.map((attachment) => ({ ...attachment, snapshot: snapshotFixture() })) } });
    const tile = page.locator('.composer-attachment[data-snapshot="true"]');
    await expect(tile).toBeVisible(); await expect(tile.getByText("Notes", { exact: true })).toBeVisible();
    await expect(tile.getByText("Release checklist", { exact: true })).toBeVisible();
    await page.getByRole("list", { name: "Attachments", exact: true }).evaluate((list) => Promise.all(
      list.getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
        .map((animation) => animation.finished),
    ));
    const titleBounds = await tile.getByText("Release checklist", { exact: true }).boundingBox();
    const listBounds = await page.getByRole("list", { name: "Attachments", exact: true }).boundingBox();
    expect(titleBounds!.y + titleBounds!.height).toBeLessThanOrEqual(listBounds!.y + listBounds!.height);
    await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused();
    await expect.poll(() => tile.locator("img").evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(800);
    const save = async (name: string) => { const path = testInfo.outputPath(`${name}.png`); await page.screenshot({ path, animations: "disabled" }); await testInfo.attach(name, { path, contentType: "image/png" }); };
    await save(`snapshots-compaction-${theme}-1100x760`);
    const preview = tile.getByRole("button", { name: "Preview attachment snapshot.png" });
    await preview.click(); const dialog = page.getByRole("dialog", { name: "snapshot.png" });
    await expect(dialog).toBeVisible(); await expect(dialog.getByRole("button", { name: "Close preview of snapshot.png" })).toBeFocused();
    // The dialog loads its own validated image. Finish that request before
    // switching views and later revoking the attachment by removing it.
    await expect.poll(() => dialog.locator(".attachment-preview-stage img").evaluate((image) => ({
      complete: (image as HTMLImageElement).complete,
      width: (image as HTMLImageElement).naturalWidth,
      height: (image as HTMLImageElement).naturalHeight,
    }))).toEqual({ complete: true, width: 800, height: 500 });
    await dialog.getByRole("button", { name: "View accessibility data" }).click();
    const controls = await dialog.locator(".snapshot-preview-controls").boundingBox();
    const stage = await dialog.locator(".attachment-preview-stage").boundingBox();
    expect(controls!.y + controls!.height).toBeLessThanOrEqual(stage!.y + 1);
    await expect(dialog.getByLabel("Accessibility data")).toContainText('"redacted": true');
    await save("snapshot-accessibility-preview");
    await page.keyboard.press("Escape"); await expect(preview).toBeFocused();
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await tile.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
    await app.resizeWindow(760, 600); await app.expectNoViewportOverflow();
    await save("snapshots-compaction-compact-760x600");
    await tile.getByRole("button", { name: "Remove attachment snapshot.png" }).click(); await expect(tile).toHaveCount(0);
    await expect(page.locator(".composer").getByRole("button", { name: "Snapshots", exact: true })).toHaveCount(0);
    await app.resizeWindow(1100, 760);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const navigation = page.getByRole("complementary", { name: "Settings sections" });
    const snapshots = navigation.getByRole("button", { name: "Snapshots", exact: true });
    await snapshots.focus(); await snapshots.press("Enter");
    const setup = page.getByRole("main", { name: "Settings", exact: true });
    await expect(setup.getByRole("switch", { name: "Enable Snapshots" })).not.toBeChecked();
    await expect(setup.getByRole("heading", { name: "Take a snapshot" })).toBeVisible();
    await setup.getByRole("combobox", { name: "Capture shortcut" }).selectOption("accelerator");
    await expect(setup.getByRole("combobox", { name: "Capture shortcut" })).toBeEnabled();
    await app.expectNoViewportOverflow();
    await save(`snapshot-settings-privacy-${theme}`);
    await page.reload();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("complementary", { name: "Settings sections" }).getByRole("button", { name: "Snapshots", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Capture shortcut" })).toHaveValue("accelerator");
    expect(app.rendererErrors).toEqual([]);
  } catch (error) { bodyFailure = { error }; throw error; }
  finally { await closeElectronAfterTest(() => app.close(), () => testInfo, bodyFailure); }
});

test("loads snapshot native bindings in the Electron utility runtime without desktop access", async () => {
  const app = await createAppFixture({ name: "snapshot-native-bindings", initialState: "conversation", windowDisplay: "primary" });
  try {
    const result = await app.electronApp.evaluate(async ({ app, utilityProcess }, workerPath) => {
      return await new Promise<{ ready: boolean; code: number; stderr: string }>((resolve, reject) => {
        const child = utilityProcess.fork(workerPath, [], { env: {}, cwd: app.getPath("userData"), stdio: "pipe" });
        let ready = false;
        let stderr = ""; child.stderr?.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4096); });
        const timer = setTimeout(() => { child.kill(); reject(new Error("Binding probe timed out")); }, 10_000);
        child.on("message", (message: unknown) => { if (message === "bindings-ready") { ready = true; child.postMessage("received"); } });
        child.once("exit", (code) => { clearTimeout(timer); resolve({ ready, code, stderr }); });
      });
    }, join(process.cwd(), "out/main/snapshot-binding-worker.js"));
    expect(result, result.stderr).toMatchObject({ ready: true, code: 0 });
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});

for (const theme of ["dark", "light"] as const) test(`reviews a real Linux screenshot in ${theme} before importing it`, async ({ browserName: _browserName }, testInfo) => {
  test.skip(process.platform !== "linux", "Reviewed screenshots are currently Linux-only");
  const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
  test.skip(Boolean(process.env.WAYLAND_DISPLAY) || process.env.XDG_SESSION_TYPE === "wayland"
    || (runtimeDirectory !== undefined && existsSync(join(runtimeDirectory, "wayland-0"))), "A Wayland session would capture the real desktop");
  const desktop = await startPrivateX11Desktop();
  let app: Awaited<ReturnType<typeof createAppFixture>>;
  try {
    app = await createAppFixture({ name: "reviewed-screenshot", initialState: "conversation", windowDisplay: "primary", additionalEnvironment: { DISPLAY: desktop.display, XDG_SESSION_TYPE: "x11" }, beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
      try { store.updateSettings({ theme }); } finally { store.close(); }
    } });
  } catch (error) { await desktop.stop(); throw error; }
  let bodyFailure: { error: unknown } | undefined;
  try {
    const page = app.page;
    await app.resizeWindow(1100, 850); await closeWorkspaceTools(page);
    await app.electronApp.evaluate(async ({ BrowserWindow }) => {
      const target = new BrowserWindow({ width: 640, height: 480, show: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      target.removeMenu();
      await target.loadURL(`data:text/html,${encodeURIComponent('<title>Reviewed screenshot fixture</title><style>body{background:#f8f6f1;color:#242424;font:18px sans-serif;padding:24px}input{background:#ffcc00}</style><h1>Release checklist</h1><p>This is synthetic local test content.</p><label>Private note <input value="review-only-sentinel"></label>')}`);
    });
    await page.bringToFront();
    await page.getByRole("textbox", { name: "Message" }).focus();
    expect((await page.evaluate(() => window.inertia.snapshot({ type: "state" }))).enabled).toBe(false);
    await page.getByRole("button", { name: "Take reviewed screenshot" }).click();
    const dialog = page.getByRole("dialog", { name: "Review screenshot" });
    await expect(dialog).toBeVisible();
    const fixture = dialog.getByRole("group", { name: "Windows and screens" }).getByRole("button", { name: "Reviewed screenshot fixture", exact: true });
    await expect(fixture.or(dialog.getByRole("alert"))).toBeVisible({ timeout: 20_000 });
    expect(await dialog.getByRole("alert").allTextContents()).toEqual([]);
    await fixture.click();
    const preview = dialog.getByRole("img", { name: "Screenshot to review before attaching" });
    await expect(preview).toBeVisible();
    await expect(page.locator(".composer-attachment")).toHaveCount(0);
    await expect.poll(() => preview.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const captured = await preview.evaluate((element) => ({ width: (element as HTMLImageElement).naturalWidth, height: (element as HTMLImageElement).naturalHeight }));
    const crop = { width: Math.floor(captured.width * 0.8), height: Math.floor(captured.height * 0.7) };
    await dialog.getByRole("spinbutton", { name: "Top", exact: true }).fill(String(Math.floor(captured.height / 4)));
    await dialog.getByRole("spinbutton", { name: "Width", exact: true }).fill(String(crop.width));
    await dialog.getByRole("spinbutton", { name: "Height", exact: true }).fill(String(Math.floor(captured.height / 10)));
    const masked = { x: 0, y: Math.floor(captured.height / 4), width: crop.width, height: Math.floor(captured.height / 10) };
    const maskedPixels = () => preview.evaluate((element, area) => {
      const image = element as HTMLImageElement; const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
      const data = context.getImageData(area.x, area.y, area.width, area.height).data;
      let count = 0;
      for (let offset = 0; offset < data.length; offset += 4) if (data[offset] === 36 && data[offset + 1] === 36 && data[offset + 2] === 36 && data[offset + 3] === 255) count += 1;
      return { masked: count, total: data.length / 4 };
    }, masked);
    expect((await maskedPixels()).masked).toBeLessThan(masked.width * masked.height);
    await dialog.getByRole("button", { name: "Mask area", exact: true }).click();
    await expect.poll(maskedPixels).toEqual({ masked: masked.width * masked.height, total: masked.width * masked.height });
    await expect(dialog.getByRole("button", { name: "Attach reviewed image" })).toBeEnabled();
    await dialog.getByRole("spinbutton", { name: "Width", exact: true }).fill(String(crop.width));
    await dialog.getByRole("spinbutton", { name: "Height", exact: true }).fill(String(crop.height));
    await dialog.getByRole("button", { name: "Crop to area", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Attach reviewed image" })).toBeEnabled();
    await expect.poll(() => preview.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(crop.width);
    const bounds = await preview.boundingBox(); expect(bounds).not.toBeNull();
    await page.mouse.move(bounds!.x + bounds!.width * 0.25, bounds!.y + bounds!.height * 0.25);
    await page.mouse.down();
    await page.mouse.move(bounds!.x + bounds!.width * 0.75, bounds!.y + bounds!.height * 0.75);
    await page.mouse.up();
    await expect.poll(async () => Math.abs(Number(await dialog.getByRole("spinbutton", { name: "Left", exact: true }).inputValue()) - crop.width / 4)).toBeLessThanOrEqual(3);
    await expect.poll(async () => Math.abs(Number(await dialog.getByRole("spinbutton", { name: "Width", exact: true }).inputValue()) - crop.width / 2)).toBeLessThanOrEqual(3);
    const path = testInfo.outputPath(`reviewed-screenshot-${theme}.png`);
    await page.screenshot({ path, animations: "disabled" }); await testInfo.attach("reviewed-screenshot", { path, contentType: "image/png" });
    await app.resizeWindow(760, 600); await app.expectNoViewportOverflow();
    await dialog.getByRole("button", { name: "Attach reviewed image" }).click();
    await expect(dialog).toHaveCount(0);
    const tile = page.locator(".composer-attachment"); await expect(tile).toHaveCount(1);
    await expect(tile).not.toHaveAttribute("data-snapshot", "true");
    await expect.poll(() => tile.locator("img").evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(crop.width);
    await expect(page.getByRole("textbox", { name: "Message" })).toBeEmpty();
    expect(app.rendererErrors).toEqual([]);
  } catch (error) { bodyFailure = { error }; throw error; }
  finally {
    try { await closeElectronAfterTest(() => app.close(), () => testInfo, bodyFailure); } finally { await desktop.stop(); }
  }
});
