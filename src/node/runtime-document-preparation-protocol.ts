import {
  parseDocumentPreparationOperation,
  parseDocumentPreparationResult,
  type DocumentPreparationOperation,
  type DocumentPreparationResult,
} from "./document-preparation";

export type RuntimeDocumentPreparationEvent = {
  type: "runtime.document-preparation-request";
  requestId: string;
  operation: DocumentPreparationOperation;
} | { type: "runtime.document-preparation-cancel"; requestId: string };

export type RuntimeDocumentPreparationResult = {
  type: "runtime.document-preparation-result";
  requestId: string;
  ok: true;
  shutdownConfirmed: true;
  result: DocumentPreparationResult;
} | {
  type: "runtime.document-preparation-result";
  requestId: string;
  ok: false;
  shutdownConfirmed: boolean;
  message: string;
};

function identified(value: unknown): value is Record<string, unknown> & { requestId: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && "requestId" in value && typeof value.requestId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.requestId);
}

export function parseRuntimeDocumentPreparationEvent(value: unknown): RuntimeDocumentPreparationEvent | null {
  if (!identified(value)) return null;
  if (value.type === "runtime.document-preparation-cancel" && Object.keys(value).length === 2) {
    return { type: value.type, requestId: value.requestId };
  }
  if (value.type !== "runtime.document-preparation-request" || Object.keys(value).length !== 3) return null;
  const operation = parseDocumentPreparationOperation(value.operation);
  return operation ? { type: value.type, requestId: value.requestId, operation } : null;
}

export function parseRuntimeDocumentPreparationResult(value: unknown): RuntimeDocumentPreparationResult | null {
  if (!identified(value) || value.type !== "runtime.document-preparation-result" || Object.keys(value).length !== 5) return null;
  if (value.ok === false && typeof value.shutdownConfirmed === "boolean"
    && typeof value.message === "string" && value.message.length > 0 && value.message.length <= 300) {
    return { type: value.type, requestId: value.requestId, ok: false, shutdownConfirmed: value.shutdownConfirmed, message: value.message };
  }
  if (value.ok !== true || value.shutdownConfirmed !== true) return null;
  const result = parseDocumentPreparationResult(value.result);
  return result ? { type: value.type, requestId: value.requestId, ok: true, shutdownConfirmed: true, result } : null;
}
