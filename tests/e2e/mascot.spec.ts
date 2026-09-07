// @inertia-e2e-resource primary-display
import type { MascotBridge } from "../../src/shared/mascot";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import type { AgentRunState } from "../../src/shared/run-state";
import { agentTurnStatusForRunState } from "../../src/shared/run-state";
import { createAppFixture } from "./support/app-fixture";
import { mascotProviderFixture } from "./support/mascot-provider-fixture";

async function capture(page: Page, name: string, info: TestInfo): Promise<void> {
  const path = info.outputPath(`mascot-${name}.png`);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.screenshot({ path, omitBackground: true });
  await info.attach(`Mascot ${name}`, { path, contentType: "image/png" });
}

test("optional mascot follows runtime states, remembers movement, and owns a restricted overlay", async ({ browserName: _browserName }, info) => {
  test.setTimeout(120_000);
  const app = await createAppFixture({ name: "mascot", initialState: "conversation", windowDisplay: "primary" });
  let closeStore = (): void => undefined;
  try {
    const main = app.page;
    await app.resizeWindow(1280, 840);
    expect(app.electronApp.windows()).toHaveLength(1);
    await main.getByRole("button", { name: "Settings", exact: true }).click();
    const toggle = main.getByRole("switch", { name: "Desktop mascot", exact: true });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    const opened = app.electronApp.waitForEvent("window");
    await toggle.click();
    let overlay = await opened;
    await expect(overlay.locator(".mascot")).toHaveAttribute("data-phase", "idle");
    await expect(overlay.locator("img")).toHaveAttribute("data-animated", "false");
    const bubble = await overlay.locator(".mascot-status").boundingBox();
    const character = await overlay.locator("img").boundingBox();
    expect(bubble!.y + bubble!.height).toBeLessThan(character!.y);
    await expect(overlay.locator(".mascot-speech-dots i")).toHaveCount(3);
    await capture(overlay, "idle", info);
    await main.locator(".mascot-settings").evaluate((element) => element.scrollIntoView({ block: "center" }));
    await main.screenshot({ path: info.outputPath("mascot-setting.png") });

    const wiring = await app.electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === "Inertia mascot")!;
      return {
        focused: window.isFocused(), focusable: window.isFocusable(), top: window.isAlwaysOnTop(),
      };
    });
    expect(wiring).toMatchObject({ focused: false, focusable: false, top: true });
    expect(await overlay.evaluate(() => ({
      mainBridge: "inertia" in window,
      settingsBridge: "inertiaMascot" in window,
      methods: Object.keys((window as unknown as { mascot: MascotBridge }).mascot).sort(),
    }))).toEqual({ mainBridge: false, settingsBridge: false, methods: ["action", "onChanged", "snapshot"] });
    expect(await overlay.locator(".mascot-drag").evaluate((element) => getComputedStyle(element).getPropertyValue("-webkit-app-region"))).toBe("drag");

    await main.getByRole("button", { name: "Move with keyboard" }).click();
    await expect(overlay.locator("main")).toBeFocused();
    const before = await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.getTitle() === "Inertia mascot")!.getPosition());
    await overlay.keyboard.press("ArrowLeft");
    await expect.poll(async () => app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.getTitle() === "Inertia mascot")!.getPosition())).toEqual([before[0]! - 16, before[1]]);
    await expect.poll(async () => JSON.parse(await readFile(join(app.testDirectory, "electron-profile", "mascot-window-state.json"), "utf8")).position.x).toBe(before[0]! - 16);

    const nativeMain = await app.electronApp.browserWindow(main);
    await nativeMain.evaluate((window) => { window.show(); window.focus(); window.webContents.focus(); });
    await nativeMain.dispose();
    const store = new RuntimeStore(join(app.testDirectory, "data", "inertia.sqlite"), app.workspaceDirectory, { recoverInterruptedRuns: false });
    closeStore = () => store.close();
    const originalConversationId = store.shellSnapshot().activeConversationId!;
    const project = store.shellSnapshot().projects[0]!;
    const chat = store.createConversation(project.id, "Mascot runtime fixture", { activate: false });
    const selection = providerNativeModelSelection({ providerId: "codex", modelId: "fixture-model", reasoningEffort: "high" });
    let turn = store.beginAgentTurn({
      conversationId: chat.id, runId: "mascot-e2e-run", content: "Exercise mascot state projection.",
      providerId: "codex", modelSelection: selection, reasoningEffort: "high", interactionMode: "build",
      accessMode: "supervised", configurationRevision: 0, association: "authoritative", requestedAt: new Date().toISOString(),
    });
    let revision = 0;
    const state = async (phase: AgentRunState): Promise<void> => {
      const at = new Date().toISOString();
      store.updateAgentTurnLifecycle(turn.turn.id, {
        status: agentTurnStatusForRunState(phase),
        runState: { state: phase, providerState: null, revision: ++revision },
        startedAt: turn.turn.requestedAt, updatedAt: at,
        ...(["completed", "failed"].includes(phase) ? { completedAt: at, terminalReason: `fixture-${phase}` } : {}),
      });
      store.selectConversation(originalConversationId);
      await main.reload();
      await expect(overlay.locator(".mascot")).toHaveAttribute("data-phase", phase);
    };
    await state("starting");
    await capture(overlay, "thinking", info);
    await state("running");
    await expect(overlay.locator("img")).toHaveAttribute("data-animated", "true");
    await capture(overlay, "working", info);
    await overlay.emulateMedia({ reducedMotion: "reduce" });
    await expect(overlay.locator("img")).toHaveAttribute("data-animated", "false");
    await overlay.emulateMedia({ reducedMotion: "no-preference" });
    await state("waiting-for-input");
    await capture(overlay, "waiting", info);
    await state("running");
    await state("completed");
    await capture(overlay, "complete", info);
    await expect(overlay.locator("img")).toHaveAttribute("data-animated", "false");
    turn = store.beginAgentTurn({
      conversationId: chat.id, runId: "mascot-error-run", content: "Exercise failure status.",
      providerId: "codex", modelSelection: selection, reasoningEffort: "high", interactionMode: "build",
      accessMode: "supervised", configurationRevision: 0, association: "authoritative", requestedAt: new Date().toISOString(),
    });
    await state("running");
    await state("failed");
    await capture(overlay, "error", info);
    await overlay.getByRole("button", { name: /Something went wrong.*View issue/ }).click();
    await expect(main.getByRole("heading", { name: "Mascot runtime fixture", level: 1 })).toBeVisible();
    await expect.poll(() => store.shellSnapshot().activeConversationId).toBe(chat.id);
    await expect(overlay.locator(".mascot")).toHaveAttribute("data-phase", "idle");

    store.close();
    closeStore = () => undefined;
    const position = await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.getTitle() === "Inertia mascot")!.getPosition());
    await app.restart();
    overlay = app.electronApp.windows().find((page) => page.url().endsWith("/mascot.html"))!;
    if (!overlay) overlay = await app.electronApp.waitForEvent("window", (page) => page.url().endsWith("/mascot.html"));
    await expect(overlay.locator(".mascot")).toBeVisible();
    expect(await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.getTitle() === "Inertia mascot")!.getPosition())).toEqual(position);
    const closed = overlay.waitForEvent("close");
    await overlay.keyboard.press("Escape").catch((error: unknown) => {
      if (!overlay.isClosed()) throw error;
    });
    await closed;
    await expect.poll(() => app.electronApp.windows().length).toBe(1);
    expect(JSON.parse(await readFile(join(app.testDirectory, "electron-profile", "mascot-window-state.json"), "utf8")).preferences.enabled).toBe(false);
    expect(app.rendererErrors).toEqual([]);
  } finally { closeStore(); await app.close(); }
});

