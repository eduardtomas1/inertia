// @inertia-e2e-resource primary-display
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import type { AgentBrowserCommand, AgentBrowserResult } from "../../src/shared/agent-browser";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";

// The exact synthetic page reported in #382, with no framework or remote assets.
const diagnosticPage = `<!doctype html><html><head><title>Local browser diagnostic</title></head><body><h1>Local browser diagnostic</h1><label for="note">Test note</label><input id="note" value="example"><button onclick="document.getElementById('result').textContent='Clicked'">Test button</button><p id="result">Ready</p></body></html>`;
let app: AppFixture;
let server: Server;
let url: string;
let conversationId: string;

async function command(command: AgentBrowserCommand): Promise<AgentBrowserResult> {
  return await app.electronApp.evaluate(async (_electron, request) => {
    const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
      agentBrowser(id: string, command: AgentBrowserCommand): Promise<AgentBrowserResult>;
    };
    return await runtime.agentBrowser(request.id, request.command);
  }, { id: conversationId, command });
}

async function showBrowserAndWaitForFrame(targetUrl: string): Promise<void> {
  await app.electronApp.evaluate(async ({ BrowserWindow, webContents }, previewUrl) => {
    for (const window of BrowserWindow.getAllWindows()) window.show();
    const contents = webContents.getAllWebContents().find((entry) => entry.getURL() === previewUrl);
    if (!contents) throw new Error("Missing Browser tab");
    // show() returns before the native surface is ready. Let Chromium present
    // a visible frame before the screenshot command freezes its lifecycle.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Browser did not present a visible frame")), 5000);
      void contents.executeJavaScript(`new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(document.visibilityState)));
      })`).then((visibility: unknown) => {
        clearTimeout(timer);
        if (visibility !== "visible") reject(new Error("Browser frame was not visible"));
        else resolve();
      }, (error: unknown) => { clearTimeout(timer); reject(error); });
    });
  }, targetUrl);
}

test.beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(diagnosticPage);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing diagnostic server port");
  url = `http://127.0.0.1:${address.port}/`;
  app = await createAppFixture({
    name: "agent-browser-frozen-evidence", initialState: "conversation", windowDisplay: "primary",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory,
        { recoverInterruptedRuns: false });
      try {
        const conversation = store.snapshot().conversations[0];
        if (!conversation) throw new Error("Missing fixture conversation");
        conversationId = conversation.id;
      } finally { store.close(); }
    },
  });
  const tools = await ensureWorkspaceTools(app.page);
  await selectWorkspaceTool(tools, "Browser");
  await tools.getByRole("textbox", { name: "Preview address" }).fill(url);
  await tools.getByRole("button", { name: "Go", exact: true }).click();
  await expect.poll(() => app.nativePreviewIsVisible(url)).toBe(true);
});

test.afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
});

test("captures the reported page while hidden and restores usable refs after resuming", async () => {
  expect(Buffer.byteLength(diagnosticPage)).toBe(312);
  // Cover semantic capture when the user has hidden the app window.
  for (let index = 0; index < 2; index += 1) {
    await app.electronApp.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.hide();
    });
    expect(await command({ action: "navigate", url: `${url}?navigation=${index}` })).toMatchObject({ ok: true });
    const snapshot = await command({ action: "snapshot" });
    expect(snapshot).toMatchObject({ ok: true });
    if (!snapshot.ok) throw new Error(snapshot.message);
    const parsed = JSON.parse(snapshot.text) as { text: string; elements: Array<{ name: string; ref: string }> };
    expect(parsed.text).toContain("Local browser diagnostic");
    expect(parsed.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Test note" }), expect.objectContaining({ name: "Test button" }),
    ]));
    // Pixel capture needs a compositor surface; show the window for the image.
    // The separate native Linux test proves the frozen-routing regression.
    await showBrowserAndWaitForFrame(`${url}?navigation=${index}`);
    const screenshot = await command({ action: "screenshot" });
    expect(screenshot, JSON.stringify(screenshot)).toMatchObject({ ok: true });
  }
  await app.electronApp.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.show();
  });
  const snapshot = await command({ action: "snapshot" });
  if (!snapshot.ok) throw new Error(snapshot.message);
  const button = (JSON.parse(snapshot.text) as { elements: Array<{ name: string; ref: string }> })
    .elements.find((element) => element.name === "Test button");
  expect(button).toBeDefined();
  expect(await command({ action: "click", ref: button!.ref })).toMatchObject({ ok: true });
  const clicked = await command({ action: "snapshot" });
  expect(clicked).toMatchObject({ ok: true });
  if (clicked.ok) expect((JSON.parse(clicked.text) as { text: string }).text).toContain("Clicked");
});

test("recovers capture and fresh tabs after a frozen privacy response times out", async () => {
  expect(await command({ action: "navigate", url })).toMatchObject({ ok: true });
  await app.electronApp.evaluate(({ webContents }, targetUrl) => {
    const contents = webContents.getAllWebContents().find((entry) => entry.getURL() === targetUrl);
    if (!contents) throw new Error("Missing Browser tab");
    const original = contents.debugger.sendCommand.bind(contents.debugger);
    let frozen = false;
    contents.debugger.sendCommand = async (method, parameters, sessionId) => {
      const values = parameters as { state?: string } | undefined;
      if (method === "Page.setWebLifecycleState") frozen = values?.state === "frozen";
      if (frozen && method === "Runtime.evaluate") {
        contents.debugger.sendCommand = original;
        // Lose one response, keeping Chromium itself live for real resume/retry.
        return await new Promise<never>(() => undefined);
      }
      return await original(method, parameters, sessionId);
    };
  }, url);
  const failed = await command({ action: "snapshot" });
  expect(failed).toMatchObject({ ok: false, code: "unavailable" });
  if (!failed.ok) expect(failed.message).toContain("the page privacy check within 15 seconds");
  expect(await command({ action: "snapshot" })).toMatchObject({ ok: true });
  await showBrowserAndWaitForFrame(url);
  expect(await command({ action: "screenshot" })).toMatchObject({ ok: true });
  expect(await command({ action: "tab-open", url: `${url}?fresh` })).toMatchObject({ ok: true });
  expect(await command({ action: "snapshot" })).toMatchObject({ ok: true });
  await showBrowserAndWaitForFrame(`${url}?fresh`);
  expect(await command({ action: "screenshot" })).toMatchObject({ ok: true });
  const log = await readFile(join(app.testDirectory, "electron-profile", "logs", "runtime", "runtime.log"), "utf8");
  const failures = log.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === "browser.operation-failure");
  expect(failures).toEqual([expect.objectContaining({ phase: "privacy-check", category: "timeout" })]);
  expect(JSON.stringify(failures)).not.toContain(url);
  expect(JSON.stringify(failures)).not.toContain("Local browser diagnostic");
});
