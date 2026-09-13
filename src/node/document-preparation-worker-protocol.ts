import {
  parseDocumentPreparationOperation,
  parseDocumentPreparationResult,
  type DocumentPreparationOperation,
  type DocumentPreparationResult,
} from "./document-preparation";

export type DocumentPreparationWorkerRequest = {
  type: "document.prepare";
  operationId: string;
  operation: DocumentPreparationOperation;
} | { type: "document.result-ack"; operationId: string };

export type DocumentPreparationWorkerEvent = {
  type: "document.result";
  operationId: string;
  ok: true;
  result: DocumentPreparationResult;
} | { type: "document.result"; operationId: string; ok: false; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
function identified(value: unknown): value is Record<string, unknown> & { operationId: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && "operationId" in value && typeof value.operationId === "string" && UUID.test(value.operationId);
}

export function parseDocumentPreparationWorkerRequest(value: unknown): DocumentPreparationWorkerRequest | null {
  if (!identified(value)) return null;
  if (value.type === "document.result-ack" && Object.keys(value).length === 2) {
    return { type: value.type, operationId: value.operationId };
  }
  if (value.type !== "document.prepare" || Object.keys(value).length !== 3) return null;
  const operation = parseDocumentPreparationOperation(value.operation);
  return operation ? { type: value.type, operationId: value.operationId, operation } : null;
}

export function parseDocumentPreparationWorkerEvent(value: unknown): DocumentPreparationWorkerEvent | null {
  if (!identified(value) || value.type !== "document.result" || Object.keys(value).length !== 4) return null;
  if (value.ok === false && typeof value.message === "string" && value.message.length > 0 && value.message.length <= 300) {
    return { type: value.type, operationId: value.operationId, ok: false, message: value.message };
  }
  if (value.ok !== true) return null;
  const result = parseDocumentPreparationResult(value.result);
  return result ? { type: value.type, operationId: value.operationId, ok: true, result } : null;
}
