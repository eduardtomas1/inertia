import { contextBridge, ipcRenderer } from "electron";
import type { MascotSettingsBridge, MascotSnapshot, MascotSpriteImport, MascotTemplateExport } from "../shared/mascot.js";

// Sandboxed preloads cannot require a shared emitted CommonJS chunk.
const MASCOT_IPC = { snapshot: "inertia:mascot-snapshot", configure: "inertia:mascot-configure", action: "inertia:mascot-action", changed: "inertia:mascot-changed", sprites: "inertia:mascot-sprites" } as const;

export function exposeMascotSettings(): void {
  const bridge: MascotSettingsBridge = {
    snapshot: () => ipcRenderer.invoke(MASCOT_IPC.snapshot) as Promise<MascotSnapshot>,
    configure: (preferences) => ipcRenderer.invoke(MASCOT_IPC.configure, preferences) as Promise<MascotSnapshot>,
    action: (action, expectedStatus) => (action === "open-chat"
      ? ipcRenderer.invoke(MASCOT_IPC.action, action, expectedStatus)
      : ipcRenderer.invoke(MASCOT_IPC.action, action)) as Promise<void>,
    importSprites: () => ipcRenderer.invoke(MASCOT_IPC.sprites, "import") as Promise<MascotSpriteImport>,
    applySprites: (id) => ipcRenderer.invoke(MASCOT_IPC.sprites, "apply", id) as Promise<MascotSnapshot>,
    resetSprites: () => ipcRenderer.invoke(MASCOT_IPC.sprites, "reset") as Promise<MascotSnapshot>,
    exportSpriteTemplate: () => ipcRenderer.invoke(MASCOT_IPC.sprites, "export-template") as Promise<MascotTemplateExport>,
    onChanged: (listener) => {
      const receive = (_event: Electron.IpcRendererEvent, snapshot: MascotSnapshot): void => listener(snapshot);
      ipcRenderer.on(MASCOT_IPC.changed, receive);
      return () => { ipcRenderer.removeListener(MASCOT_IPC.changed, receive); };
    },
  };
  contextBridge.exposeInMainWorld("inertiaMascot", bridge);
}
