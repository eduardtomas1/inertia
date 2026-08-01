const { app, BrowserWindow } = require("electron");

if (process.argv[3]) app.setPath("userData", process.argv[3]);

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
