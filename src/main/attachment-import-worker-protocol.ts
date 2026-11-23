import { ATTACHMENT_PREVIEW_BYTES } from "../shared/attachments.js";
import {
  AttachmentImportValidationError,
  isReportedImageSide,
  parseAttachmentImportDocumentExtractOperation,
  parseAttachmentImportFileOperation,
  parseAttachmentImportValidationReceipt,
  type AttachmentImportDocumentExtractOperation,
  type AttachmentImportFileOperation,
  type AttachmentImportValidationReceipt,
} from "./attachment-import-file.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const SIMPLE_FAILURE_CODES = new Set([
  "content",
  "document-corrupt",
  "document-empty",
  "document-encrypted",
  "document-limit",
  "text-content",
  "text-size",
  "unsafe",
] as const);

export type SimpleAttachmentImportFailureCode =
  | "content"
  | "document-corrupt"
  | "document-empty"
  | "document-encrypted"
  | "document-limit"
  | "text-content"
  | "text-size"
  | "unsafe";

export type AttachmentImportWorkerRequest = {
  readonly type: "attachment-import.validate";
  readonly operationId: string;
  readonly operation: AttachmentImportFileOperation;
} | {
  readonly type: "attachment-import.extract";
  readonly operationId: string;
  readonly operation: AttachmentImportDocumentExtractOperation;
} | {
  readonly type: "attachment-import.result-ack";
  readonly operationId: string;
};

export type AttachmentImportWorkerEvent = {
  readonly type: "attachment-import.result";
  readonly operationId: string;
  readonly ok: true;
  readonly receipt: AttachmentImportValidationReceipt;
} | {
  readonly type: "attachment-import.result";
  readonly operationId: string;
  readonly ok: false;
  readonly code: SimpleAttachmentImportFailureCode;
} | {
  readonly type: "attachment-import.result";
  readonly operationId: string;
  readonly ok: false;
  readonly code: "image-too-large";
  readonly width: number;
  readonly height: number;
};

export type AttachmentImportExtractWorkerEvent = {
  readonly type: "attachment-import.extract-result";
  readonly operationId: string;
  readonly ok: true;
  readonly text: string;
  readonly truncated: boolean;
} | {
  readonly type: "attachment-import.extract-result";
  readonly operationId: string;
  readonly ok: false;
  readonly code: SimpleAttachmentImportFailureCode;
};

export type AttachmentImportWorkerFailureEvent = Extract<
  AttachmentImportWorkerEvent,
  { readonly ok: false }
>;

export function attachmentImportFailureEvent(
  operationId: string,
  error: unknown,
): AttachmentImportWorkerFailureEvent {
  const base = {
    type: "attachment-import.result",
    operationId,
    ok: false,
  } as const;
  if (!(error instanceof AttachmentImportValidationError)) {
    return { ...base, code: "unsafe" };
  }
  if (error.code !== "image-too-large") return { ...base, code: error.code };
  return error.image
    ? {
        ...base,
        code: "image-too-large",
        width: error.image.width,
        height: error.image.height,
      }
    : { ...base, code: "content" };
}

export function attachmentImportExtractFailureEvent(
  operationId: string,
  error: unknown,
): Extract<AttachmentImportExtractWorkerEvent, { readonly ok: false }> {
  const code: SimpleAttachmentImportFailureCode =
    error instanceof AttachmentImportValidationError && error.code !== "image-too-large"
      ? error.code
      : "document-corrupt";
  return {
    type: "attachment-import.extract-result",
    operationId,
    ok: false,
    code,
  };
}

export function attachmentImportFailureError(
  event: AttachmentImportWorkerFailureEvent,
): AttachmentImportValidationError {
  return event.code === "image-too-large"
    ? new AttachmentImportValidationError("image-too-large", {
        width: event.width,
        height: event.height,
      })
    : new AttachmentImportValidationError(event.code);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSimpleFailureCode(value: unknown): value is SimpleAttachmentImportFailureCode {
  return typeof value === "string"
    && SIMPLE_FAILURE_CODES.has(value as SimpleAttachmentImportFailureCode);
}

export function parseAttachmentImportWorkerRequest(
  value: unknown,
): AttachmentImportWorkerRequest | null {
  if (!record(value)) return null;
  if (
    value.type === "attachment-import.result-ack"
    && Object.keys(value).length === 2
    && typeof value.operationId === "string"
    && UUID_PATTERN.test(value.operationId)
  ) return { type: value.type, operationId: value.operationId };
  if (
    Object.keys(value).length !== 3
    || typeof value.operationId !== "string"
    || !UUID_PATTERN.test(value.operationId)
  ) return null;
  if (value.type === "attachment-import.validate") {
    const operation = parseAttachmentImportFileOperation(value.operation);
    return operation
      ? { type: value.type, operationId: value.operationId, operation }
      : null;
  }
  if (value.type === "attachment-import.extract") {
    const operation = parseAttachmentImportDocumentExtractOperation(value.operation);
    return operation
      ? { type: value.type, operationId: value.operationId, operation }
      : null;
  }
  return null;
}

export function parseAttachmentImportWorkerEvent(
  value: unknown,
): AttachmentImportWorkerEvent | null {
  if (
    !record(value)
    || value.type !== "attachment-import.result"
    || typeof value.operationId !== "string"
    || !UUID_PATTERN.test(value.operationId)
    || typeof value.ok !== "boolean"
  ) return null;
  if (value.ok === false) {
    const keys = Object.keys(value).length;
    if (isSimpleFailureCode(value.code)) {
      return keys === 4
        ? {
            type: value.type,
            operationId: value.operationId,
            ok: false,
            code: value.code,
          }
        : null;
    }
    return value.code === "image-too-large"
      && keys === 6
      && isReportedImageSide(value.width)
      && isReportedImageSide(value.height)
      ? {
          type: value.type,
          operationId: value.operationId,
          ok: false,
          code: "image-too-large",
          width: value.width,
          height: value.height,
        }
      : null;
  }
  if (Object.keys(value).length !== 4) return null;
  const receipt = parseAttachmentImportValidationReceipt(value.receipt);
  return receipt
    ? { type: value.type, operationId: value.operationId, ok: true, receipt }
    : null;
}

export function parseAttachmentImportExtractWorkerEvent(
  value: unknown,
): AttachmentImportExtractWorkerEvent | null {
  if (
    !record(value)
    || value.type !== "attachment-import.extract-result"
    || typeof value.operationId !== "string"
    || !UUID_PATTERN.test(value.operationId)
    || typeof value.ok !== "boolean"
  ) return null;
  if (value.ok === false) {
    return Object.keys(value).length === 4 && isSimpleFailureCode(value.code)
      ? {
          type: value.type,
          operationId: value.operationId,
          ok: false,
          code: value.code,
        }
      : null;
  }
  return Object.keys(value).length === 5
    && typeof value.text === "string"
    && !value.text.includes("\0")
    && Buffer.byteLength(value.text, "utf8") <= ATTACHMENT_PREVIEW_BYTES
    && typeof value.truncated === "boolean"
    ? {
        type: value.type,
        operationId: value.operationId,
        ok: true,
        text: value.text,
        truncated: value.truncated,
      }
    : null;
}
