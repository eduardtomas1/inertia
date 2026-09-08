import ffi from "ffi-rs";
const { DataType, load, open } = ffi;

// These are the only keys sampled. No key events or typed text are collected.
export function shiftPair(platform: NodeJS.Platform = process.platform): () => boolean {
  const library = "inertia-snapshot-shift";
  if (platform === "darwin") {
    open({ library, path: "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics" });
    const down = (key: number): boolean => load({ library, funcName: "CGEventSourceKeyState", retType: DataType.Boolean, paramsType: [DataType.I32, DataType.I16], paramsValue: [1, key] });
    return () => down(0x38) && down(0x3c);
  }
  if (platform === "win32") {
    open({ library, path: "user32.dll" });
    const down = (key: number): boolean => (load({ library, funcName: "GetAsyncKeyState", retType: DataType.I16, paramsType: [DataType.I32], paramsValue: [key] }) & 0x8000) !== 0;
    return () => down(0xa0) && down(0xa1);
  }
  throw new Error("unsupported");
}

const parent = process.parentPort;
if (parent) {
  try {
    const read = shiftPair();
    let active = false;
    let lastBeat = Date.now();
    parent.on("message", (event) => { if (event.data === "alive") lastBeat = Date.now(); });
    setInterval(() => {
      if (Date.now() - lastBeat > 5000) process.exit(0);
      const pressed = read();
      if (pressed && !active) parent.postMessage("trigger");
      active = pressed;
    }, 50);
    parent.postMessage("ready");
  } catch { process.exit(1); }
}
