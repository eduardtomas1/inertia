import { randomUUID } from "node:crypto";

import { BrowserWindow, nativeImage } from "electron";

import type { BrowserEvidenceImage } from "../shared/browser-evidence.js";
import type { BrowserEvidenceImageInspectionHandle } from "./browser-evidence-image-approval.js";

function inspectionDocument(dataUrl: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
  <title>Local Browser capture</title>
  <style>
    html, body { width: 100%; height: 100%; margin: 0; background: #111; overflow: hidden; }
    body { display: grid; place-items: center; }
    img { display: block; max-width: 100vw; max-height: 100vh; object-fit: contain; }
  </style>
</head>
<body><img alt="Local Browser capture" src="${dataUrl}"></body>
</html>`;
}

/** Opens main-owned evidence without exposing bytes to the application renderer. */
export async function showBrowserEvidenceImageWindow(
  parent: BrowserWindow | null,
  image: BrowserEvidenceImage,
): Promise<BrowserEvidenceImageInspectionHandle | null> {
  const decoded = nativeImage.createFromBuffer(Buffer.from(image.data, "base64"));
  if (decoded.isEmpty()) return null;
  const inspector = new BrowserWindow({
    width: 820,
    height: 600,
    minWidth: 360,
    minHeight: 240,
    show: false,
    title: "Local Browser capture",
    backgroundColor: "#111111",
    autoHideMenuBar: true,
    ...(parent ? { parent, modal: true } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: false,
      spellcheck: false,
      partition: `inertia-browser-evidence-${randomUUID()}`,
    },
  });
  inspector.setMenuBarVisibility(false);
  inspector.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  inspector.webContents.session.setPermissionCheckHandler(() => false);
  inspector.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  inspector.webContents.session.on("will-download", (event) => event.preventDefault());
  inspector.webContents.on("will-navigate", (event) => event.preventDefault());
  inspector.webContents.on("context-menu", (event) => event.preventDefault());
  const document = inspectionDocument(decoded.toDataURL());
  try {
    await inspector.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`);
  } catch {
    if (!inspector.isDestroyed()) inspector.destroy();
    return null;
  }
  if (inspector.isDestroyed()) return null;
  return {
    show: () => {
      if (inspector.isDestroyed()) return false;
      inspector.show();
      return true;
    },
    close: () => {
      if (!inspector.isDestroyed()) inspector.destroy();
    },
  };
}
