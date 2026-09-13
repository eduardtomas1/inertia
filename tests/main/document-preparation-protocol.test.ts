// @inertia-test-suite portable
import { describe, expect, it } from "vitest";
import { parseRuntimeWorkerCommand, parseRuntimeWorkerEvent } from "../../src/node/runtime-process-protocol";
import { parseDocumentPreparationWorkerEvent, parseDocumentPreparationWorkerRequest } from "../../src/node/document-preparation-worker-protocol";
import {
  DOCUMENT_PREPARATION_CONTEXT_BYTES,
  documentPreparationResultMatches,
  parseDocumentPreparationOperation,
  parseDocumentPreparationResult,
  type DocumentPreparationOperation,
  type DocumentPreparationResult,
} from "../../src/node/document-preparation";

const operation = (): DocumentPreparationOperation => ({
  deadlineAt: 1_800_000_000_000,
  payloads: [{ id: "pdf-1", name: "Document.pdf", mimeType: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70]) }],
});
const result = (): DocumentPreparationResult => ({
  contexts: [{ attachmentId: "pdf-1", label: "PDF · Document.pdf", content: "The page text.", truncated: false }],
  images: [{ id: "page-1", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) }],
  imageOrder: [{ generatedId: "page-1" }],
});

describe("document decoder capability boundary", () => {
  it("round-trips only bounded identified worker and runtime messages", () => {
    const requestId = crypto.randomUUID();
    const request = { type: "runtime.document-preparation-request", requestId, operation: operation() };
    expect(parseRuntimeWorkerEvent(request)).toEqual(request);
    expect(parseRuntimeWorkerEvent({ ...request, authority: "/private" })).toBeNull();
    expect(parseRuntimeWorkerEvent({ type: "runtime.document-preparation-cancel", requestId }))
      .toEqual({ type: "runtime.document-preparation-cancel", requestId });
    const response = { type: "runtime.document-preparation-result", requestId, ok: true, shutdownConfirmed: true, result: result() };
    expect(parseRuntimeWorkerCommand(response)).toEqual(response);
    expect(parseRuntimeWorkerCommand({ ...response, shutdownConfirmed: false })).toBeNull();
    expect(parseRuntimeWorkerCommand({ ...response, requestId: "unknown" })).toBeNull();
    expect(parseRuntimeWorkerCommand({ ...response, extra: true })).toBeNull();
    const failure = { type: response.type, requestId, ok: false, shutdownConfirmed: false, message: "Decoder shutdown is unconfirmed." };
    expect(parseRuntimeWorkerCommand(failure)).toEqual(failure);
    expect(parseRuntimeWorkerCommand({ ...failure, message: "x".repeat(301) })).toBeNull();
    const worker = { type: "document.prepare", operationId: requestId, operation: operation() };
    expect(parseDocumentPreparationWorkerRequest(worker)).toEqual(worker);
    expect(parseDocumentPreparationWorkerRequest({ ...worker, operationId: "unknown" })).toBeNull();
    const ack = { type: "document.result-ack", operationId: requestId };
    expect(parseDocumentPreparationWorkerRequest(ack)).toEqual(ack);
    expect(parseDocumentPreparationWorkerRequest({ ...ack, result: result() })).toBeNull();
    const event = { type: "document.result", operationId: requestId, ok: true, result: result() };
    expect(parseDocumentPreparationWorkerEvent(event)).toEqual(event);
    expect(parseDocumentPreparationWorkerEvent({ ...event, result: { ...result(), images: [] } })).toBeNull();
  });
  it("accepts bounded bytes and metadata without filesystem authority", () => {
    expect(parseDocumentPreparationOperation(operation())).toEqual(operation());
    const value = operation();
    expect(parseDocumentPreparationOperation({ ...value, root: "/private" })).toBeNull();
    expect(parseDocumentPreparationOperation({ ...value, payloads: [{ ...value.payloads[0], path: "/private/document.pdf" }] })).toBeNull();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("rejects invalid deadline %s", (deadlineAt) => {
    expect(parseDocumentPreparationOperation({ ...operation(), deadlineAt })).toBeNull();
  });

  it("rejects duplicate IDs, unknown MIME, non-byte input and count overflow", () => {
    const value = operation();
    expect(parseDocumentPreparationOperation({ ...value, payloads: [value.payloads[0], value.payloads[0]] })).toBeNull();
    expect(parseDocumentPreparationOperation({ ...value, payloads: [{ ...value.payloads[0], mimeType: "application/javascript" }] })).toBeNull();
    expect(parseDocumentPreparationOperation({ ...value, payloads: [{ ...value.payloads[0], bytes: [1, 2] }] })).toBeNull();
    expect(parseDocumentPreparationOperation({ ...value, payloads: Array.from({ length: 9 }, (_, index) => ({ ...value.payloads[0], id: String(index) })) })).toBeNull();
  });

  it("enforces per-file and aggregate byte limits without decoding", () => {
    const value = operation();
    const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
    expect(parseDocumentPreparationOperation({ ...value, payloads: [{ ...value.payloads[0], bytes: oversized }] })).toBeNull();
    const bounded = oversized.subarray(0, 10 * 1024 * 1024);
    expect(parseDocumentPreparationOperation({ ...value, payloads: [
      { ...value.payloads[0], bytes: bounded }, { ...value.payloads[0], id: "pdf-2", bytes: bounded },
      { ...value.payloads[0], id: "pdf-3", bytes: new Uint8Array([1]) },
    ] })).toBeNull();
  });

  it("requires complete unique image references and expected source identities", () => {
    expect(parseDocumentPreparationResult(result())).toEqual(result());
    expect(documentPreparationResultMatches(operation(), result())).toBe(true);
    expect(parseDocumentPreparationResult({ ...result(), imageOrder: [] })).toBeNull();
    expect(parseDocumentPreparationResult({ ...result(), imageOrder: [{ generatedId: "foreign" }] })).toBeNull();
    expect(parseDocumentPreparationResult({ ...result(), imageOrder: [{ generatedId: "page-1" }, { generatedId: "page-1" }] })).toBeNull();
    expect(documentPreparationResultMatches(operation(), { ...result(), contexts: [] })).toBe(false);
    expect(documentPreparationResultMatches(operation(), { ...result(), imageOrder: [{ sourceId: "foreign" }, { generatedId: "page-1" }] })).toBe(false);
  });

  it("preserves existing image identity and includes its bytes in the output budget", () => {
    const value = operation();
    value.payloads.push({ id: "image-1", name: "Image.png", mimeType: "image/png", bytes: new Uint8Array([1]) });
    expect(documentPreparationResultMatches(value, result())).toBe(false);
    const output = result();
    output.imageOrder.unshift({ sourceId: "image-1" });
    expect(documentPreparationResultMatches(value, output)).toBe(true);
    expect(parseDocumentPreparationResult({ ...output, images: [{ id: "page-1", bytes: new Uint8Array([1]) }] })).toBeNull();
  });

  it("bounds escaped context bytes and rejects unknown result fields", () => {
    const output = result();
    output.contexts[0]!.content = "x".repeat(DOCUMENT_PREPARATION_CONTEXT_BYTES);
    expect(parseDocumentPreparationResult(output)).toEqual(output);
    output.contexts[0]!.content = "\n".repeat(DOCUMENT_PREPARATION_CONTEXT_BYTES);
    expect(parseDocumentPreparationResult(output)).toBeNull();
    expect(parseDocumentPreparationResult({ ...result(), directory: "/private" })).toBeNull();
  });
});
