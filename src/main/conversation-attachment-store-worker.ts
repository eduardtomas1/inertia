import { createRequire } from "node:module";

import {
  CONVERSATION_ATTACHMENT_STORE_OPERATION_SOURCE,
} from "../node/conversation-attachment-store-child.js";
import {
  parseConversationAttachmentStoreWorkerRequest,
  type ConversationAttachmentStoreWorkerEvent,
} from "./conversation-attachment-store-worker-protocol.js";

type StoreOperationExecutor = (
  operation: unknown,
  onReadReady?: () => void,
) => Promise<unknown>;

// This compiles only the checked-in static source shared with the standalone
// Node helper. No message or filesystem content can contribute executable
// text; using one source preserves identical containment checks in both hosts.
const compileStoreOperation = new Function(
  "require",
  `${CONVERSATION_ATTACHMENT_STORE_OPERATION_SOURCE}\n`
    + "return performConversationAttachmentStoreOperation;",
) as (require: NodeJS.Require) => StoreOperationExecutor;
const performStoreOperation = compileStoreOperation(createRequire(import.meta.url));
const parentPort = process.parentPort;

if (parentPort) {
  parentPort.once("message", (event) => {
    const request = parseConversationAttachmentStoreWorkerRequest(event.data);
    if (!request || request.type !== "conversation-attachment-store.perform") {
      process.exit(1);
      return;
    }
    const finish = (
      result: ConversationAttachmentStoreWorkerEvent,
      exitCode: number,
    ): void => {
      parentPort.once("message", (acknowledgement) => {
        const ack = parseConversationAttachmentStoreWorkerRequest(
          acknowledgement.data,
        );
        process.exit(
          ack?.type === "conversation-attachment-store.result-ack"
              && ack.operationId === request.operationId
            ? exitCode
            : 1,
        );
      });
      parentPort.postMessage(result);
    };
    let operation: unknown;
    try {
      operation = JSON.parse(request.encodedOperation);
    } catch {
      operation = null;
    }
    void performStoreOperation(operation, () => {
      parentPort.postMessage({
        type: "conversation-attachment-store.ready",
        operationId: request.operationId,
      } satisfies ConversationAttachmentStoreWorkerEvent);
    }).then(
      (receipt) => {
        finish({
          type: "conversation-attachment-store.result",
          operationId: request.operationId,
          ok: true,
          ...(receipt === undefined ? {} : { receipt }),
        } satisfies ConversationAttachmentStoreWorkerEvent, 0);
      },
      () => {
        finish({
          type: "conversation-attachment-store.result",
          operationId: request.operationId,
          ok: false,
        } satisfies ConversationAttachmentStoreWorkerEvent, 1);
      },
    );
  });
}
