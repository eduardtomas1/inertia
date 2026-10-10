// @inertia-e2e-resource primary-display
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { mascotChatsProviderFixture } from "./support/mascot-chats-provider-fixture";
import { focusAppWindow } from "./support/window-focus";

const TITLES = {
  A: "Refactor the desktop mascot status feed so several running agents can be followed at a glance",
  B: "Fix flaky login test",
  C: "Write release notes",
} as const;
const BARE = ["Command", "File change", "Turn started", "Finished: Command", "Finished: File change"];

async function capture(app: AppFixture, overlay: Page, name: string, info: TestInfo): Promise<void> {
  await overlay.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const image = await app.electronApp.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === "Inertia mascot")!;
    return (await window.webContents.capturePage()).toPNG().toString("base64");
  });
  const path = info.outputPath(`mascot-chats-${name}.png`);
  await writeFile(path, Buffer.from(image, "base64"));
  await info.attach(`Mascot chats ${name}`, { path, contentType: "image/png" });
}

test("mascot follows three provider chats by priority, lists the others and speaks in the agent's words", async ({ browserName: _browserName }, info) => {
  test.setTimeout(180_000);
  const ids: Record<keyof typeof TITLES, string> = { A: "", B: "", C: "" };
  const app = await createAppFixture({
    name: "mascot-chats", initialState: "conversation", windowDisplay: "primary",
    codexAppServerSource: mascotChatsProviderFixture,
    beforeLaunch: async ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, { recoverInterruptedRuns: false });
      try {
        ids.A = store.shellSnapshot().activeConversationId!;
        store.updateConversation(ids.A, { title: TITLES.A });
        const project = store.shellSnapshot().projects[0]!;
        ids.B = store.createConversation(project.id, TITLES.B, { activate: false }).id;
        ids.C = store.createConversation(project.id, TITLES.C, { activate: false }).id;
      } finally { store.close(); }
      await mkdir(join(testDirectory, "electron-profile"), { recursive: true });
      await writeFile(join(testDirectory, "electron-profile", "mascot-window-state.json"), JSON.stringify({ preferences: { enabled: true, motion: true }, positions: [] }));
    },
  });
  try {
    const overlay = app.electronApp.windows().find((page) => page.url().endsWith("/mascot.html"))
      ?? await app.electronApp.waitForEvent("window", (page) => page.url().endsWith("/mascot.html"));
    const mascot = overlay.locator(".mascot");
    const title = overlay.locator(".mascot-title");
    const message = overlay.locator(".mascot-message");
    const rows = overlay.getByRole("group", { name: "Other chats" });
    const rowTexts = async (): Promise<string[]> => (await rows.getByRole("button").allTextContents()).map((text) => text.replace(/\s+/gu, " ").trim());
    await expect(mascot).toBeVisible();
    await overlay.evaluate((bare) => {
      const seen: string[] = [];
      (window as unknown as { __messages: string[] }).__messages = seen;
      const element = document.querySelector(".mascot-message")!;
      new MutationObserver(() => { if (bare.includes(element.textContent ?? "")) seen.push(element.textContent!); })
        .observe(element, { childList: true, characterData: true, subtree: true });
    }, BARE);
    await expect(mascot).toHaveAttribute("data-compact", "true");
    await expect(overlay.locator(".mascot-label")).toHaveText("Ready when you are");
    await capture(app, overlay, "idle", info);

    const gate = (name: string) => writeFile(join(app.workspaceDirectory, ".git", `mchats-${name}`), "go");
    const select = async (chat: keyof typeof TITLES): Promise<void> => {
      const store = new RuntimeStore(join(app.testDirectory, "data", "inertia.sqlite"), app.workspaceDirectory, { recoverInterruptedRuns: false });
      try { store.selectConversation(ids[chat]); } finally { store.close(); }
      await app.page.reload();
      await expect(app.page.getByRole("heading", { name: TITLES[chat], level: 1 })).toBeVisible();
    };
    const send = async (text: string): Promise<void> => {
      const composer = app.page.getByRole("region", { name: "Message composer" });
      await composer.getByRole("textbox", { name: "Message", exact: true }).fill(text);
      await composer.getByRole("button", { name: "Send message" }).click();
      await expect(app.page.locator("[data-turn-id]").filter({ has: app.page.getByText(text, { exact: true }) })).toBeVisible();
    };

    await send("[A] Make the mascot follow several agents.");
    await expect(mascot).toHaveAttribute("data-phase", "running");
    await expect(title).toHaveText(TITLES.A);
    await gate("A-1");
    await expect(message).toHaveText("I'll start by reading the mascot status publisher to see which runtime events actually reach the bubble.");
    await expect(overlay.locator(".mascot-detail")).toHaveText("1 of 4 steps");
    await gate("A-2");
    await expect(message).toHaveText("The publisher overwrites the preview with every tool title, so I'm going to keep the assistant's own words instead.");
    await expect(rows).toBeHidden();

    await select("B");
    await send("[B] Fix the flaky login test.");
    await gate("B-1");
    await expect(rows.getByRole("button")).toHaveCount(1);
    expect(await rowTexts()).toEqual([`${TITLES.B}· working`]);
    await expect(title).toHaveText(TITLES.A);
    await capture(app, overlay, "two-working", info);

    await gate("A-3");
    await expect(mascot).toHaveAttribute("data-phase", "waiting-for-input");
    await expect(title).toHaveText(TITLES.A);
    await expect(message).toHaveText(/^Should the mascot keep showing a finished chat until you open it/u);
    await expect(mascot).toHaveAttribute("data-artwork", "thinking");
    await expect(overlay.locator(".mascot-speech-dots")).toBeHidden();
    await expect(overlay.getByRole("status")).toContainText("Should the mascot keep showing a finished chat");

    await select("C");
    await send("[C] Draft the release notes.");
    await gate("C-1");
    await expect.poll(rowTexts).toEqual([`${TITLES.C}· working 0/3`, `${TITLES.B}· working`]);
    await expect(title).toHaveText(TITLES.A);

    await gate("B-2");
    await expect.poll(rowTexts).toEqual([`${TITLES.B}· needs you`, `${TITLES.C}· working 0/3`]);
    await expect(title).toHaveText(TITLES.A);
    await expect(mascot).toHaveAttribute("data-phase", "waiting-for-input");
    await capture(app, overlay, "question-shown-approval-listed", info);

    await select("A");
    await app.page.getByRole("radio", { name: /Keep finished chats visible/u }).check();
    await app.page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(title).toHaveText(TITLES.B);
    await expect(mascot).toHaveAttribute("data-phase", "waiting-for-approval");
    await expect(message).toHaveText("Approve command: rm -rf node_modules/.vite && npm ci — Clear the Vite cache and reinstall dependencies, because the failure only appears with a stale optimized dependency bundle.");
    await gate("A-4");
    await expect.poll(rowTexts).toEqual([`${TITLES.C}· working 0/3`, `${TITLES.A}· working 3/4`]);
    await capture(app, overlay, "approval-shown", info);

    await overlay.getByRole("button", { name: /Review approval/u }).click();
    await expect(app.page.getByRole("heading", { name: TITLES.B, level: 1 })).toBeVisible();
    const approval = app.page.getByRole("region", { name: "Approve command" });
    await approval.getByRole("button", { name: "Approve once", exact: true }).click();
    await expect(approval).toHaveCount(0);
    await select("C");
    await gate("B-3");
    await expect(mascot).toHaveAttribute("data-phase", "failed");
    await expect(title).toHaveText(TITLES.B);
    await expect(message).toHaveText(/^The login test still fails after reinstalling: TimeoutError waiting for selector "#submit"/u);
    await expect.poll(rowTexts).toEqual([`${TITLES.C}· working 0/3`, `${TITLES.A}· working 3/4`]);
    await capture(app, overlay, "failure-shown-over-running", info);

    await gate("A-5");
    await expect.poll(rowTexts).toEqual([`${TITLES.A}· done`, `${TITLES.C}· working 0/3`]);
    await expect(title).toHaveText(TITLES.B);
    await capture(app, overlay, "failure-with-result-row", info);
    await rows.getByRole("button", { name: `Open ${TITLES.A}, done` }).click();
    await expect(app.page.getByRole("heading", { name: TITLES.A, level: 1 })).toBeVisible();
    await expect.poll(rowTexts).toEqual([`${TITLES.C}· working 0/3`]);

    await gate("C-2");
    await gate("C-3");
    await expect.poll(rowTexts).toEqual([`${TITLES.C}· done`]);
    await expect(title).toHaveText(TITLES.B);
    await select("B");
    await expect(title).toHaveText(TITLES.C);
    await expect(mascot).toHaveAttribute("data-phase", "completed");
    await expect(message).toHaveText("Release notes drafted in CHANGELOG.md under v0.0.72.");
    await expect(rows).toBeHidden();
    await capture(app, overlay, "result-shown", info);
    await select("C");
    await expect(mascot).toHaveAttribute("data-phase", "idle");
    await expect(mascot).toHaveAttribute("data-compact", "true");

    await focusAppWindow(app.electronApp, app.page);
    await send("[D] Add a one-line summary above the notes.");
    await expect(mascot).toHaveAttribute("data-phase", "running");
    await expect(title).toHaveText(TITLES.C);
    await gate("D-1");
    await expect(app.page.getByText("Added a one-line summary above the release notes.", { exact: true })).toBeVisible();
    await expect(mascot).toHaveAttribute("data-phase", "idle");
    await expect(mascot).toHaveAttribute("data-compact", "true");
    expect(await overlay.evaluate(() => (window as unknown as { __messages: string[] }).__messages)).toEqual([]);
    expect(app.rendererErrors).toEqual([]);
    if (process.platform === "darwin") {
      const nativeMain = await app.electronApp.browserWindow(app.page);
      await nativeMain.evaluate((window) => window.close());
      await nativeMain.dispose();
      await expect.poll(() => app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
        .filter((window) => !window.isDestroyed()).map((window) => window.getTitle()))).toEqual(["Inertia mascot"]);
      await expect(mascot).toHaveAttribute("data-phase", "idle");
    }
  } finally { await app.close(); }
});
