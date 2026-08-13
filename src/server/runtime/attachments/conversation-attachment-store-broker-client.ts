import { randomUUID } from "node:crypto";

import {
  encodeConversationAttachmentStoreOperation,
  type ConversationAttachmentStoreOperation,
  type ConversationAttachmentStoreAnyOperationRunner,
  type ConversationAttachmentStoreReadOperation,
  type ConversationAttachmentStoreReadReceipt,
} from "../../../node/conversation-attachment-store-child.js";
import type {
  RuntimeConversationAttachmentStoreResult,
  RuntimeWorkerEvent,
} from "../../../node/runtime-process-protocol.js";

const REQUEST_TIMEOUT_MS = 36_000;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_METADATA_BYTES = 4 * 1024;

type StoreOperation = ConversationAttachmentStoreOperation
  | ConversationAttachmentStoreReadOperation;

interface PendingOperation {
  readonly operation: StoreOperation["operation"];
  readonly timer: NodeJS.Timeout;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | null;
  readonly resolveResult: (
    value: void | ConversationAttachmentStoreReadReceipt,
  ) => void;
  readonly rejectResult: (error: Error) => void;
  readonly resolveStopped: () => void;
  readonly rejectStopped: (error: Error) => void;
  readonly resolveReady: (observed: boolean) => void;
  resultSettled: boolean;
}

function unavailable(message: string): Error {
  return new Error(message);
}

function parseReceipt(
  value: string | null,
): ConversationAttachmentStoreReadReceipt | null {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const receipt = parsed as Record<string, unknown>;
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

export class RuntimeConversationAttachmentStoreBrokerClient {
  private readonly pending = new Map<string, PendingOperation>();
  private closed = false;

  constructor(
    private readonly post: (event: RuntimeWorkerEvent) => void,
    private readonly timeoutMs = REQUEST_TIMEOUT_MS,
  ) {}

  readonly runner: ConversationAttachmentStoreAnyOperationRunner = ((
    operation: StoreOperation,
    signal?: AbortSignal,
  ) => {
    let resolveResult!: (
      value: void | ConversationAttachmentStoreReadReceipt,
    ) => void;
    let rejectResult!: (error: Error) => void;
    let resolveStopped!: () => void;
    let rejectStopped!: (error: Error) => void;
    let resolveReady!: (observed: boolean) => void;
    const result = new Promise<void | ConversationAttachmentStoreReadReceipt>((
      resolve,
      reject,
    ) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const stopped = new Promise<void>((resolve, reject) => {
      resolveStopped = resolve;
      rejectStopped = reject;
    });
    const ready = new Promise<boolean>((resolve) => { resolveReady = resolve; });
    if (this.closed || signal?.aborted) {
      const error = unavailable(signal?.aborted
        ? "Conversation attachment retention was cancelled."
        : "Conversation attachment storage is unavailable.");
      rejectResult(error);
      resolveStopped();
      resolveReady(false);
      return { result, stopped, ready };
    }
    const requestId = randomUUID();
    const onAbort = (): void => {
      const pending = this.pending.get(requestId);
      if (!pending) return;
      if (!pending.resultSettled) {
        pending.resultSettled = true;
        pending.rejectResult(unavailable(
          "Conversation attachment retention was cancelled.",
        ));
      }
      this.postCancel(requestId);
    };
    const timer = setTimeout(() => {
      const pending = this.pending.get(requestId);
      if (!pending) return;
      if (!pending.resultSettled) {
        pending.resultSettled = true;
        pending.rejectResult(unavailable(
          "Conversation attachment storage did not respond in time.",
        ));
      }
      this.postCancel(requestId);
    }, Math.max(1, Math.min(Math.trunc(this.timeoutMs), 60_000)));
    timer.unref();
    this.pending.set(requestId, {
      operation: operation.operation,
      timer,
      signal,
      onAbort,
      resolveResult,
      rejectResult,
      resolveStopped,
      rejectStopped,
      resolveReady,
      resultSettled: false,
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      this.post({
        type: "runtime.conversation-attachment-store-request",
        requestId,
        encodedOperation: encodeConversationAttachmentStoreOperation(operation),
      });
    } catch (error) {
      this.finish(requestId, unavailable(
        error instanceof Error
          ? error.message
          : "Conversation attachment operation could not be delivered.",
      ));
    }
    return { result, stopped, ready };
  }) as ConversationAttachmentStoreAnyOperationRunner;

  handle(event: RuntimeConversationAttachmentStoreResult): boolean {
    const pending = this.pending.get(event.requestId);
    if (!pending) return false;
    if (!event.shutdownConfirmed) {
      this.finish(
        event.requestId,
        unavailable(event.message),
        undefined,
        false,
      );
      return true;
    }
    if (!event.ok) {
      this.finish(event.requestId, unavailable(event.message));
      return true;
    }
    if (pending.operation === "read") {
      const receipt = parseReceipt(event.encodedReceipt);
      this.finish(
        event.requestId,
        receipt
          ? undefined
          : unavailable("Conversation attachment storage returned an invalid read receipt."),
        receipt ?? undefined,
      );
      return true;
    }
    this.finish(
      event.requestId,
      event.encodedReceipt === null
        ? undefined
        : unavailable("Conversation attachment storage returned an invalid receipt."),
    );
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      if (pending.onAbort) {
        pending.signal?.removeEventListener("abort", pending.onAbort);
      }
      if (!pending.resultSettled) {
        pending.resultSettled = true;
        pending.rejectResult(unavailable(
          "Conversation attachment storage stopped.",
        ));
      }
      // Do not resolve `stopped` here. Only main can confirm the utility
      // process exited, and runtime shutdown must remain unconfirmed if that
      // correlated result never arrives.
      this.postCancel(requestId);
    }
  }

  private postCancel(requestId: string): void {
    try {
      this.post({
        type: "runtime.conversation-attachment-store-cancel",
        requestId,
      });
    } catch {
      this.finish(
        requestId,
        unavailable("Conversation attachment storage shutdown could not be confirmed."),
        undefined,
        false,
      );
    }
  }

  private finish(
    requestId: string,
    error?: Error,
    receipt?: ConversationAttachmentStoreReadReceipt,
    shutdownConfirmed = true,
  ): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (pending.onAbort) {
      pending.signal?.removeEventListener("abort", pending.onAbort);
    }
    pending.resolveReady(false);
    if (shutdownConfirmed) pending.resolveStopped();
    else pending.rejectStopped(unavailable(
      "Conversation attachment storage shutdown could not be confirmed.",
    ));
    if (pending.resultSettled) return;
    pending.resultSettled = true;
    if (error) pending.rejectResult(error);
    else pending.resolveResult(receipt);
  }
}