test("mascot previews provider progress, opens questions and approvals, and shows the result", async ({ browserName: _browserName }, info) => {
  test.setTimeout(90_000);
  let chatId = "";
  let otherId = "";
  const app = await createAppFixture({
    name: "mascot-context", initialState: "conversation", windowDisplay: "primary",
    codexAppServerSource: mascotProviderFixture,
    beforeLaunch: async ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
      try {
        chatId = store.shellSnapshot().activeConversationId!;
        store.updateConversation(chatId, { title: "Make the mascot more useful" });
        otherId = store.createConversation(store.shellSnapshot().projects[0]!.id, "Another chat", { activate: false }).id;
      } finally { store.close(); }
      await mkdir(join(testDirectory, "electron-profile"), { recursive: true });
      await writeFile(join(testDirectory, "electron-profile", "mascot-window-state.json"), JSON.stringify({ preferences: { enabled: true, motion: true }, position: null }));
    },
  });
  try {
    const overlay = app.electronApp.windows().find((page) => page.url().endsWith("/mascot.html"))
      ?? await app.electronApp.waitForEvent("window", (page) => page.url().endsWith("/mascot.html"));
    const switchAway = async (): Promise<void> => {
      const store = new RuntimeStore(join(app.testDirectory, "data", "inertia.sqlite"), app.workspaceDirectory, { recoverInterruptedRuns: false });
      try { store.selectConversation(otherId); } finally { store.close(); }
      await app.page.reload();
      await expect(app.page.getByRole("heading", { name: "Another chat", level: 1 })).toBeVisible();
    };
    const composer = app.page.getByRole("region", { name: "Message composer" });
    const request = "Make the mascot show useful updates and ask when it needs me.";
    await composer.getByRole("textbox", { name: "Message", exact: true }).fill(request);
    await composer.getByRole("button", { name: "Send message" }).click();
    // Sending includes admission and a real Git checkpoint before the provider
    // starts. Observe the accepted turn before checking its mascot projection.
    const turn = app.page.locator("[data-turn-id]").filter({
      has: app.page.getByText(request, { exact: true }),
    });
    await expect(turn, "The submitted request must be accepted into a real turn").toBeVisible();
    await expect(overlay.locator(".mascot-message")).toHaveText("Check the question and approval flow");
    await expect(overlay.locator(".mascot-detail")).toHaveText("1 of 3 steps complete");
    await expect(overlay.locator(".mascot-chat")).toHaveText("Make the mascot more useful");
    expect(await overlay.locator(".mascot-action").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await capture(overlay, "working", info);
    await switchAway();
    await writeFile(join(app.workspaceDirectory, ".git", "mascot-question"), "ready");
    await expect(overlay.locator(".mascot")).toHaveAttribute("data-phase", "waiting-for-input");
    await expect(overlay.locator(".mascot-message")).toHaveText("Should I follow all active chats, or only the chat you have selected?");
    await capture(overlay, "waiting", info);
    await overlay.getByRole("button", { name: /Answer in chat/ }).click();
    await expect(app.page.getByRole("heading", { name: "Make the mascot more useful", level: 1 })).toBeVisible();
    await app.page.getByRole("radio", { name: /All active chats/ }).check();
    await app.page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(overlay.locator(".mascot")).toHaveAttribute("data-phase", "waiting-for-approval");
    await expect(overlay.locator(".mascot-message")).toContainText("Run the mascot tests to check the new bubble and keyboard controls.");
    await capture(overlay, "approval", info);
    await switchAway();
    await overlay.getByRole("button", { name: /Review approval/ }).click();
    await app.page.getByRole("button", { name: "Approve once", exact: true }).click();
    await expect(overlay.locator(".mascot")).toHaveAttribute("data-phase", "running");
    await expect(overlay.locator(".mascot-message")).not.toContainText("Should I follow");
    await switchAway();
    await writeFile(join(app.workspaceDirectory, ".git", "mascot-complete"), "ready");
    await expect(overlay.locator(".mascot")).toHaveAttribute("data-phase", "completed");
    await expect(overlay.locator(".mascot-message")).toContainText("The mascot now shows live progress, questions, and results.");
    await capture(overlay, "complete", info);
    await overlay.getByRole("button", { name: /View result/ }).click();
    await expect(app.page.getByRole("heading", { name: "Make the mascot more useful", level: 1 })).toBeVisible();
    expect(app.rendererErrors).toEqual([]);
  } finally { await app.close(); }
});
