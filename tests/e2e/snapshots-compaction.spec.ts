// @inertia-e2e-resource primary-display
import { expect, test } from "@playwright/test";
import { createCanvas } from "@napi-rs/canvas";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { snapshotFixture } from "../helpers/snapshot-fixture";
import { createAppFixture } from "./support/app-fixture";

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
  try {
    const page = app.page; await app.resizeWindow(1100, 760);
    const tools = page.getByRole("button", { name: "Close workspace tools" }); if (await tools.isVisible()) await tools.click();
    const environment = page.getByRole("button", { name: "Close environment summary" }); if (await environment.isVisible()) await environment.click();
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
    const settings = page.getByRole("button", { name: "Snapshots", exact: true }); await settings.click();
    const setup = page.getByRole("dialog", { name: "Snapshots", exact: true }); await expect(setup).toBeVisible();
    await expect(setup.getByRole("checkbox", { name: "Enable Snapshots" })).not.toBeChecked();
    await save(`snapshot-settings-privacy-${theme}`);
    await page.keyboard.press("Escape"); await expect(settings).toBeFocused();
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
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
