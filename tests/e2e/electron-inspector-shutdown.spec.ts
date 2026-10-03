// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { createAppFixture } from "./support/app-fixture";

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
