const { app, BrowserWindow } = require("electron");

void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadURL(process.argv[2]);
  window.show();
}).catch(() => app.exit(1));
