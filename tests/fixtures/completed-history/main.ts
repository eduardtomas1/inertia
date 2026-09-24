import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const root = fileURLToPath(new URL(".", import.meta.url));
app.setPath("userData", join(root, "profile"));
app.disableHardwareAcceleration();
const watchdog = setTimeout(() => app.exit(90), 40_000);

async function evaluate(window: BrowserWindow, expression: string): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      window.webContents.executeJavaScript(expression),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Native history observation timed out")), 15_000);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

async function run(): Promise<void> {
  await app.whenReady();
  const window = new BrowserWindow({ width: 1000, height: 800, show: true });
  await window.loadFile(join(root, "index.html"));
  await evaluate(window, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  assert.equal(await evaluate(window, "document.querySelectorAll('.agent-activity').length"), 0);
  window.hide();
  assert.equal(window.isVisible(), false);
  await evaluate(window, `new Promise(resolve => {
    if (document.visibilityState === "hidden") resolve();
    else document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") resolve();
    });
  })`);
  // Mount the production React component for the first time after native hide.
  // No debugger forces visibility, and no animation is finished or cancelled.
  const hidden = await evaluate(window, "window.mountCompletedHistory(); window.inspectCompletedHistory()");
  assert.equal(window.isVisible(), false);
  console.log("HIDDEN_HISTORY " + JSON.stringify(hidden));
  assert.deepEqual(hidden, {
    visibility: "hidden", count: 5, completed: 5, icons: 5, expanded: "false",
    summary: "1 command, 1 edit, 320 tool calls", pending: [],
  });
  window.show();
  await evaluate(window, "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const shown = await evaluate(window, "window.inspectCompletedHistory()");
  console.log("SHOWN_HISTORY " + JSON.stringify(shown));
  assert.deepEqual(shown, {
    visibility: "visible", count: 5, completed: 5, icons: 5, expanded: "false",
    summary: "1 command, 1 edit, 320 tool calls", pending: [],
  });
  window.destroy();
}

void run().then(() => {
  clearTimeout(watchdog);
  app.quit();
}, (error: unknown) => {
  console.error(error);
  clearTimeout(watchdog);
  app.exit(1);
});
