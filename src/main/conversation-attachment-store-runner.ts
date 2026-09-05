import { randomUUID } from "node:crypto";

import type { UtilityProcess } from "electron";

import type {
  ConversationAttachmentStoreOperation,
  ConversationAttachmentStoreAnyOperationRunner,
  ConversationAttachmentStoreReadOperation,
  ConversationAttachmentStoreReadReceipt,
} from "../node/conversation-attachment-store-child.js";
import {
  encodeConversationAttachmentStoreOperation,
} from "../node/conversation-attachment-store-child.js";
import {
  parseConversationAttachmentStoreWorkerEvent,
  type ConversationAttachmentStoreWorkerRequest,
} from "./conversation-attachment-store-worker-protocol.js";

const STORE_OPERATION_TIMEOUT_MS = 30_000;
const STORE_OPERATION_KILL_GRACE_MS = 3_000;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_METADATA_BYTES = 4 * 1024;
const MAX_ACTIVE_OPERATIONS = 4;
const MAX_PENDING_OPERATIONS = 64;

type StoreOperation = ConversationAttachmentStoreOperation
  | ConversationAttachmentStoreReadOperation;

interface StoreExecution {
  readonly result: Promise<void | ConversationAttachmentStoreReadReceipt>;
  readonly stopped: Promise<void>;
  readonly termination: Promise<void>;
  readonly ready: Promise<boolean>;
}

export interface ConversationAttachmentStoreUtilityRunnerOptions {
  spawn(cwd: string): UtilityProcess;
  timeoutMs?: number;
  killGraceMs?: number;
  maxActiveOperations?: number;
  maxPendingOperations?: number;
}

function cancelled(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("Conversation attachment retention was cancelled.");
}

function parseReadReceipt(value: unknown): ConversationAttachmentStoreReadReceipt | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const receipt = value as Record<string, unknown>;
  if (receipt.missing === true && Object.keys(receipt).length === 1) {
    return { missing: true };
  }
  if (
    receipt.missing !== false
    || Object.keys(receipt).length !== 3
    || typeof receipt.metadata !== "string"
    || Buffer.byteLength(receipt.metadata, "utf8") > MAX_METADATA_BYTES
    || typeof receipt.bytesBase64 !== "string"
  ) return null;
  const bytes = Buffer.from(receipt.bytesBase64, "base64");
  if (
    bytes.length < 1
    || bytes.length > MAX_ATTACHMENT_BYTES
    || bytes.toString("base64") !== receipt.bytesBase64
  ) return null;
  return {
    missing: false,
    metadata: receipt.metadata,
    bytes,
  };
}

