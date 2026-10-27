// @inertia-e2e-resource isolated
import { expect, test, type Locator } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { RuntimeStore } from "../../src/server/database";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { capturePageWebSockets, publishCapturedWebSocketEvent } from "./support/browser-websocket-fixture";
import { ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";

interface Result {
  ok: boolean;
  message?: string;
  text?: string;
  state?: { viewport?: { width: number; height: number; fit: boolean; mobile: boolean } };
  image?: { mimeType: string; data: string; width: number; height: number };
}

const execFileAsync = promisify(execFile);
const evidenceDirectory = process.env.INERTIA_BROWSER_VIEWPORT_EVIDENCE_DIR
  ? resolve(process.env.INERTIA_BROWSER_VIEWPORT_EVIDENCE_DIR)
  : null;
const runId = "77777777-7777-4777-8777-777777777777";
const turnId = "88888888-8888-4888-8888-888888888888";
const path = "agent-browser-responsive";
let app!: AppFixture;
let conversationId = "";

test.skip(
  !evidenceDirectory || process.platform !== "darwin",
  "Set INERTIA_BROWSER_VIEWPORT_EVIDENCE_DIR on macOS to capture Browser viewport evidence.",
);

async function browser(command: Record<string, unknown>): Promise<Result> {
  return await app.electronApp.evaluate(async (_electron, request) => {
    const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
      agentBrowser: (identity: unknown, command: unknown) => Promise<Result>;
    };
    return await runtime.agentBrowser(request.identity, request.command);
  }, { identity: { conversationId, runId, turnId }, command });
}

async function pageValue<Value>(expression: string): Promise<Value> {
  return await app.electronApp.evaluate(async ({ webContents }, request) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().endsWith(request.path));
    return await contents?.executeJavaScript(request.expression, true) as Value;
  }, { path, expression });
}

async function settle(): Promise<void> {
  const frames = "new Promise((done) => { setTimeout(() => done(true), 1000);"
    + " requestAnimationFrame(() => requestAnimationFrame(() => done(true))); })";
  await pageValue<boolean>(frames);
  await app.page.evaluate(frames);
}

async function bringWindowForward(): Promise<void> {
  const workArea = await app.electronApp.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
  const nativeWindow = await app.electronApp.browserWindow(app.page);
  try {
    await nativeWindow.evaluate((window, area) => {
      const [width = 0] = window.getSize();
      window.setPosition(area.x + Math.max(0, Math.round((area.width - width) / 2)), area.y);
      window.show();
      window.focus();
    }, workArea);
  } finally {
    await nativeWindow.dispose();
  }
}

async function capturePanel(panel: Locator, file: string): Promise<void> {
  await settle();
  const box = await panel.boundingBox();
  if (!box) throw new Error("The Browser panel has no bounds.");
  const nativeWindow = await app.electronApp.browserWindow(app.page);
  let geometry: {
    frame: { x: number; y: number; width: number; height: number };
    content: { x: number; y: number; width: number; height: number };
    zoom: number;
    minimized: boolean;
    source: string;
  };
  try {
    geometry = await nativeWindow.evaluate((window) => ({
      frame: window.getBounds(),
      content: window.getContentBounds(),
      zoom: window.webContents.getZoomFactor(),
      minimized: window.isMinimized(),
      source: window.getMediaSourceId(),
    }));
  } finally {
    await nativeWindow.dispose();
  }
  expect(geometry.minimized).toBe(false);
  const scale = await app.electronApp.evaluate(({ screen }, frame) => screen.getDisplayMatching(frame).scaleFactor, geometry.frame);
  const windowId = geometry.source.split(":")[1] ?? "";
  expect(windowId).toMatch(/^\d+$/u);
  const margin = 8;
  const offsetX = geometry.content.x - geometry.frame.x;
  const offsetY = geometry.content.y - geometry.frame.y;
  const left = Math.max(0, offsetX + Math.floor(box.x * geometry.zoom) - margin);
  const top = Math.max(0, offsetY + Math.floor(box.y * geometry.zoom) - margin);
  const right = Math.min(geometry.frame.width, offsetX + Math.ceil((box.x + box.width) * geometry.zoom) + margin);
  const bottom = Math.min(geometry.frame.height, offsetY + Math.ceil((box.y + box.height) * geometry.zoom) + margin);
  const whole = join(evidenceDirectory!, `window-${file}`);
  await execFileAsync("/usr/sbin/screencapture", ["-x", "-o", "-l", windowId, whole]);
  try {
    await execFileAsync("/usr/bin/sips", [
      "-c", String(Math.round((bottom - top) * scale)), String(Math.round((right - left) * scale)),
      "--cropOffset", String(Math.round(top * scale)), String(Math.round(left * scale)),
      whole, "--out", join(evidenceDirectory!, file),
    ]);
  } finally {
    await rm(whole, { force: true });
  }
}

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "agent-browser-viewport-evidence",
    initialState: "conversation",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, {
        recoverInterruptedRuns: false,
      });
      try {
        store.updateSettings({ theme: "light" });
        conversationId = store.snapshot().conversations[0]!.id;
        const selection = providerNativeModelSelection({ providerId: "codex", modelId: "gpt-5.6", alias: "GPT-5.6" });
        const requestedAt = new Date(Date.now() - 60_000).toISOString();
        store.beginAgentTurn({
          id: turnId, conversationId, runId, content: "Check the layout at desktop and mobile sizes.",
          providerId: "codex", modelSelection: selection, reasoningEffort: selection.reasoningEffort ?? "",
          interactionMode: "build", accessMode: "supervised",
          configurationRevision: selection.backendConfigurationRevision, association: "authoritative", requestedAt,
        });
        store.updateAgentTurnLifecycle(turnId, { status: "running", startedAt: requestedAt, updatedAt: requestedAt });
        store.updateAgentTurnLifecycle(turnId, { status: "waiting-for-approval", updatedAt: requestedAt });
      } finally {
        store.close();
      }
    },
  });
});

