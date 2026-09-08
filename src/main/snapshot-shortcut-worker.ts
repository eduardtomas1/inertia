import ffi from "ffi-rs";
const { DataType, load, open } = ffi;

// These are the only keys sampled. No key events or typed text are collected.
function shiftPair(): () => boolean {
  const library = "inertia-snapshot-shift";
  if (process.platform === "darwin") {
    open({ library, path: "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics" });
    return () => (Number(load({ library, funcName: "CGEventSourceFlagsState", retType: DataType.U64, paramsType: [DataType.I32], paramsValue: [0] })) & 6) === 6;
  }
  if (process.platform === "win32") {
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
