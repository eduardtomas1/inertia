import { execFile, spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { settleOperationBounded } from "./electron-app-lifecycle";

const runFile = promisify(execFile);

export interface PrivateX11Desktop {
  readonly display: string;
  stop(): Promise<void>;
}

async function stopProcess(child: ChildProcess, exited: Promise<void>, name: string): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if ((await settleOperationBounded(exited, 5000)).status === "fulfilled") return;
  child.kill("SIGKILL");
  if ((await settleOperationBounded(exited, 2000)).status !== "fulfilled") throw new Error(`${name} did not stop`);
}

export async function startPrivateX11Desktop(): Promise<PrivateX11Desktop> {
  const server = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1280x1024x24", "-nolisten", "tcp"], {
    shell: false, stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  server.stderr?.on("data", (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-4096); });
  const serverExited = new Promise<void>((resolve) => { server.once("close", () => resolve()); });
  let windowManager: ChildProcess | undefined;
  let windowManagerExited = Promise.resolve();
  const stop = async (): Promise<void> => {
    try { if (windowManager) await stopProcess(windowManager, windowManagerExited, "Private Openbox"); }
    finally { await stopProcess(server, serverExited, "Private Xvfb"); }
  };
  try {
    const display = await new Promise<string>((resolve, reject) => {
      let reported = "";
      const timer = setTimeout(() => reject(new Error(`Private Xvfb did not report a display: ${diagnostics}`)), 10_000);
      server.once("error", (error) => { clearTimeout(timer); reject(error); });
      server.once("close", () => { clearTimeout(timer); reject(new Error(`Private Xvfb exited: ${diagnostics}`)); });
      server.stdio[3]!.on("data", (chunk: Buffer) => {
        reported = (reported + chunk.toString()).slice(0, 32);
        const number = /^(\d+)\n/u.exec(reported)?.[1];
        if (number) { clearTimeout(timer); resolve(`:${number}`); }
      });
    });
    const environment = { ...process.env, DISPLAY: display };
    let failure: unknown;
    const manager = spawn("openbox", [], { shell: false, stdio: "ignore", env: environment });
    manager.once("error", (error) => { failure = error; });
    windowManager = manager;
    windowManagerExited = new Promise<void>((resolve) => { manager.once("close", () => resolve()); });
    const deadline = performance.now() + 5000;
    while (true) {
      try {
        const { stdout } = await runFile("xdotool", ["get_desktop"], { timeout: 500, maxBuffer: 1024, env: environment });
        if (/^\d+$/u.test(stdout.trim()) && manager.pid !== undefined && manager.exitCode === null) break;
      } catch (error) { failure = error; }
      if (performance.now() >= deadline || manager.pid === undefined || manager.exitCode !== null) throw new Error("Private Openbox did not become ready", { cause: failure });
      await delay(25);
    }
    return { display, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
