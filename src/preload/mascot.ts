import { contextBridge, ipcRenderer } from "electron";
import type { MascotBridge, MascotSnapshot } from "../shared/mascot.js";

// Sandboxed preloads cannot require a shared emitted CommonJS chunk.
const MASCOT_IPC = { snapshot: "inertia:mascot-snapshot", configure: "inertia:mascot-configure", action: "inertia:mascot-action", changed: "inertia:mascot-changed" } as const;

const bridge: MascotBridge = {
  snapshot: () => ipcRenderer.invoke(MASCOT_IPC.snapshot) as Promise<MascotSnapshot>,
  action: (action, expected) => (action === "open-chat" || action === "pickup" || action === "drop"
    ? ipcRenderer.invoke(MASCOT_IPC.action, action, expected)
    : ipcRenderer.invoke(MASCOT_IPC.action, action)) as Promise<void>,
  onChanged: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, snapshot: MascotSnapshot): void => listener(snapshot);
    ipcRenderer.on(MASCOT_IPC.changed, receive);
    return () => { ipcRenderer.removeListener(MASCOT_IPC.changed, receive); };
  },
};
contextBridge.exposeInMainWorld("mascot", bridge);
