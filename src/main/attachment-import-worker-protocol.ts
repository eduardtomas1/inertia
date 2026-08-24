import {
  parseAttachmentImportFileOperation,
  parseAttachmentImportValidationReceipt,
  type AttachmentImportFileOperation,
  type AttachmentImportValidationFailure,
  type AttachmentImportValidationReceipt,
} from "./attachment-import-file.js";

export interface AttachmentImportWorkerRequest {
  readonly type: "attachment-import.validate";
  readonly operation: AttachmentImportFileOperation;
}

export type AttachmentImportWorkerEvent = {
  readonly type: "attachment-import.result";
  readonly ok: true;
  readonly receipt: AttachmentImportValidationReceipt;
} | {
  readonly type: "attachment-import.result";
  readonly ok: false;
  readonly code: AttachmentImportValidationFailure;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAttachmentImportWorkerRequest(
  value: unknown,
): AttachmentImportWorkerRequest | null {
  if (
    !record(value)
    || Object.keys(value).length !== 2
    || value.type !== "attachment-import.validate"
  ) return null;
  const operation = parseAttachmentImportFileOperation(value.operation);
  return operation ? { type: value.type, operation } : null;
}

export function parseAttachmentImportWorkerEvent(
  value: unknown,
): AttachmentImportWorkerEvent | null {
  if (
    !record(value)
    || value.type !== "attachment-import.result"
    || typeof value.ok !== "boolean"
  ) return null;
  if (value.ok === false) {
    return Object.keys(value).length === 3
      && (value.code === "content" || value.code === "unsafe")
      ? { type: value.type, ok: false, code: value.code }
      : null;
  }
  if (Object.keys(value).length !== 3) return null;
  const receipt = parseAttachmentImportValidationReceipt(value.receipt);
  return receipt
    ? { type: value.type, ok: true, receipt }
    : null;
}
