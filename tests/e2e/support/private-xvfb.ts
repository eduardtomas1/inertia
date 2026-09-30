import { spawn } from "node:child_process";
import { settleOperationBounded } from "./electron-app-lifecycle";

export interface PrivateXvfb {
  readonly display: string;
  stop(): Promise<void>;
}

export async function startPrivateXvfb(): Promise<PrivateXvfb> {
  const server = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", "1280x1024x24", "-nolisten", "tcp"], {
    shell: false, stdio: ["ignore", "ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  server.stderr?.on("data", (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-4096); });
  const exited = new Promise<void>((resolve) => { server.once("close", () => resolve()); });
  const stop = async (): Promise<void> => {
    if (server.pid === undefined || server.exitCode !== null || server.signalCode !== null) return;
    server.kill("SIGTERM");
    if ((await settleOperationBounded(exited, 5000)).status === "fulfilled") return;
    server.kill("SIGKILL");
    if ((await settleOperationBounded(exited, 2000)).status !== "fulfilled") throw new Error("Private Xvfb did not stop");
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
    return { display, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
