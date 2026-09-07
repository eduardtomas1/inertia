import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, expect, type Browser } from "@playwright/test";
import { build } from "esbuild";

import { forceKillPosixProcessTreeWithStatus } from "../../../src/node/posix-process-tree";
import { settleOperationBounded } from "./electron-app-lifecycle";
import { forceStopWindowsElectronLauncher } from "./electron-windows-process";
import type { NativeMotionCounters } from "../../fixtures/renderer-background/native-motion";

const require = createRequire(import.meta.url);

/** Native Electron plus public noDefaults avoids Playwright's forced visibility. */
export async function checkNativeBackgroundMotion(): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "inertia-native-motion-")));
  let child: ChildProcess | undefined;
  let browser: Browser | undefined;
  let exited: Promise<void> | undefined;
  let output = "";
  try {
    await build({
      entryPoints: [fileURLToPath(new URL("../../fixtures/renderer-background/native-motion.tsx", import.meta.url))],
      outfile: join(root, "renderer.js"), bundle: true, platform: "browser", format: "iife",
      tsconfig: "tsconfig.web.json", jsx: "automatic",
      define: { "process.env.NODE_ENV": '"development"' },
      loader: { ".woff": "file", ".woff2": "file", ".ttf": "file", ".svg": "file", ".png": "file" },
    });
    await writeFile(join(root, "index.html"),
      '<!doctype html><title>Native background motion</title><link rel="stylesheet" href="renderer.css"><div id="root"></div><script src="renderer.js"></script>');
    await writeFile(join(root, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
const readline = require("node:readline");
app.setPath("userData", join(__dirname, "profile"));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const main = new BrowserWindow({ width: 600, height: 300, show: true });
  await main.loadFile(join(__dirname, "index.html"));
  readline.createInterface({ input: process.stdin }).on("line", async (command) => {
    if (command === "quit") return app.quit();
    if (command === "hide") main.hide();
    if (command === "show") main.showInactive();
    if (command === "blur") {
      const other = new BrowserWindow({ width: 160, height: 100, show: true });
      await other.loadURL("data:text/html,<title>Native focus fixture</title>");
      main.blur(); other.focus(); other.webContents.focus();
    }
    console.log(JSON.stringify({ command, visible: main.isVisible() }));
  });
});
app.on("window-all-closed", () => app.quit());
setTimeout(() => app.exit(90), 45_000).unref();
`);
    child = spawn(require("electron") as string, [
      "--no-sandbox", "--remote-debugging-port=0", join(root, "main.cjs"),
    ], {
      shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined,
        APPIMAGE: undefined, APPDIR: undefined },
    });
    exited = new Promise<void>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("close", () => resolve());
    });
    void exited.catch(() => undefined);
    child.stdin?.on("error", (error) => { output = (output + error.message).slice(-65_536); });
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-65_536); });
    }
    await expect.poll(() => /DevTools listening on (ws:\/\/[^\s]+)/u.exec(output)?.[1], {
      timeout: 10_000,
    }).toBeTruthy();
    const endpoint = /DevTools listening on (ws:\/\/[^\s]+)/u.exec(output)![1]!;
    browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 10_000 });
    const context = browser.contexts()[0]!;
    const page = context.pages()[0] ?? await context.waitForEvent("page");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect(page.locator("output")).toHaveText(/\d+s/u);
    const snapshot = () => page.evaluate(() => ({
      visibility: document.visibilityState, focus: document.hasFocus(),
      counters: { ...(window.nativeMotion as NativeMotionCounters) }, elapsed: document.querySelector("output")!.textContent,
      animations: document.getAnimations().map((animation) => ({
        state: animation.playState, time: animation.currentTime,
      })),
    }));
    child.stdin!.write("blur\n");
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
    await expect(page.locator("html")).toHaveAttribute("data-document-visible", "true");
    const visible = await snapshot();
    expect(visible.counters.commits).toBeGreaterThan(0);
    expect(visible.counters.timers).toBe(1);
    expect(visible.animations.some(({ state }) => state === "running")).toBe(true);
    await expect.poll(async () => (await snapshot()).counters.ticks).toBeGreaterThan(visible.counters.ticks);
    child.stdin!.write("hide\n");
    await expect.poll(() => output).toContain('"command":"hide","visible":false');
    await expect(page.locator("html")).toHaveAttribute("data-document-visible", "false");
    await expect.poll(async () => (await snapshot()).counters.timers).toBe(0);
    const hidden = await snapshot();
    expect(hidden.visibility).toBe("hidden");
    expect(hidden.animations.every(({ state }) => state === "paused" || state === "finished")).toBe(true);
    await page.waitForTimeout(5_000);
    expect(await snapshot()).toEqual(hidden);
    child.stdin!.write("show\n");
    await expect(page.locator("html")).toHaveAttribute("data-document-visible", "true");
    await expect.poll(async () => (await snapshot()).counters.ticks).toBeGreaterThan(hidden.counters.ticks);
    expect((await snapshot()).elapsed).not.toBe(hidden.elapsed);
    await expect.poll(async () => (await snapshot()).animations.some(({ state }) => state === "running")).toBe(true);
  } finally {
    let childStopped = !child;
    try {
      if (child && exited) {
        if (child.exitCode === null && child.signalCode === null && !child.stdin?.destroyed) {
          child.stdin?.end("quit\n");
        }
        if ((await settleOperationBounded(exited, 5_000)).status === "timed-out" && child.pid) {
          if (process.platform === "win32") await forceStopWindowsElectronLauncher(child, 2_000);
          else forceKillPosixProcessTreeWithStatus(child.pid, { rootProcessGroup: true, deadlineAt: Date.now() + 2_000 });
        }
        childStopped = (await settleOperationBounded(exited, 2_000)).status === "fulfilled";
        expect(childStopped, output).toBe(true);
        expect(child.exitCode, output).toBe(0);
      }
    } finally {
      try { if (browser?.isConnected()) await browser.close(); }
      finally { if (childStopped) await rm(root, { recursive: true, force: true }); }
    }
  }
}
