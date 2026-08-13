import type {
  ConversationAttachmentStoreOperation,
  ConversationAttachmentStoreAnyOperationRunner,
  ConversationAttachmentStoreAuthority,
  ConversationAttachmentStoreReadOperation,
  ConversationAttachmentStoreReadReceipt,
} from "../node/conversation-attachment-store-child.js";
import {
  decodeConversationAttachmentStoreOperation,
  MAX_CONVERSATION_ATTACHMENT_STORE_OPERATION_BYTES,
} from "../node/conversation-attachment-store-child.js";
import type {
  RuntimeConversationAttachmentStoreResult,
  RuntimeWorkerEvent,
} from "../node/runtime-process-protocol.js";
import type { RuntimeProcessRecord } from "./runtime-supervisor-types.js";

type StoreOperation = ConversationAttachmentStoreOperation
  | ConversationAttachmentStoreReadOperation;

type StoreRequest = Extract<
  RuntimeWorkerEvent,
  { type: "runtime.conversation-attachment-store-request" }
>;
type StoreCancel = Extract<
  RuntimeWorkerEvent,
  { type: "runtime.conversation-attachment-store-cancel" }
>;

interface PendingStoreOperation {
  readonly record: RuntimeProcessRecord;
  readonly controller: AbortController;
  readonly completion: Promise<boolean>;
}

interface RuntimeConversationAttachmentStoreCoordinatorOptions {
  readonly runner?: ConversationAttachmentStoreAnyOperationRunner;
  readonly authority?: ConversationAttachmentStoreAuthority;
  readonly accepts: (record: RuntimeProcessRecord) => boolean;
  readonly post: (
    record: RuntimeProcessRecord,
    result: RuntimeConversationAttachmentStoreResult,
  ) => void;
}

function publicFailure(shutdownConfirmed = true): RuntimeConversationAttachmentStoreResult {
  return {
    type: "runtime.conversation-attachment-store-result",
    requestId: "",
    ok: false,
    shutdownConfirmed,
    message: shutdownConfirmed
      ? "Conversation attachment storage could not complete the operation."
      : "Conversation attachment storage shutdown could not be confirmed.",
  };
}

function authorizedOperation(
  operation: StoreOperation,
  authority: ConversationAttachmentStoreAuthority,
): boolean {
  return operation.root === authority.root
    && operation.rootDev === authority.dev
    && operation.rootIno === authority.ino
    && operation.rootUid === authority.uid;
}

function encodeReceipt(receipt: ConversationAttachmentStoreReadReceipt): string | null {
  const encoded = JSON.stringify(receipt.missing
    ? { missing: true }
    : {
        missing: false,
        metadata: receipt.metadata,
        bytesBase64: Buffer.from(receipt.bytes).toString("base64"),
      });
  return Buffer.byteLength(encoded, "utf8")
      <= MAX_CONVERSATION_ATTACHMENT_STORE_OPERATION_BYTES
    ? encoded
    : null;
}

/** Main-owned correlation for fuse-safe conversation attachment operations. */
export class RuntimeConversationAttachmentStoreCoordinator {
  private readonly pending = new Map<string, PendingStoreOperation>();
  private readonly usedRequestIds = new WeakMap<RuntimeProcessRecord, Set<string>>();

  constructor(
    private readonly options: RuntimeConversationAttachmentStoreCoordinatorOptions,
  ) {}

  handle(record: RuntimeProcessRecord, event: StoreRequest | StoreCancel): void {
    if (event.type === "runtime.conversation-attachment-store-cancel") {
      const pending = this.pending.get(event.requestId);
      if (pending?.record === record) pending.controller.abort();
      return;
    }
    if (!this.options.accepts(record)) return;
    const used = this.usedRequestIds.get(record) ?? new Set<string>();
    this.usedRequestIds.set(record, used);
    if (used.has(event.requestId) || this.pending.has(event.requestId)) {
      this.reply(record, event.requestId, publicFailure());
      return;
    }
    used.add(event.requestId);
    if (used.size > 512) {
      const oldest = used.values().next().value;
      if (typeof oldest === "string") used.delete(oldest);
    }
    if (!this.options.runner || !this.options.authority) {
      this.reply(record, event.requestId, publicFailure());
      return;
    }
    const operation = decodeConversationAttachmentStoreOperation(
      event.encodedOperation,
    );
    if (!operation) {
      this.reply(record, event.requestId, publicFailure());
      return;
    }
    if (!authorizedOperation(operation, this.options.authority)) {
      this.reply(record, event.requestId, publicFailure());
      return;
    }
    const controller = new AbortController();
    let execution: {
      readonly result: Promise<void | ConversationAttachmentStoreReadReceipt>;
      readonly stopped: Promise<void>;
    };
    try {
      const runner = this.options.runner as (
        operation: StoreOperation,
        signal?: AbortSignal,
      ) => typeof execution;
      execution = runner(operation, controller.signal);
    } catch {
      this.reply(record, event.requestId, publicFailure());
      return;
    }
    // Observe shutdown immediately so a fast helper failure cannot become an
    // unhandled rejection while its operation result is still settling.
    const stopped = execution.stopped.then(() => true, () => false);
    let pending!: PendingStoreOperation;
    const completion = (async (): Promise<boolean> => {
      let receipt: void | ConversationAttachmentStoreReadReceipt;
      let operationSucceeded = false;
      try {
        receipt = await execution.result;
        operationSucceeded = true;
      } catch {
        receipt = undefined;
      }
      const shutdownConfirmed = await stopped;
      if (
        this.pending.get(event.requestId) !== pending
      ) return shutdownConfirmed;
      if (!operationSucceeded || !shutdownConfirmed) {
        this.reply(record, event.requestId, publicFailure(shutdownConfirmed));
        return shutdownConfirmed;
      }
      const encodedReceipt = operation.operation === "read"
        ? encodeReceipt(receipt as ConversationAttachmentStoreReadReceipt)
        : null;
      if (operation.operation === "read" && encodedReceipt === null) {
        this.reply(record, event.requestId, publicFailure());
        return true;
      }
      this.reply(record, event.requestId, {
        type: "runtime.conversation-attachment-store-result",
        requestId: event.requestId,
        ok: true,
        shutdownConfirmed: true,
        encodedReceipt,
      });
      return true;
    })().finally(() => {
      if (this.pending.get(event.requestId) === pending) {
        this.pending.delete(event.requestId);
      }
    });
    pending = { record, controller, completion };
    this.pending.set(event.requestId, pending);
  }

  clear(record: RuntimeProcessRecord | null): void {
    if (!record) return;
    for (const pending of this.pending.values()) {
      if (pending.record === record) pending.controller.abort();
    }
    this.usedRequestIds.delete(record);
  }

  async shutdown(): Promise<boolean> {
    const pending = [...this.pending.values()];
    for (const operation of pending) operation.controller.abort();
    const results = await Promise.all(pending.map((operation) =>
      operation.completion.catch(() => false)));
    return results.every(Boolean);
  }

  private reply(
    record: RuntimeProcessRecord,
    requestId: string,
    result: RuntimeConversationAttachmentStoreResult,
  ): void {
    this.options.post(record, { ...result, requestId });
  }
}
