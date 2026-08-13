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

type StoreOperation = ConversationAttachmentStoreOperation
  | ConversationAttachmentStoreReadOperation;

export interface ConversationAttachmentStoreUtilityRunnerOptions {
  spawn(cwd: string): UtilityProcess;
  timeoutMs?: number;
  killGraceMs?: number;
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
  function run(
    operation: StoreOperation,
    signal?: AbortSignal,
  ): {
    readonly result: Promise<void | ConversationAttachmentStoreReadReceipt>;
    readonly stopped: Promise<void>;
    readonly ready: Promise<boolean>;
  } {
    let resolveStopped!: () => void;
    let rejectStopped!: (error: Error) => void;
    let resolveReady!: (observed: boolean) => void;
    const stopped = new Promise<void>((resolve, reject) => {
      resolveStopped = resolve;
      rejectStopped = reject;
    });
    const ready = new Promise<boolean>((resolve) => { resolveReady = resolve; });
    if (signal?.aborted) {
      resolveStopped();
      resolveReady(false);
      return { result: Promise.reject(cancelled(signal)), stopped, ready };
    }
    let child: UtilityProcess;
    try {
      child = options.spawn(operation.root);
    } catch (error) {
      resolveStopped();
      resolveReady(false);
      return {
        result: Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        ),
        stopped,
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
      let settled = false;
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
      const stop = (error: Error): void => {
        if (stoppingError || settled) return;
        stoppingError = error;
        child.kill();
        killGraceTimer = setTimeout(() => {
          const unconfirmed = new Error(
            "Conversation attachment utility shutdown is unconfirmed.",
          );
          rejectStopped(unconfirmed);
          settle(error);
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
        if (stoppingError || signal?.aborted) {
          onAbort();
          return;
        }
        try {
          child.postMessage({
            type: "conversation-attachment-store.perform",
            encodedOperation: encodeConversationAttachmentStoreOperation(
              operation,
            ),
          } satisfies ConversationAttachmentStoreWorkerRequest);
        } catch {
          stop(new Error("Conversation attachment operation could not be delivered."));
        }
      });
      child.on("message", (value) => {
        const event = parseConversationAttachmentStoreWorkerEvent(value);
        if (!event || reported) {
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
      });
      child.once("error", () => {
        stop(new Error("Conversation attachment operation stopped unexpectedly."));
      });
      child.once("exit", () => {
        if (killGraceTimer) clearTimeout(killGraceTimer);
        resolveStopped();
        settle(stoppingError ?? undefined);
      });
    });
    return { result, stopped, ready };
  }
  return run as ConversationAttachmentStoreAnyOperationRunner;
}
