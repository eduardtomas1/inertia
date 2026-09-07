import { expect, test } from "@playwright/test";
import { realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import packageManifest from "../../package.json" with { type: "json" };
import { createAppFixture } from "./support/app-fixture";
import { checkNativeBackgroundMotion } from "./support/native-background-motion";

// Real provider transport; gates release new content only after native blur.
const provider = `
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
if (process.argv[2] === "--help") {
  process.stdout.write("Usage: codex app-server [OPTIONS] - Run the app server\\n");
  process.exit(0);
}
const threadId = "background-content-thread";
const turnId = "background-content-turn";
const notify = (method, params) => send({ method, params: { threadId, turnId, ...params } });
const gate = (name, callback) => {
  if (fs.existsSync(path.join(process.cwd(), ".git", "background-" + name))) callback();
  else setTimeout(() => gate(name, callback), 50);
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "background-fixture" } });
  if (message.method === "initialized") return;
  if (message.method === "model/list") return send({ id: message.id, result: { data: [], nextCursor: null } });
  if (message.method === "account/rateLimits/read") return send({ id: message.id, result: { rateLimits: null, rateLimitsByLimitId: null } });
  if (message.method === "thread/goal/get") return send({ id: message.id, result: { goal: null } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    return send({ id: message.id, result: { thread: { id: threadId }, model: "fixture", cwd: process.cwd() } });
  }
  if (message.method === "turn/start") {
    const turn = { id: turnId, status: "inProgress", items: [], error: null };
    send({ id: message.id, result: { turn } });
    notify("turn/started", { turn });
    notify("item/reasoning/summaryTextDelta", { itemId: "reasoning", delta: "**Foreground step** Ready for background work." });
    gate("update", () => {
      notify("item/reasoning/summaryTextDelta", { itemId: "reasoning", delta: "\\n\\n**Background step** New content arrived while unfocused." });
      gate("complete", () => {
        notify("item/completed", { item: { id: "answer", type: "agentMessage", text: "Background work completed visibly." } });
        notify("turn/completed", { turn: { ...turn, status: "completed" } });
      });
    });
  }
});
`;

test("suspends native hidden motion and clocks and resumes on showing the window", async () => {
  test.skip(process.platform !== "linux", "Exercises the native Linux hidden-window boundary.");
  test.setTimeout(60_000);
  await checkNativeBackgroundMotion();
});

test("keeps visible unfocused progress animated and renders incoming reasoning and completion", async () => {
  test.setTimeout(90_000);
  const fixture = await createAppFixture({
    name: "background-content", initialState: "conversation", windowDisplay: "primary",
    codexAppServerSource: provider,
  });
  const { page, electronApp } = fixture;
  try {
    const identity = await electronApp.evaluate(({ app }) => ({
      path: app.getAppPath(), name: app.getName(), version: app.getVersion(),
      cwd: process.cwd(), profile: app.getPath("userData"),
    }));
    expect(identity).toMatchObject({ name: packageManifest.name, version: packageManifest.version });
    expect(await realpath(identity.path)).toBe(await realpath(process.cwd()));
    expect(await realpath(identity.cwd)).toBe(await realpath(process.cwd()));
    expect(await realpath(identity.profile)).toBe(await realpath(join(fixture.testDirectory, "electron-profile")));
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setFocusEmulationEnabled", { enabled: false });
    const main = await electronApp.browserWindow(page);
    const mainId = await main.evaluate((window) => window.id);
    await main.evaluate((window) => { window.focus(); window.webContents.focus(); });
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    const request = "Keep background progress visible.";
    await page.getByRole("textbox", { name: "Message", exact: true }).fill(request);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator("[data-turn-id]").filter({ has: page.getByText(request, { exact: true }) })).toBeVisible();
    await page.locator('[data-agent-trace="thinking"] > summary').click();
    const initial = page.locator(".turn-reasoning-step").filter({ hasText: "Foreground step" });
    await expect(initial).toHaveCSS("opacity", "1");
    await expect(initial).toHaveClass(/is-active/u);

    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const other = new BrowserWindow({ width: 160, height: 100, x: 0, y: 0, show: true });
      await other.loadURL("data:text/html,<title>Background focus fixture</title>");
      for (const window of BrowserWindow.getAllWindows()) if (window !== other) window.blur();
      other.focus(); other.webContents.focus();
    });
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
    await expect(page.locator("html")).toHaveAttribute("data-document-active", "false");
    await expect(page.locator("html")).toHaveAttribute("data-document-visible", "true");
    await writeFile(join(fixture.workspaceDirectory, ".git", "background-update"), "ready");
    const incoming = page.locator(".turn-reasoning-step").filter({ hasText: "Background step" });
    await expect(incoming).toContainText("New content arrived while unfocused.");
    // Playwright visibility ignores opacity: assert the actual painted style.
    await expect(incoming).toHaveCSS("opacity", "1");
    await expect(incoming).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
    const progressTime = () => incoming.evaluate((element) => {
      const name = getComputedStyle(element, "::before").animationName;
      const animation = element.getAnimations({ subtree: true }).find((candidate) =>
        candidate instanceof CSSAnimation && candidate.animationName === name);
      return animation?.playState === "running" ? Number(animation.currentTime) : null;
    });
    await expect.poll(progressTime).not.toBeNull();
    const started = (await progressTime())!;
    await expect.poll(progressTime).toBeGreaterThan(started + 150);
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(progressTime).toBeNull();
    await expect(incoming).toHaveCSS("opacity", "1");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect.poll(progressTime).not.toBeNull();

    await writeFile(join(fixture.workspaceDirectory, ".git", "background-complete"), "ready");
    const answer = page.getByRole("article", { name: "Final assistant answer" });
    await expect(answer).toContainText("Background work completed visibly.");
    await expect(answer).toHaveCSS("opacity", "1");
    expect(await page.evaluate(() => document.hasFocus())).toBe(false);

    await electronApp.evaluate(({ BrowserWindow }, id) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.id !== id) window.destroy();
        else { window.focus(); window.webContents.focus(); }
      }
    }, mainId);
    await expect(page.locator("html")).toHaveAttribute("data-document-active", "true");
    await expect(answer).toHaveCSS("opacity", "1");
    expect(fixture.rendererErrors).toEqual([]);
    await session.detach();
  } finally { await fixture.close(); }
});
