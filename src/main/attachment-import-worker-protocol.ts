import {
  AttachmentImportValidationError,
  isReportedImageSide,
  parseAttachmentImportFileOperation,
  parseAttachmentImportValidationReceipt,
  type AttachmentImportFileOperation,
  type AttachmentImportValidationReceipt,
} from "./attachment-import-file.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type AttachmentImportWorkerRequest = {
  readonly type: "attachment-import.validate";
  readonly operationId: string;
  readonly operation: AttachmentImportFileOperation;
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
  readonly code: "content" | "unsafe";
} | {
  readonly type: "attachment-import.result";
  readonly operationId: string;
  readonly ok: false;
  readonly code: "image-too-large";
  readonly width: number;
  readonly height: number;
};

export type AttachmentImportWorkerFailureEvent = Extract<
  AttachmentImportWorkerEvent,
  { readonly ok: false }
>;

/** Maps a worker-side failure to its privacy-safe wire event. */
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

/** Rebuilds the main-process error for a parsed worker failure. */
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

export function parseAttachmentImportWorkerRequest(
  value: unknown,
): AttachmentImportWorkerRequest | null {
  if (
    !record(value)
  ) return null;
  if (
    value.type === "attachment-import.result-ack"
    && Object.keys(value).length === 2
    && typeof value.operationId === "string"
    && UUID_PATTERN.test(value.operationId)
  ) return { type: value.type, operationId: value.operationId };
  if (
    Object.keys(value).length !== 3
    || value.type !== "attachment-import.validate"
    || typeof value.operationId !== "string"
    || !UUID_PATTERN.test(value.operationId)
  ) return null;
  const operation = parseAttachmentImportFileOperation(value.operation);
  return operation
    ? { type: value.type, operationId: value.operationId, operation }
    : null;
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
    if (value.code === "content" || value.code === "unsafe") {
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
