import {
  parseRuntimeWorkerCommand,
  type RuntimeWorkerEvent,
} from "../main/runtime-process-protocol.js";
import { startRuntime, type RunningRuntime } from "./index.js";

let runtime: RunningRuntime | null = null;
let starting = false;
let stopping = false;
const parentPort = process.parentPort;

if (!parentPort) throw new Error("The runtime worker must run as an Electron utility process.");

function post(event: RuntimeWorkerEvent): void {
  parentPort.postMessage(event);
}

async function shutdown(exitCode = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  const activeRuntime = runtime;
  runtime = null;
  if (activeRuntime) {
    try {
      await activeRuntime.close();
    } catch {
      exitCode = 1;
    }
  }
  post({ type: "runtime.stopped" });
  process.exit(exitCode);
}

parentPort.on("message", (messageEvent) => {
  const command = parseRuntimeWorkerCommand(messageEvent.data);
  if (!command) {
    post({ type: "runtime.startup-failed", message: "The runtime received an invalid lifecycle command." });
    void shutdown(1);
    return;
  }
  if (command.type === "runtime.shutdown") {
    void shutdown();
    return;
  }
  if (starting || runtime || stopping) {
    post({ type: "runtime.startup-failed", message: "The runtime was asked to start more than once." });
    void shutdown(1);
    return;
  }
  starting = true;
  void startRuntime(command.options).then((startedRuntime) => {
    if (stopping) {
      void startedRuntime.close().finally(() => process.exit(0));
      return;
    }
    runtime = startedRuntime;
    post({ type: "runtime.ready", websocketUrl: startedRuntime.websocketUrl });
  }).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message.trim().replace(/\s+/gu, " ").slice(0, 800) : "";
    post({ type: "runtime.startup-failed", message: detail || "The local runtime could not start." });
    void shutdown(1);
  });
});

process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
