import {
  parseRuntimeWorkerCommand,
  type RuntimeWorkerEvent,
} from "../node/runtime-process-protocol.js";
import { startRuntime, type RunningRuntime } from "./index.js";
import { RuntimeCredentialBrokerClient } from "./runtime/backends/credential-broker-client.js";
import { RuntimeAttachmentBrokerClient } from "./runtime/attachments/attachment-broker-client.js";
import {
  RuntimeConversationAttachmentStoreBrokerClient,
} from "./runtime/attachments/conversation-attachment-store-broker-client.js";
import { runPackagedPdfSmoke } from "./runtime/attachments/package-smoke-pdf.js";
import {
  BoundedDatabaseRecoveryReceipts,
  DatabaseRecoveryOperationCancelledError,
  DatabaseRecoveryOperationQueue,
} from "./runtime/database-recovery-queue.js";
import { RuntimeSecureFileBrokerClient } from "./runtime/secure-file-broker-client.js";
import {
  RuntimeAgentBrowserBrokerClient,
} from "./runtime/agent-browser-broker-client.js";
import { completeRuntimeWorkerShutdown } from "./runtime-worker-shutdown.js";
import {
  activateRuntimeOwnedProcessRegistry,
  awaitRuntimeOwnedProcessCleanupConfirmed,
} from "../node/runtime-owned-processes.js";

let runtime: RunningRuntime | null = null;
const databaseRecoveryOperations = new DatabaseRecoveryOperationQueue();
const databaseRecoveryReceipts = new BoundedDatabaseRecoveryReceipts<Extract<
  RuntimeWorkerEvent,
  { type: "runtime.database-recovery-result" }
>>(32);
const activeDatabaseRecoveryOperations = new Map<
  string,
  "export" | "import"
>();
let starting = false;
let stopping = false;
let runtimeGeneration: number | null = null;
let updatePreparation: {
  operationId: string;
  generation: number;
  ready: boolean;
} | null = null;
let lastReleasedUpdatePreparation: { operationId: string; generation: number } | null = null;
let shutdownExitCode = 0;
let packageSmokePdfController: AbortController | null = null;
let packageSmokePdfOperation: Promise<void> | null = null;
let packageSmokeImageController: AbortController | null = null;
let packageSmokeImageOperation: Promise<void> | null = null;
const parentPort = process.parentPort;
let acknowledgeStopped!: () => void;
const stoppedAcknowledged = new Promise<void>((resolve) => {
  acknowledgeStopped = resolve;
});

if (!parentPort) throw new Error("The runtime worker must run as an Electron utility process.");

function post(event: RuntimeWorkerEvent): void {
  parentPort.postMessage(event);
}

function recoveryOperationKey(
  generation: number,
  operationId: string,
): string {
  return `${generation}:${operationId}`;
}

function postDatabaseRecoveryResult(
  event: Extract<RuntimeWorkerEvent, { type: "runtime.database-recovery-result" }>,
): void {
  const key = recoveryOperationKey(event.generation, event.operationId);
  databaseRecoveryReceipts.record(key, event);
  post(event);
}

const credentials = new RuntimeCredentialBrokerClient({ post });
const attachments = new RuntimeAttachmentBrokerClient(post);
const conversationAttachmentStore =
  new RuntimeConversationAttachmentStoreBrokerClient(post);
const secureFiles = new RuntimeSecureFileBrokerClient(post);
const agentBrowser = new RuntimeAgentBrowserBrokerClient(post);

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
      conversationAttachmentStore.close();
      secureFiles.close();
      agentBrowser.close();
    },
    ownedProcessCleanupConfirmed: awaitRuntimeOwnedProcessCleanupConfirmed,
    post,
    awaitStoppedAcknowledgement: () => stoppedAcknowledged,
    exit: (code) => process.exit(code),
  });
}

