const { contextBridge } = require("electron");
contextBridge.exposeInMainWorld("nativeControl", { ready: true });
