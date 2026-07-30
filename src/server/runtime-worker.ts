import {
  parseRuntimeWorkerCommand,
  type RuntimeWorkerEvent,
} from "../node/runtime-process-protocol.js";
import { startRuntime, type RunningRuntime } from "./index.js";
import { RuntimeCredentialBrokerClient } from "./runtime/backends/credential-broker-client.js";
import { RuntimeAttachmentBrokerClient } from "./runtime/attachments/attachment-broker-client.js";
import { runPackagedPdfSmoke } from "./runtime/attachments/package-smoke-pdf.js";
import { RuntimeSecureFileBrokerClient } from "./runtime/secure-file-broker-client.js";
import { completeRuntimeWorkerShutdown } from "./runtime-worker-shutdown.js";

let runtime: RunningRuntime | null = null;
let starting = false;
let stopping = false;
let shutdownExitCode = 0;
const parentPort = process.parentPort;

if (!parentPort) throw new Error("The runtime worker must run as an Electron utility process.");

function post(event: RuntimeWorkerEvent): void {
  parentPort.postMessage(event);
}

const credentials = new RuntimeCredentialBrokerClient({ post });
const attachments = new RuntimeAttachmentBrokerClient(post);
const secureFiles = new RuntimeSecureFileBrokerClient(post);

async function finishShutdown(
  activeRuntime: RunningRuntime | null,
  exitCode: number,
): Promise<void> {
  await completeRuntimeWorkerShutdown({
    runtime: activeRuntime,
    cause: exitCode === 0 ? "runtime-shutdown" : "runtime-crash",
    exitCode,
    closeBrokers: () => {
      credentials.close();
      attachments.close();
      secureFiles.close();
    },
    post,
    exit: (code) => process.exit(code),
  });
}

async function shutdown(exitCode = 0): Promise<void> {
  if (exitCode !== 0) shutdownExitCode = exitCode;
  if (stopping) return;
  stopping = true;
  const activeRuntime = runtime;
  runtime = null;
  // startRuntime owns completion if a shutdown request races its startup.
  if (starting && !activeRuntime) return;
  await finishShutdown(activeRuntime, shutdownExitCode);
}

parentPort.on("message", (messageEvent) => {
  const command = parseRuntimeWorkerCommand(messageEvent.data);
  if (!command) {
    post({ type: "runtime.startup-failed", message: "The runtime received an invalid lifecycle command." });
    void shutdown(1);
    return;
  }
  if (command.type === "runtime.credential-result") {
    credentials.handle(command);
    return;
  }
  if (command.type === "runtime.attachment-result") {
    attachments.handle(command);
    return;
  }
  if (command.type === "runtime.attachment-release-result") {
    attachments.handleRelease(command);
    return;
  }
  if (command.type === "runtime.attachment-relinquish-result") {
    attachments.handleRelinquish(command);
    return;
  }
  if (command.type === "runtime.secure-file-result") {
    secureFiles.handle(command);
    return;
  }
  if (command.type === "runtime.shutdown") {
    void shutdown();
    return;
  }
  if (command.type === "runtime.resolve-project-path") {
    if (!runtime || stopping) {
      post({
        type: "runtime.project-path-rejected",
        requestId: command.requestId,
        message: "The local runtime is not ready.",
      });
      return;
    }
    void runtime.resolveProjectPath(command.request).then(
      (path) => post({ type: "runtime.project-path-resolved", requestId: command.requestId, path }),
      (error: unknown) => {
        const detail = error instanceof Error ? error.message.trim().replace(/\s+/gu, " ").slice(0, 1_000) : "";
        post({
          type: "runtime.project-path-rejected",
          requestId: command.requestId,
          message: detail || "The project path could not be resolved.",
        });
      },
    );
    return;
  }
  if (starting || runtime || stopping) {
    post({ type: "runtime.startup-failed", message: "The runtime was asked to start more than once." });
    void shutdown(1);
    return;
  }
  starting = true;
  void startRuntime({
    ...command.options,
    backendCredentials: credentials,
    attachments,
    secureFiles,
  }).then(async (startedRuntime) => {
    try {
      if (command.options.packageSmokePdf) {
        await runPackagedPdfSmoke(
          command.options.packageSmokePdf.inputPath,
          command.options.packageSmokePdf.resultPath,
        );
      }
    } catch (error) {
      starting = false;
      const detail = error instanceof Error ? error.message.trim().replace(/\s+/gu, " ").slice(0, 800) : "";
      post({ type: "runtime.startup-failed", message: detail || "The local runtime could not start." });
      await finishShutdown(startedRuntime, 1);
      return;
    }
    starting = false;
    if (stopping) {
      await finishShutdown(startedRuntime, shutdownExitCode);
      return;
    }
    runtime = startedRuntime;
    post({ type: "runtime.ready", websocketUrl: startedRuntime.websocketUrl });
  }).catch(async (error: unknown) => {
    starting = false;
    const detail = error instanceof Error ? error.message.trim().replace(/\s+/gu, " ").slice(0, 800) : "";
    post({ type: "runtime.startup-failed", message: detail || "The local runtime could not start." });
    if (stopping) {
      await finishShutdown(null, 1);
      return;
    }
    await shutdown(1);
  });
});

process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });
