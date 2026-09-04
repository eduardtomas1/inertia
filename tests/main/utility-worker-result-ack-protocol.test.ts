import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseAttachmentImportWorkerEvent,
  parseAttachmentImportWorkerRequest,
} from "../../src/main/attachment-import-worker-protocol";
import {
  parseConversationAttachmentStoreWorkerEvent,
  parseConversationAttachmentStoreWorkerRequest,
} from "../../src/main/conversation-attachment-store-worker-protocol";

const operationId = "11111111-1111-4111-8111-111111111111";

describe("one-shot utility result acknowledgement protocols", () => {
  it("correlates conversation attachment requests, results, and acknowledgements", () => {
    expect(parseConversationAttachmentStoreWorkerRequest({
      type: "conversation-attachment-store.perform",
      operationId,
      encodedOperation: "{}",
    })).toEqual({
      type: "conversation-attachment-store.perform",
      operationId,
      encodedOperation: "{}",
    });
    expect(parseConversationAttachmentStoreWorkerEvent({
      type: "conversation-attachment-store.result",
      operationId,
      ok: true,
    })).toEqual({
      type: "conversation-attachment-store.result",
      operationId,
      ok: true,
      receipt: undefined,
    });
    expect(parseConversationAttachmentStoreWorkerRequest({
      type: "conversation-attachment-store.result-ack",
      operationId,
    })).toEqual({
      type: "conversation-attachment-store.result-ack",
      operationId,
    });
    expect(parseConversationAttachmentStoreWorkerRequest({
      type: "conversation-attachment-store.result-ack",
      operationId,
      extra: true,
    })).toBeNull();
    expect(parseConversationAttachmentStoreWorkerEvent({
      type: "conversation-attachment-store.result",
      ok: true,
    })).toBeNull();
  });

  it("correlates attachment import requests, results, and acknowledgements", () => {
    const operation = {
      root: resolve("/tmp", "inertia-attachment-import"),
      rootDev: "1",
      rootIno: "2",
      rootUid: "501",
      fileName: "11111111-1111-4111-8111-111111111111.png",
      name: "image.png",
      mimeType: "image/png",
      size: 128,
      stallBeforeValidationMs: 0,
    };
    const receipt = {
      displayName: "image.png",
      mimeType: "image/png",
      extension: "png",
      size: 128,
      digest: "a".repeat(64),
    };
    expect(parseAttachmentImportWorkerRequest({
      type: "attachment-import.validate",
      operationId,
      operation,
    })).toEqual({
      type: "attachment-import.validate",
      operationId,
      operation,
    });
    expect(parseAttachmentImportWorkerEvent({
      type: "attachment-import.result",
      operationId,
      ok: true,
      receipt,
    })).toEqual({
      type: "attachment-import.result",
      operationId,
      ok: true,
      receipt,
    });
    expect(parseAttachmentImportWorkerRequest({
      type: "attachment-import.result-ack",
      operationId,
    })).toEqual({
      type: "attachment-import.result-ack",
      operationId,
    });
    expect(parseAttachmentImportWorkerRequest({
      type: "attachment-import.result-ack",
      operationId: "not-a-uuid",
    })).toBeNull();
    expect(parseAttachmentImportWorkerEvent({
      type: "attachment-import.result",
      operationId,
      ok: true,
      receipt,
      extra: true,
    })).toBeNull();
  });
});