export function createConversationAttachmentStoreUtilityRunner(
  options: ConversationAttachmentStoreUtilityRunnerOptions,
): ConversationAttachmentStoreAnyOperationRunner {
  const timeoutMs = Math.max(
    1,
    Math.min(Math.trunc(options.timeoutMs ?? STORE_OPERATION_TIMEOUT_MS), 60_000),
  );
  const killGraceMs = Math.max(
    1,
    Math.min(
      Math.trunc(options.killGraceMs ?? STORE_OPERATION_KILL_GRACE_MS),
      10_000,
    ),
  );
  const maxActiveOperations = Math.max(
    1,
    Math.min(Math.trunc(options.maxActiveOperations ?? MAX_ACTIVE_OPERATIONS), 16),
  );
  const maxPendingOperations = Math.max(
    0,
    Math.min(Math.trunc(options.maxPendingOperations ?? MAX_PENDING_OPERATIONS), 256),
  );
  function runNow(
    operation: StoreOperation,
    signal?: AbortSignal,
  ): StoreExecution {
    const operationId = randomUUID();
    let resolveStopped!: () => void;
    let rejectStopped!: (error: Error) => void;
    let resolveTermination!: () => void;
    let resolveReady!: (observed: boolean) => void;
    const stopped = new Promise<void>((resolve, reject) => {
      resolveStopped = resolve;
      rejectStopped = reject;
    });
    const termination = new Promise<void>((resolve) => {
      resolveTermination = resolve;
    });
    const ready = new Promise<boolean>((resolve) => { resolveReady = resolve; });
    if (signal?.aborted) {
      resolveStopped();
      resolveTermination();
      resolveReady(false);
      return {
        result: Promise.reject(cancelled(signal)),
        stopped,
        termination,
        ready,
      };
    }
    let child: UtilityProcess;
    try {
      child = options.spawn(operation.root);
    } catch (error) {
      resolveStopped();
      resolveTermination();
      resolveReady(false);
      return {
        result: Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        ),
        stopped,
        termination,
        ready,
      };
    }
    const result = new Promise<void | ConversationAttachmentStoreReadReceipt>((
      resolveOperation,
      rejectOperation,
    ) => {
      let reported: { ok: boolean; receipt?: unknown } | null = null;
      let readReady = false;
      let stoppingError: Error | null = null;
      let killGraceTimer: NodeJS.Timeout | null = null;
      let killAccepted = false;
      let exitObserved = false;
      let settled = false;
      let spawned = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        if (killGraceTimer) clearTimeout(killGraceTimer);
        signal?.removeEventListener("abort", onAbort);
      };
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolveReady(readReady);
        if (error) {
          rejectOperation(error);
          return;
        }
        if (!reported?.ok) {
          rejectOperation(new Error(operation.operation === "read"
            ? "Conversation attachment read failed because storage is unsafe."
            : `Conversation attachment ${operation.operation} failed.`));
          return;
        }
        if (operation.operation !== "read") {
          resolveOperation();
          return;
        }
        const receipt = parseReadReceipt(reported.receipt);
        if (!receipt) {
          rejectOperation(new Error(
            "Conversation attachment read returned an invalid receipt.",
          ));
          return;
        }
        resolveOperation(receipt);
      };
      const requestKill = (): void => {
        if (killAccepted || exitObserved) return;
        killAccepted = child.kill();
      };
      const stop = (error: Error): void => {
        if (settled) return;
        stoppingError ??= error;
        requestKill();
        if (killGraceTimer) return;
        killGraceTimer = setTimeout(() => {
          const unconfirmed = new Error(
            "Conversation attachment utility shutdown is unconfirmed.",
          );
          rejectStopped(unconfirmed);
          settle(stoppingError ?? error);
        }, killGraceMs);
        killGraceTimer.unref();
      };
      const onAbort = (): void => stop(cancelled(signal));
      const timer = setTimeout(() => {
        stop(new Error("Conversation attachment persistence timed out."));
      }, timeoutMs);
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
      child.once("spawn", () => {
        spawned = true;
        if (stoppingError) {
          requestKill();
          return;
        }
        if (signal?.aborted) {
          onAbort();
          return;
        }
        try {
          child.postMessage({
            type: "conversation-attachment-store.perform",
            operationId,
            encodedOperation: encodeConversationAttachmentStoreOperation(
              operation,
            ),
          } satisfies ConversationAttachmentStoreWorkerRequest);
        } catch {
          stop(new Error("Conversation attachment operation could not be delivered."));
        }
      });
      child.on("message", (value) => {
        if (!spawned) {
          stop(new Error("Conversation attachment operation returned a result before startup."));
          return;
        }
        const event = parseConversationAttachmentStoreWorkerEvent(value);
        if (!event || event.operationId !== operationId || reported) {
          stop(new Error("Conversation attachment operation returned an invalid result."));
          return;
        }
        if (event.type === "conversation-attachment-store.ready") {
          if (readReady || operation.operation !== "read") {
            stop(new Error("Conversation attachment operation returned an invalid result."));
            return;
          }
          readReady = true;
          resolveReady(true);
          return;
        }
        reported = event;
        try {
          child.postMessage({
            type: "conversation-attachment-store.result-ack",
            operationId,
          } satisfies ConversationAttachmentStoreWorkerRequest);
        } catch {
          stop(new Error(
            "Conversation attachment operation acknowledgement could not be delivered.",
          ));
        }
      });
      child.once("error", () => {
        stop(new Error("Conversation attachment operation stopped unexpectedly."));
      });
      (child as unknown as {
        once(
          event: "exit",
          listener: (code: number, signal?: string) => void,
        ): void;
      }).once("exit", (code, signal) => {
        exitObserved = true;
        resolveTermination();
        if (killGraceTimer) clearTimeout(killGraceTimer);
        resolveStopped();
        const expectedExit = reported?.ok === true ? code === 0 : code === 1;
        settle(stoppingError ?? (
          expectedExit && !signal
            ? undefined
            : new Error("Conversation attachment operation stopped unexpectedly.")
        ));
      });
    });
    return { result, stopped, termination, ready };
  }
  interface QueuedOperation {
    readonly operation: StoreOperation;
    readonly signal: AbortSignal | undefined;
    readonly resolveResult: (
      value: void | ConversationAttachmentStoreReadReceipt,
    ) => void;
    readonly rejectResult: (error: Error) => void;
    readonly resolveStopped: () => void;
    readonly rejectStopped: (error: Error) => void;
    readonly resolveTermination: () => void;
    readonly resolveReady: (observed: boolean) => void;
    readonly onAbort: () => void;
  }
  let activeOperations = 0;
  let poisonError: Error | null = null;
  const queued: QueuedOperation[] = [];
  const activeControllers = new Set<AbortController>();
  const failQueued = (next: QueuedOperation, error: Error): void => {
    next.signal?.removeEventListener("abort", next.onAbort);
    next.rejectResult(error);
    next.rejectStopped(error);
    next.resolveTermination();
    next.resolveReady(false);
  };
  const poison = (): Error => {
    poisonError ??= new Error(
      "Conversation attachment utility shutdown is unconfirmed.",
    );
    for (const next of queued.splice(0)) failQueued(next, poisonError);
    for (const controller of activeControllers) {
      controller.abort(poisonError);
    }
    return poisonError;
  };
  const pump = (): void => {
    while (
      !poisonError
      && activeOperations < maxActiveOperations
      && queued.length > 0
    ) {
      const next = queued.shift();
      if (!next) return;
      next.signal?.removeEventListener("abort", next.onAbort);
      if (next.signal?.aborted) {
        next.rejectResult(cancelled(next.signal));
        next.resolveStopped();
        next.resolveTermination();
        next.resolveReady(false);
        continue;
      }
      activeOperations += 1;
      const controller = new AbortController();
      activeControllers.add(controller);
      const signal = next.signal
        ? AbortSignal.any([next.signal, controller.signal])
        : controller.signal;
      const running = runNow(next.operation, signal);
      void running.result.then(next.resolveResult, next.rejectResult);
      void running.ready.then(next.resolveReady);
      void running.stopped.then(
        next.resolveStopped,
        () => next.rejectStopped(poison()),
      ).finally(() => {
        activeControllers.delete(controller);
        activeOperations -= 1;
        pump();
      });
      void running.termination.then(next.resolveTermination);
    }
  };
  const run = (
    operation: StoreOperation,
    signal?: AbortSignal,
  ): StoreExecution => {
    let resolveResult!: (
      value: void | ConversationAttachmentStoreReadReceipt,
    ) => void;
    let rejectResult!: (error: Error) => void;
    let resolveStopped!: () => void;
    let rejectStopped!: (error: Error) => void;
    let resolveTermination!: () => void;
    let resolveReady!: (observed: boolean) => void;
    const result = new Promise<void | ConversationAttachmentStoreReadReceipt>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const stopped = new Promise<void>((resolve, reject) => {
      resolveStopped = resolve;
      rejectStopped = reject;
    });
    const termination = new Promise<void>((resolve) => {
      resolveTermination = resolve;
    });
    const ready = new Promise<boolean>((resolve) => { resolveReady = resolve; });
    const failWithoutSpawn = (error: Error): void => {
      rejectResult(error);
      resolveStopped();
      resolveTermination();
      resolveReady(false);
    };
    if (signal?.aborted) {
      failWithoutSpawn(cancelled(signal));
      return { result, stopped, termination, ready };
    }
    if (poisonError) {
      rejectResult(poisonError);
      rejectStopped(poisonError);
      resolveTermination();
      resolveReady(false);
      return { result, stopped, termination, ready };
    }
    if (
      activeOperations >= maxActiveOperations
      && queued.length >= maxPendingOperations
    ) {
      failWithoutSpawn(new Error(
        "Conversation attachment storage is at its bounded capacity.",
      ));
      return { result, stopped, termination, ready };
    }
    let entry!: QueuedOperation;
    const onAbort = (): void => {
      const index = queued.indexOf(entry);
      if (index < 0) return;
      queued.splice(index, 1);
      failWithoutSpawn(cancelled(signal));
    };
    entry = {
      operation,
      signal,
      resolveResult,
      rejectResult,
      resolveStopped,
      rejectStopped,
      resolveTermination,
      resolveReady,
      onAbort,
    };
    queued.push(entry);
    signal?.addEventListener("abort", onAbort, { once: true });
    pump();
    return { result, stopped, termination, ready };
  };
  return run as ConversationAttachmentStoreAnyOperationRunner;
}
