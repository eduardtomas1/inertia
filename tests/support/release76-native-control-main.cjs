// Diagnostic branch only: a provider-free Electron shutdown control.
const { app, BrowserWindow } = require("electron");
const { writeSync } = require("node:fs");
const path = require("node:path");
const mark = (value) => writeSync(2, `[NativeControl:${value}]\n`);
const profile = process.argv.find((arg) => arg.startsWith("--native-control-profile="));
if (!profile) throw new Error("Missing control profile.");
app.setPath("userData", profile.slice("--native-control-profile=".length));
app.on("window-all-closed", () => {});
let ready;
globalThis.nativeControlReady = new Promise((resolve) => { ready = resolve; });
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(__dirname, "release76-native-control-preload.cjs"),
    sandbox: true, contextIsolation: true,
  } });
  await window.loadURL("data:text/html,<html><body>Native shutdown control</body></html>");
  const contents = window.webContents;
  contents.once("destroyed", () => mark("contents-destroyed"));
  globalThis.nativeControlQuit = () => {
    setTimeout(() => {
      mark("destroy-entered");
      window.destroy();
      mark("destroy-returned");
      mark(contents.isDestroyed() ? "contents-destroyed-at-exit" : "contents-present-at-exit");
      process.getBuiltinModule("node:inspector").close();
      mark("exit-called");
      process.exit(0);
      mark("exit-returned");
    }, 0);
  };
  mark("ready"); ready();
  if (process.argv.includes("--native-control-mode=direct")) globalThis.nativeControlQuit();
}).catch(() => { mark("boot-error"); process.exit(1); });
