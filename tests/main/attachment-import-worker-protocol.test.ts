import { describe, expect, it } from "vitest";

import { AttachmentImportValidationError } from "../../src/main/attachment-import-file";
import {
  attachmentImportExtractFailureEvent,
  parseAttachmentImportExtractWorkerEvent,
  parseAttachmentImportWorkerEvent,
  parseAttachmentImportWorkerRequest,
} from "../../src/main/attachment-import-worker-protocol";
import { DocumentExtractionError } from "../../src/node/document-text-errors";

const operationId = "11111111-1111-4111-8111-111111111111";
const RTF = "application/rtf";

describe("attachment import worker document extraction protocol", () => {
  it("accepts only exact, bounded extraction requests", () => {
    const bytes = new Uint8Array([123, 92]);
    expect(parseAttachmentImportWorkerRequest({
      type: "attachment-import.extract",
      operationId,
      operation: { mimeType: RTF, bytes },
    })).toEqual({ type: "attachment-import.extract", operationId, operation: { mimeType: RTF, bytes } });
    for (const operation of [
      { mimeType: "application/pdf", bytes },
      { mimeType: RTF, bytes: new Uint8Array() },
      { mimeType: RTF, bytes: new Uint8Array(10 * 1024 * 1024 + 1) },
      { mimeType: RTF, bytes: [1, 2] },
      { mimeType: RTF, bytes, path: "/etc/passwd" },
    ]) {
      expect(parseAttachmentImportWorkerRequest({ type: "attachment-import.extract", operationId, operation }))
        .toBeNull();
    }
    expect(parseAttachmentImportWorkerRequest({
      type: "attachment-import.extract",
      operationId: "not-a-uuid",
      operation: { mimeType: RTF, bytes },
    })).toBeNull();
  });

  it("parses extraction results with bounded text and known failure codes only", () => {
    const event = { type: "attachment-import.extract-result", operationId, ok: true, text: "Body", truncated: false };
    expect(parseAttachmentImportExtractWorkerEvent(event)).toEqual(event);
    expect(parseAttachmentImportExtractWorkerEvent({ ...event, text: "x".repeat(1024 * 1024 + 1) })).toBeNull();
    expect(parseAttachmentImportExtractWorkerEvent({ ...event, text: "a\0b" })).toBeNull();
    expect(parseAttachmentImportExtractWorkerEvent({ ...event, extra: 1 })).toBeNull();
    expect(parseAttachmentImportExtractWorkerEvent({ ...event, type: "attachment-import.result" })).toBeNull();
    for (const code of ["document-encrypted", "document-corrupt", "document-empty", "document-limit", "content"]) {
      expect(parseAttachmentImportExtractWorkerEvent({ type: event.type, operationId, ok: false, code }))
        .toMatchObject({ ok: false, code });
    }
    expect(parseAttachmentImportExtractWorkerEvent({ type: event.type, operationId, ok: false, code: "stack trace" }))
      .toBeNull();
  });

  it("keeps validation receipts' extracted preview text bounded", () => {
    const receipt = {
      displayName: "notes.rtf",
      mimeType: RTF,
      extension: "rtf",
      size: 10,
      digest: "a".repeat(64),
    };
    const result = (extra: Record<string, unknown>) => ({
      type: "attachment-import.result",
      operationId,
      ok: true,
      receipt: { ...receipt, ...extra },
    });
    expect(parseAttachmentImportWorkerEvent(result({ extractedText: "Body", extractedTruncated: true })))
      .toMatchObject({ ok: true, receipt: { extractedText: "Body", extractedTruncated: true } });
    expect(parseAttachmentImportWorkerEvent(result({ extractedText: "Body" }))).toBeNull();
    expect(parseAttachmentImportWorkerEvent(result({ extractedText: "x".repeat(1024 * 1024 + 1), extractedTruncated: true })))
      .toBeNull();
    expect(parseAttachmentImportWorkerEvent(result({ unexpected: true }))).toBeNull();
  });

  it("maps worker failures to privacy-safe codes", () => {
    expect(attachmentImportExtractFailureEvent(operationId, new AttachmentImportValidationError("document-encrypted")))
      .toEqual({ type: "attachment-import.extract-result", operationId, ok: false, code: "document-encrypted" });
    expect(attachmentImportExtractFailureEvent(operationId, new DocumentExtractionError("document-empty")))
      .toMatchObject({ code: "document-corrupt" });
    expect(attachmentImportExtractFailureEvent(operationId, new Error("/private/path exploded")))
      .toMatchObject({ code: "document-corrupt" });
  });
});
