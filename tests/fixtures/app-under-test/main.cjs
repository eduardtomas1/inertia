// A tiny Electron app that the App under test end-to-end test launches over
// the debugging pipe. It must stay dependency-free and offline.
const { join } = require("node:path");
const { app, BrowserWindow } = require("electron");

void app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 640,
    height: 420,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.setMenuBarVisibility(false);
  void window.loadFile(join(__dirname, "index.html"));
});

app.on("window-all-closed", () => app.quit());
