import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { app, BrowserWindow, WebContentsView, webContents } from "electron";

import { PreviewBroker } from "../../../src/main/preview-broker";
import type { AgentBrowserCommand } from "../../../src/shared/agent-browser";

// No Playwright Electron connection: its visibility emulation can undo the
// Chromium freeze, making the original broken implementation appear to pass.
const page = `<!doctype html><html><head><title>Local browser diagnostic</title></head><body><h1>Local browser diagnostic</h1><label for="note">Test note</label><input id="note" value="example"><button onclick="document.getElementById('result').textContent='Clicked'">Test button</button><p id="result">Ready</p></body></html>`;
app.disableHardwareAcceleration();
let stage = "startup";
const deadline = setTimeout(() => { console.error(`Native Browser deadline at ${stage}`); app.exit(91); }, 40_000);
deadline.unref();

async function run(): Promise<void> {
  await app.whenReady();
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(request.url === "/private" ? '<input type="password" value="native-password-sentinel">'
      : request.url === "/nested" ? '<iframe src="/"></iframe>' : page);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/`;
  const window = new BrowserWindow({ width: 900, height: 700, show: true });
  await window.loadURL("about:blank");
  const failures: Array<{ phase: string; category: string }> = [];
  const broker = new PreviewBroker({ getWindow: () => window, openExternal: async () => undefined,
    stateChannel: "native-browser-evidence", recordOperationFailure: (failure) => failures.push(failure) });
  const contextId = randomUUID(), connectionId = randomUUID();
  const owner = { ownerId: "primary", contextId, connectionId };
  broker.connect(owner);
  broker.setBounds({ ...owner, bounds: { x: 0, y: 0, width: 800, height: 600 } });
  let captures = 0;
  async function perform(command: AgentBrowserCommand) {
    stage = command.action;
    const result = await broker.perform(contextId, command);
    assert(result.ok, JSON.stringify({ command: command.action, result }));
    return result;
  }
  async function capture() {
    const view = window.contentView.children.find((entry) => entry instanceof WebContentsView && entry.getVisible());
    assert(view instanceof WebContentsView);
    const browser = view.webContents;
    stage = `first paint ${browser.getURL()}`;
    await browser.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    const snapshot = await perform({ action: "snapshot" });
    const content = JSON.parse(snapshot.text) as { text: string; elements: Array<{ name: string; ref: string }> };
    assert(content.text.includes("Local browser diagnostic"));
    assert(content.elements.some((entry) => entry.name === "Test note"));
    const button = content.elements.find((entry) => entry.name === "Test button");
    assert(button);
    await perform({ action: "screenshot" });
    await perform({ action: "click", ref: button.ref });
    const after = await perform({ action: "snapshot" });
    assert((JSON.parse(after.text) as { text: string }).text.includes("Clicked"));
    captures += 1;
  }
  try {
    await broker.navigate({ ...owner, url });
    await capture();
    await perform({ action: "navigate", url: `${url}?navigation` });
    await capture();
    await perform({ action: "tab-open", url: `${url}?fresh` });
    await capture();
    const contents = webContents.getAllWebContents().find((entry) => entry.getURL() === `${url}?fresh`);
    assert(contents);
    const send = contents.debugger.sendCommand.bind(contents.debugger);
    let frozen = false;
    contents.debugger.sendCommand = async (method, parameters, sessionId) => {
      if (method === "Page.setWebLifecycleState") frozen = (parameters as { state: string }).state === "frozen";
      if (frozen && method === "Runtime.evaluate") {
        contents.debugger.sendCommand = send;
        return await new Promise<never>(() => undefined);
      }
      return await send(method, parameters, sessionId);
    };
    const timedOut = await broker.perform(contextId, { action: "snapshot" });
    assert(!timedOut.ok && timedOut.message.includes("page privacy check within 15 seconds"));
    assert.deepEqual(failures, [{ phase: "privacy-check", category: "timeout" }]);
    await capture();
    await perform({ action: "tab-open", url: `${url}?after-timeout` });
    await capture();
    for (const path of ["private", "nested"]) {
      await perform({ action: "navigate", url: `${url}${path}` });
      for (const action of ["snapshot", "screenshot"] as const) {
        const refused = await broker.perform(contextId, { action });
        assert(!refused.ok && refused.code === "invalid", JSON.stringify(refused));
        assert(!JSON.stringify(refused).includes("native-password-sentinel"));
      }
    }
    console.log(`NATIVE_BROWSER_EVIDENCE ${JSON.stringify({ platform: process.platform, arch: process.arch,
      electron: process.versions.electron, captures, timeoutRecovered: true, privacyRefusals: 4 })}`);
  } finally {
    broker.close("primary", contextId);
    window.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

void run().then(() => app.exit(0), (error: unknown) => { console.error(error); app.exit(1); });
