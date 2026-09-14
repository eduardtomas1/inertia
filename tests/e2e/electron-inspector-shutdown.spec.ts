// @inertia-e2e-resource isolated
import { once } from "node:events";
import { expect, test } from "@playwright/test";
import WebSocket from "ws";
import { createAppFixture } from "./support/app-fixture";

test("finishes a prepared quit with an attached main-process debugger", async () => {
  const app = await createAppFixture({ name: "inspector-shutdown", initialState: "empty" });
  const child = app.electronApp.process();
  let debuggerSocket: WebSocket | undefined;
  let closeRequested = false;
  try {
    const url = await app.electronApp.evaluate(() =>
      process.getBuiltinModule("node:inspector").url());
    expect(url).toBeTruthy();
    debuggerSocket = new WebSocket(url!, { handshakeTimeout: 5_000, maxPayload: 64 * 1024 });
    await once(debuggerSocket, "open");
    const enabled = once(debuggerSocket, "message");
    debuggerSocket.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
    await enabled;
    expect(debuggerSocket.readyState).toBe(WebSocket.OPEN);

    // This independent client deliberately stays attached. A clean fixture
    // must close its inspector, without relying on Playwright's stderr watcher
    // to detach or weakening the native process-exit proof.
    const debuggerClosed = once(debuggerSocket, "close");
    closeRequested = true;
    await app.close();
    await debuggerClosed;
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
    expect(debuggerSocket.readyState).toBe(WebSocket.CLOSED);
  } finally {
    debuggerSocket?.terminate();
    if (!closeRequested) await app.close();
  }
});