async function shutdown(exitCode = 0): Promise<void> {
  if (exitCode !== 0) shutdownExitCode = exitCode;
  if (stopping) return;
  stopping = true;
  const activeRuntime = runtime;
  runtime = null;
  packageSmokePdfController?.abort(new Error("The packaged PDF smoke was cancelled during shutdown."));
  packageSmokeImageController?.abort(new Error("The packaged image smoke was cancelled during shutdown."));
  await Promise.all([
    databaseRecoveryOperations.closeAndDrain(),
    packageSmokePdfOperation?.catch(() => undefined) ?? Promise.resolve(),
    packageSmokeImageOperation?.catch(() => undefined) ?? Promise.resolve(),
  ]);
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
  if (command.type === "runtime.conversation-attachment-store-result") {
    conversationAttachmentStore.handle(command);
    return;
  }
  if (command.type === "runtime.secure-file-result") {
    secureFiles.handle(command);
    return;
  }
  if (command.type === "runtime.agent-browser-result") {
    agentBrowser.handle(command);
    return;
  }
  if (command.type === "runtime.record-system-suspend") {
    if (runtime && !stopping) {
      runtime.recordSystemSuspendInterval(command.interval);
    }
    return;
  }
  if (command.type === "runtime.shutdown") {
    void shutdown();
    return;
  }
  if (command.type === "runtime.stopped-acknowledged") {
    acknowledgeStopped();
    return;
  }
  if (command.type === "runtime.release-update-preparation") {
    const matchesCurrent = updatePreparation?.operationId === command.operationId
      && updatePreparation.generation === command.generation;
    const matchesReleased = lastReleasedUpdatePreparation?.operationId === command.operationId
      && lastReleasedUpdatePreparation.generation === command.generation;
    const released = matchesReleased || Boolean(
      matchesCurrent
      && runtime
      && !stopping
      && runtime.releaseUpdatePreparation(command.operationId),
    );
    if (released && matchesCurrent) {
      lastReleasedUpdatePreparation = updatePreparation;
      updatePreparation = null;
    }
    post({
      type: "runtime.release-update-preparation-result",
      operationId: command.operationId,
      generation: command.generation,
      released,
    });
    return;
  }
  if (command.type === "runtime.prepare-update") {
    if (
      !runtime
      || stopping
      || runtimeGeneration !== command.generation
      || (
        updatePreparation
        && (
          updatePreparation.operationId !== command.operationId
          || updatePreparation.generation !== command.generation
        )
      )
    ) {
      post({
        type: "runtime.prepare-update-result",
        operationId: command.operationId,
        generation: command.generation,
        ready: false,
        blocker: "runtime-operation",
      });
      return;
    }
    if (updatePreparation) {
      if (updatePreparation.ready) {
        post({
          type: "runtime.prepare-update-result",
          operationId: command.operationId,
          generation: command.generation,
          ready: true,
        });
      }
      return;
    }
    if (
      databaseRecoveryOperations.hasActiveOperations()
      || activeDatabaseRecoveryOperations.size > 0
    ) {
      post({
        type: "runtime.prepare-update-result",
        operationId: command.operationId,
        generation: command.generation,
        ready: false,
        blocker: "database-recovery",
      });
      return;
    }
    if (packageSmokePdfOperation || packageSmokeImageOperation) {
      post({
        type: "runtime.prepare-update-result",
        operationId: command.operationId,
        generation: command.generation,
        ready: false,
        blocker: "runtime-operation",
      });
      return;
    }
    const activeRuntime = runtime;
    updatePreparation = {
      operationId: command.operationId,
      generation: command.generation,
      ready: false,
    };
    void activeRuntime.prepareForUpdate(command.operationId).then(
      (result) => {
        if (
          runtime !== activeRuntime
          || updatePreparation?.operationId !== command.operationId
          || updatePreparation.generation !== command.generation
        ) return;
        if (result.ready) {
          updatePreparation.ready = true;
        } else {
          lastReleasedUpdatePreparation = updatePreparation;
          updatePreparation = null;
        }
        post({
          type: "runtime.prepare-update-result",
          operationId: command.operationId,
          generation: command.generation,
          ...result,
        });
      },
      () => {
        if (
          runtime !== activeRuntime
          || updatePreparation?.operationId !== command.operationId
          || updatePreparation.generation !== command.generation
        ) return;
        activeRuntime.releaseUpdatePreparation(command.operationId);
        lastReleasedUpdatePreparation = updatePreparation;
        updatePreparation = null;
        post({
          type: "runtime.prepare-update-result",
          operationId: command.operationId,
          generation: command.generation,
          ready: false,
          blocker: "runtime-operation",
        });
      },
    );
    return;
  }
  if (command.type === "runtime.resolve-project-path") {
    if (!runtime || stopping || updatePreparation) {
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
  if (command.type === "runtime.database-recovery-cancel") {
    const key = recoveryOperationKey(command.generation, command.operationId);
    if (!databaseRecoveryOperations.cancel(key)) {
      const receipt = databaseRecoveryReceipts.find(key, command.operation);
      if (receipt) {
        post(receipt);
      } else if (databaseRecoveryReceipts.has(key)) {
        post({
          type: "runtime.database-recovery-result",
          operationId: command.operationId,
          generation: command.generation,
          operation: command.operation,
          ok: false,
          cancelled: false,
          message: "The database recovery operation identity conflicts with a completed operation.",
        });
      } else {
        postDatabaseRecoveryResult({
          type: "runtime.database-recovery-result",
          operationId: command.operationId,
          generation: command.generation,
          operation: command.operation,
          ok: false,
          cancelled: true,
          message: "The database recovery operation is no longer active.",
        });
      }
    }
    return;
  }
  if (command.type === "runtime.database-recovery") {
    const key = recoveryOperationKey(command.generation, command.operationId);
    const receipt = databaseRecoveryReceipts.find(key, command.operation);
    if (receipt) {
      post(receipt);
      return;
    }
    if (databaseRecoveryReceipts.has(key)) {
      post({
        type: "runtime.database-recovery-result",
        operationId: command.operationId,
        generation: command.generation,
        operation: command.operation,
        ok: false,
        cancelled: false,
        message: "The database recovery operation identity conflicts with a completed operation.",
      });
      return;
    }
    const activeOperation = activeDatabaseRecoveryOperations.get(key);
    if (activeOperation) {
      if (activeOperation !== command.operation) {
        post({
          type: "runtime.database-recovery-result",
          operationId: command.operationId,
          generation: command.generation,
          operation: command.operation,
          ok: false,
          cancelled: false,
          message: "The database recovery operation identity is already active.",
        });
      }
      return;
    }
    if (!runtime || stopping || updatePreparation) {
      postDatabaseRecoveryResult({
        type: "runtime.database-recovery-result",
        operationId: command.operationId,
        generation: command.generation,
        operation: command.operation,
        ok: false,
        cancelled: false,
        message: "The local runtime is not ready.",
      });
      return;
    }
    const currentRuntime = runtime;
    activeDatabaseRecoveryOperations.set(key, command.operation);
    const operation = databaseRecoveryOperations.enqueue(
      key,
      async (signal) => {
        if (runtime !== currentRuntime || stopping) {
          throw new Error("The local runtime is not ready.");
        }
        return command.operation === "export"
          ? currentRuntime.exportRecoveryData(command.path, signal).then(() => null)
          : currentRuntime.importRecoveryData(
              command.path,
              command.targetDirectory!,
              signal,
              command.operationId,
            );
      },
    );
    void operation.then(
      (summary) => {
        if (stopping) return;
        activeDatabaseRecoveryOperations.delete(key);
        postDatabaseRecoveryResult({
          type: "runtime.database-recovery-result",
          operationId: command.operationId,
          generation: command.generation,
          operation: command.operation,
          ok: true,
          summary,
        });
      },
      (error: unknown) => {
        if (stopping) return;
        activeDatabaseRecoveryOperations.delete(key);
        const detail = error instanceof Error
          ? error.message.trim().replace(/\s+/gu, " ").slice(0, 1_000)
          : "";
        postDatabaseRecoveryResult({
          type: "runtime.database-recovery-result",
          operationId: command.operationId,
          generation: command.generation,
          operation: command.operation,
          ok: false,
          cancelled: error instanceof DatabaseRecoveryOperationCancelledError,
          message: detail || "The database recovery operation failed.",
        });
      },
    );
    return;
  }
  if (command.type === "runtime.private-connect-forget") {
    if (!updatePreparation) runtime?.forgetPrivateConnectTranscripts(command.scope);
    return;
  }
  if (command.type === "runtime.private-connect-request") {
    if (!runtime || stopping || updatePreparation) {
      post({
        type: "runtime.private-connect-response",
        requestId: command.requestId,
        response: {
          type: "response",
          requestId: command.requestId,
          ok: false,
          code: "unavailable",
          message: "The local runtime is not ready.",
        },
      });
      return;
    }
    void runtime.privateConnectRequest(command.subject, command.request).then(
      (response) => post({
        type: "runtime.private-connect-response",
        requestId: command.requestId,
        response,
      }),
      () => post({
        type: "runtime.private-connect-response",
        requestId: command.requestId,
        response: {
          type: "response",
          requestId: command.requestId,
          ok: false,
          code: "unavailable",
          message: "The local runtime could not complete the remote request.",
        },
      }),
    );
    return;
  }
  if (command.type === "runtime.private-connect-prompt-prepare") {
    if (!runtime || stopping || updatePreparation) {
      post({
        type: "runtime.private-connect-prompt-result",
        operationId: command.operationId,
        requestId: command.request.requestId,
        phase: "prepare",
        preparationId: null,
        response: {
          type: "response",
          requestId: command.request.requestId,
          ok: false,
          code: "unavailable",
          message: "The local runtime is not ready.",
        },
      });
      return;
    }
    void runtime.preparePrivateConnectPrompt(command.subject, command.request).then(
      (result) => post(
        "preparationId" in result
          ? {
              type: "runtime.private-connect-prompt-result",
              operationId: command.operationId,
              requestId: command.request.requestId,
              phase: "prepare",
              preparationId: result.preparationId,
              response: null,
            }
          : {
              type: "runtime.private-connect-prompt-result",
              operationId: command.operationId,
              requestId: command.request.requestId,
              phase: "prepare",
              preparationId: null,
              response: result,
            },
      ),
      () => post({
        type: "runtime.private-connect-prompt-result",
        operationId: command.operationId,
        requestId: command.request.requestId,
        phase: "prepare",
        preparationId: null,
        response: {
          type: "response",
          requestId: command.request.requestId,
          ok: false,
          code: "unavailable",
          message: "The local runtime could not prepare the Private Connect prompt.",
        },
      }),
    );
    return;
  }
  if (command.type === "runtime.private-connect-prompt-commit") {
    const response = runtime && !stopping && !updatePreparation
      ? runtime.commitPrivateConnectPrompt(
          command.subject,
          command.request,
          command.preparationId,
        )
      : {
          type: "response" as const,
          requestId: command.request.requestId,
          ok: false as const,
          code: "unavailable" as const,
          message: "The local runtime is not ready.",
        };
    post({
      type: "runtime.private-connect-prompt-result",
      operationId: command.operationId,
      requestId: command.request.requestId,
      phase: "commit",
      preparationId: null,
      response,
    });
    return;
  }
  if (starting || runtime || stopping) {
    post({ type: "runtime.startup-failed", message: "The runtime was asked to start more than once." });
    void shutdown(1);
    return;
  }
  starting = true;
  runtimeGeneration = Number(command.options.runtimeGenerationId.split(":")[1]);
  updatePreparation = null;
  lastReleasedUpdatePreparation = null;
  try {
    activateRuntimeOwnedProcessRegistry(
      command.options.dataDirectory,
      command.options.runtimeGenerationId,
      command.options.systemBootId,
    );
  } catch (error) {
    starting = false;
    post({
      type: "runtime.startup-failed",
      message: error instanceof Error
        ? error.message
        : "Runtime process ownership could not be initialized.",
    });
    void shutdown(1);
    return;
  }
  void startRuntime({
    ...command.options,
    onCleanupReceiptConsumed: (
      receiptRuntimeGenerationId,
      currentRuntimeGenerationId,
    ) => post({
      type: "runtime.cleanup-receipt-consumed",
      receiptRuntimeGenerationId,
      currentRuntimeGenerationId,
    }),
    backendCredentials: credentials,
    attachments,
    conversationAttachmentStoreOperations: conversationAttachmentStore.runner,
    secureFiles,
    agentBrowser,
  }).then(async (startedRuntime) => {
    starting = false;
    if (stopping) {
      await finishShutdown(startedRuntime, shutdownExitCode);
      return;
    }
    runtime = startedRuntime;
    post({
      type: "runtime.ready",
      websocketUrl: startedRuntime.websocketUrl,
      databaseRecovery: startedRuntime.databaseRecovery,
    });
    if (command.options.packageSmokePdf) {
      packageSmokePdfController = new AbortController();
      packageSmokePdfOperation = runPackagedPdfSmoke(
        command.options.packageSmokePdf.inputPath,
        command.options.packageSmokePdf.resultPath,
        packageSmokePdfController.signal,
      ).catch(() => undefined).finally(() => {
        packageSmokePdfController = null;
        packageSmokePdfOperation = null;
      });
    }
    if (command.options.packageSmokeImage) {
      packageSmokeImageController = new AbortController();
      packageSmokeImageOperation = (startedRuntime.runPackageSmokeImage?.(
        command.options.packageSmokeImage.inputPath,
        command.options.packageSmokeImage.resultPath,
        packageSmokeImageController.signal,
      ) ?? Promise.reject(new Error(
        "The packaged image retention smoke is unavailable.",
      ))).catch(() => undefined).finally(() => {
        packageSmokeImageController = null;
        packageSmokeImageOperation = null;
      });
    }
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
