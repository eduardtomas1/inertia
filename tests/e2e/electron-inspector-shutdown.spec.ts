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

for (const activation of ["before-cleanup", "after-cleanup"] as const) {
  test(`rejects main-window recreation ${activation} starts`, async () => {
    test.skip(process.platform !== "darwin", "Exercises the macOS activation lifecycle.");
    const fixture = await createAppFixture({ name: "quit-window-admission", initialState: "empty" });
    try {
      const evidence = await fixture.electronApp.evaluate(async ({ app, BrowserWindow }, phase) => {
        const controller = Reflect.get(globalThis, "__inertiaTestRuntime") as {
          preparePrivilegedCleanup(): Promise<{ phase: string; cleanupConfirmed: boolean }>;
        };
        let created = 0;
        const observe = (): void => { created += 1; };
        app.on("browser-window-created", observe);
        try {
          let receipt;
          if (phase === "after-cleanup") receipt = await controller.preparePrivilegedCleanup();
          for (const window of BrowserWindow.getAllWindows()) window.destroy();
          app.emit("activate");
          // In the other ordering, activation has started asynchronous window
          // setup but cleanup begins before its first continuation can resume.
          receipt ??= await controller.preparePrivilegedCleanup();
          await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
          return { created, remaining: BrowserWindow.getAllWindows().length, ...receipt };
        } finally { app.off("browser-window-created", observe); }
      }, activation);
      expect(evidence.phase).toBe("privileged-cleanup-complete");
      expect(evidence.cleanupConfirmed).toBe(true);
      expect(evidence.created).toBe(0);
      expect(evidence.remaining).toBe(0);
    } finally { await fixture.close(); }
  });
}

test("reopens a closed macOS window before privileged cleanup starts", async () => {
  test.skip(process.platform !== "darwin", "Exercises the macOS activation lifecycle.");
  const fixture = await createAppFixture({ name: "window-reopen", initialState: "empty" });
  try {
    const count = await fixture.electronApp.evaluate(async ({ app, BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
      const opened = new Promise<void>((resolveWindow) => {
        app.once("browser-window-created", (_event, window) => {
          window.webContents.once("did-finish-load", () => resolveWindow());
        });
      });
      app.emit("activate");
      await opened;
      return BrowserWindow.getAllWindows().length;
    });
    expect(count).toBe(1);
    expect((await fixture.runtimeSnapshot()).phase).toBe("ready");
  } finally { await fixture.close(); }
});
