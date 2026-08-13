import type {
  RuntimeSecureFileResult,
  RuntimeWorkerCommand,
  RuntimeWorkerEvent,
} from "../node/runtime-process-protocol.js";
import type {
  RuntimeProcessRecord,
  RuntimeSecureFileBroker,
} from "./runtime-supervisor-types.js";
import type {
  ConversationAttachmentStoreAnyOperationRunner,
  ConversationAttachmentStoreAuthority,
} from "../node/conversation-attachment-store-child.js";
import { RuntimeConversationAttachmentStoreCoordinator } from "./runtime-conversation-attachment-store-coordinator.js";

type SecureFileRequestEvent = Extract<
  RuntimeWorkerEvent,
  { type: "runtime.secure-file-request" }
>;
type ConversationAttachmentStoreEvent = Extract<
  RuntimeWorkerEvent,
  {
    type:
      | "runtime.conversation-attachment-store-request"
      | "runtime.conversation-attachment-store-cancel";
  }
>;

interface PendingSecureFileRequest {
  readonly record: RuntimeProcessRecord;
  readonly controller: AbortController;
}

interface RuntimeSecureFileCoordinatorOptions {
  readonly broker?: RuntimeSecureFileBroker;
  readonly conversationAttachmentStoreRunner?: ConversationAttachmentStoreAnyOperationRunner;
  readonly conversationAttachmentStoreAuthority?: ConversationAttachmentStoreAuthority;
  readonly accepts: (record: RuntimeProcessRecord) => boolean;
  readonly post: (
    record: RuntimeProcessRecord,
    result: RuntimeWorkerCommand,
  ) => void;
}

export class RuntimeSecureFileCoordinator {
  private readonly broker?: RuntimeSecureFileBroker;
  private readonly accepts: RuntimeSecureFileCoordinatorOptions["accepts"];
  private readonly post: RuntimeSecureFileCoordinatorOptions["post"];
  private readonly pending = new Map<string, PendingSecureFileRequest>();
  private readonly conversationAttachmentStore:
    RuntimeConversationAttachmentStoreCoordinator;

  constructor(options: RuntimeSecureFileCoordinatorOptions) {
    this.broker = options.broker;
    this.accepts = options.accepts;
    this.post = options.post;
    this.conversationAttachmentStore =
      new RuntimeConversationAttachmentStoreCoordinator({
        runner: options.conversationAttachmentStoreRunner,
        authority: options.conversationAttachmentStoreAuthority,
        accepts: options.accepts,
        post: options.post,
      });
  }

  handle(
    record: RuntimeProcessRecord,
    event: SecureFileRequestEvent | ConversationAttachmentStoreEvent,
  ): void {
    if (event.type !== "runtime.secure-file-request") {
      this.conversationAttachmentStore.handle(record, event);
      return;
    }
    if (!this.accepts(record) || !this.broker) {
      this.reply(record, event.requestId, {
        ok: false,
        code: "unavailable",
        message: "The secure file service is unavailable.",
      });
      return;
    }
    if (record.secureFileRequestIds.has(event.requestId)) {
      this.reply(record, event.requestId, {
        ok: false,
        code: "invalid",
        message: "The secure file request identifier was already used.",
      });
      return;
    }
    record.secureFileRequestIds.add(event.requestId);
    if (record.secureFileRequestIds.size > 512) {
      const oldest = record.secureFileRequestIds.values().next().value;
      if (typeof oldest === "string") record.secureFileRequestIds.delete(oldest);
    }
    const controller = new AbortController();
    const pending = { record, controller };
    this.pending.set(event.requestId, pending);
    const { type: _type, requestId: _requestId, ...request } = event;
    void this.broker.perform(request, controller.signal).then(
      (result) => {
        if (this.pending.get(event.requestId) !== pending) return;
        this.pending.delete(event.requestId);
        if (this.accepts(record)) this.reply(record, event.requestId, result);
      },
      () => {
        if (this.pending.get(event.requestId) !== pending) return;
        this.pending.delete(event.requestId);
        if (this.accepts(record)) {
          this.reply(record, event.requestId, {
            ok: false,
            code: "unavailable",
            message: "The secure file operation could not be completed.",
          });
        }
      },
    );
  }

  clear(record: RuntimeProcessRecord | null): void {
    this.conversationAttachmentStore.clear(record);
    if (!record) return;
    for (const [requestId, pending] of this.pending) {
      if (pending.record !== record) continue;
      this.pending.delete(requestId);
      pending.controller.abort();
    }
  }

  hasConversationAttachmentOperations(record: RuntimeProcessRecord | null): boolean {
    return this.conversationAttachmentStore.hasOperations(record);
  }

  drain(
    record: RuntimeProcessRecord | null,
    suppressReplies = false,
  ): Promise<boolean> {
    return this.conversationAttachmentStore.drain(record, suppressReplies);
  }

  async shutdown(): Promise<boolean> {
    const [secureFiles, conversationAttachments] = await Promise.all([
      this.broker?.shutdown?.() ?? Promise.resolve(true),
      this.conversationAttachmentStore.shutdown(),
    ]);
    return secureFiles && conversationAttachments;
  }

  private reply(
    record: RuntimeProcessRecord,
    requestId: string,
    result: RuntimeSecureFileResult["result"],
  ): void {
    this.post(record, { type: "runtime.secure-file-result", requestId, result });
  }
}
