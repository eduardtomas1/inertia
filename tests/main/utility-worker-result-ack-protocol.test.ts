import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { imageAttachmentTooLargeMessage } from "../../src/main/attachment-image-validation";
import { AttachmentImportValidationError } from "../../src/main/attachment-import-file";
import {
  attachmentImportFailureError,
  attachmentImportFailureEvent,
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

  it("carries only bounded integer dimensions for an image-too-large failure", () => {
    const tooLarge = {
      type: "attachment-import.result",
      operationId,
      ok: false,
      code: "image-too-large",
      width: 8_000,
      height: 5_001,
    } as const;
    expect(parseAttachmentImportWorkerEvent(tooLarge)).toEqual(tooLarge);

    for (const malformed of [
      { ...tooLarge, width: 3_840.5 },
      { ...tooLarge, width: "3840" },
      { ...tooLarge, width: 0 },
      { ...tooLarge, height: -1 },
      { ...tooLarge, width: 2 ** 31 },
      { ...tooLarge, height: Number.MAX_SAFE_INTEGER + 2 },
      { ...tooLarge, width: Number.POSITIVE_INFINITY },
      { ...tooLarge, extra: true },
      { type: tooLarge.type, operationId, ok: false, code: tooLarge.code, width: 8_000 },
      { type: tooLarge.type, operationId, ok: false, code: "content", width: 8_000 },
      { ...tooLarge, code: "image-too-big" },
    ]) {
      expect(parseAttachmentImportWorkerEvent(malformed), JSON.stringify(malformed))
        .toBeNull();
    }
  });

  it("maps worker failures to privacy-safe events and back", () => {
    const tooLarge = new AttachmentImportValidationError("image-too-large", {
      width: 8_000,
      height: 5_001,
    });
    const event = attachmentImportFailureEvent(operationId, tooLarge);
    expect(event).toEqual({
      type: "attachment-import.result",
      operationId,
      ok: false,
      code: "image-too-large",
      width: 8_000,
      height: 5_001,
    });
    expect(parseAttachmentImportWorkerEvent(event)).toEqual(event);
    const rebuilt = attachmentImportFailureError(event);
    expect(rebuilt).toBeInstanceOf(AttachmentImportValidationError);
    expect(rebuilt).toMatchObject({
      code: "image-too-large",
      image: { width: 8_000, height: 5_001 },
      message: imageAttachmentTooLargeMessage(8_000, 5_001),
    });

    expect(attachmentImportFailureEvent(
      operationId,
      new AttachmentImportValidationError("content"),
    )).toMatchObject({ code: "content" });
    expect(attachmentImportFailureEvent(
      operationId,
      new Error("EACCES: /Users/person/secret.png"),
    )).toEqual({
      type: "attachment-import.result",
      operationId,
      ok: false,
      code: "unsafe",
    });
  });
});