test.afterAll(async () => {
  await app?.close();
});

test("captures the Browser panel at each agent viewport", async () => {
  test.setTimeout(240_000);
  await mkdir(evidenceDirectory!, { recursive: true });
  await app.resizeWindow(1440, 900);
  await capturePageWebSockets(app.page);
  await app.page.reload({ waitUntil: "domcontentloaded" });
  await app.page.getByRole("textbox", { name: "Message" }).waitFor();
  await app.page.emulateMedia({ reducedMotion: "reduce" });
  await bringWindowForward();

  const tools = await ensureWorkspaceTools(app.page);
  await selectWorkspaceTool(tools, "Browser");
  const panel = app.page.locator(".workspace-panel");
  const url = `${app.previewUrl}${path}`;
  expect(await browser({ action: "navigate", url }), url).toMatchObject({ ok: true });
  await expect.poll(() => app.nativePreviewIsVisible(url)).toBe(true);
  await expect.poll(() => pageValue<string>("document.querySelector('#size').textContent")).toContain("CSS pixels");
  const stage = await panel.locator(".preview-safe-stage").boundingBox();
  await expect.poll(async () => (await app.nativePreviewSnapshot(url)).bounds).toEqual({
    x: Math.round(stage!.x), y: Math.round(stage!.y), width: Math.round(stage!.width), height: Math.round(stage!.height),
  });
  const stageWidth = await pageValue<number>("innerWidth");
  expect(stageWidth).toBeLessThan(600);

  const select = panel.getByRole("combobox", { name: "Viewport" });
  if (await select.count() === 0) {
    await capturePanel(panel, "before-fit-narrow-panel.png");
    expect(app.rendererErrors).toEqual([]);
    return;
  }

  await expect(select).toHaveValue("fit");
  await capturePanel(panel, "after-fit-narrow-panel.png");

  const sizes = [
    { command: { preset: "desktop" }, width: 1_280, height: 800, value: "desktop", label: "Desktop", file: "after-desktop-1280x800.png" },
    { command: { preset: "mobile" }, width: 375, height: 812, value: "mobile", label: "Mobile", file: "after-mobile-375x812.png" },
    { command: { width: 1_440, height: 900 }, width: 1_440, height: 900, value: "custom", label: "1440×900", file: "after-custom-1440x900.png" },
  ];
  for (const size of sizes) {
    expect(await browser({ action: "resize", ...size.command })).toMatchObject({
      ok: true,
      state: { viewport: { width: size.width, height: size.height, fit: false } },
    });
    await expect.poll(() => pageValue<number>("innerWidth")).toBe(size.width);
    expect(await pageValue<number>("innerHeight")).toBe(size.height);
    await expect(select).toHaveValue(size.value);
    await expect(select.locator("option:checked")).toHaveText(size.label);
    await capturePanel(panel, size.file);
    if (size.value === "desktop") {
      const screenshot = await browser({ action: "screenshot" });
      expect(screenshot).toMatchObject({ ok: true, image: { mimeType: "image/png", width: 1_280, height: 800 } });
      await writeFile(join(evidenceDirectory!, "agent-screenshot-desktop.png"), Buffer.from(screenshot.image!.data, "base64"));
    }
  }

  const evidenceToggle = panel.getByRole("button", { name: /^Evidence \d+$/u });
  await evidenceToggle.click();
  await expect(panel.getByRole("region", { name: "Local evidence" })).toBeVisible();
  await capturePanel(panel, "after-evidence-timeline.png");
  await evidenceToggle.click();
  expect(await browser({ action: "resize", preset: "fit" })).toMatchObject({ ok: true });
  await expect.poll(() => pageValue<number>("innerWidth")).toBe(stageWidth);

  const prepared = await browser({ action: "prepare-approval", command: { action: "resize", preset: "desktop" } });
  expect(prepared, prepared.message).toMatchObject({ ok: true });
  const approval = JSON.parse(prepared.text ?? "{}") as { token: string; detail: string };
  await browser({ action: "discard-approval", token: approval.token });
  expect(approval.detail).toContain("Set the Browser viewport to 1280×800 desktop");
  const requestId = "browser-viewport-evidence-approval";
  await publishCapturedWebSocketEvent(app.page, {
    type: "agent.approval.requested",
    request: {
      id: requestId,
      providerId: "codex", conversationId, runId, turnId,
      kind: "permissions",
      title: "Control Inertia Browser",
      detail: approval.detail,
      reason: "This approval applies only to the inspected tab and document.",
      cwd: app.workspaceDirectory,
      command: null,
      networkScope: null,
      permissionRoots: [],
      availableDecisions: ["approve", "deny", "cancel"],
    },
  });
  const card = app.page.locator('[data-agent-request-state="approval"]').last();
  await expect(card).toContainText("Set the Browser viewport to 1280×800 desktop");
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ animations: "disabled", path: join(evidenceDirectory!, "approval-resize-desktop-light.png") });
  await publishCapturedWebSocketEvent(app.page, {
    type: "agent.approval.resolved", conversationId, runId, turnId, requestId, decision: "deny",
  });
  expect(app.rendererErrors).toEqual([]);
});
