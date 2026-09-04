import {
  parseSecureFileRequest,
  parseSecureFileResult,
  type SecureFileRequest,
  type SecureFileResult,
} from "../node/secure-file-protocol.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type SecureFileWorkerRequest =
  | {
      type: "secure-file.perform";
      operationId: string;
      request: SecureFileRequest;
    }
  | {
      type: "secure-file.recover";
      operationId: string;
      request: SecureFileRequest;
    }
  | {
      type: "secure-file.result-ack";
      operationId: string;
    };

export type SecureFileWorkerEvent =
  | {
      type: "secure-file.commit";
      operationId: string;
      phase: "started" | "finished";
    }
  | {
      type: "secure-file.result";
      operationId: string;
      result: SecureFileResult;
    }
  | {
      type: "secure-file.recovery-result";
      operationId: string;
      ok: boolean;
    };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSecureFileWorkerRequest(
  value: unknown,
): SecureFileWorkerRequest | null {
  if (!record(value)) return null;
  if (
    value.type === "secure-file.result-ack"
    && Object.keys(value).length === 2
    && typeof value.operationId === "string"
    && UUID_PATTERN.test(value.operationId)
  ) return { type: value.type, operationId: value.operationId };
  if (
    Object.keys(value).length !== 3
    || typeof value.operationId !== "string"
    || !UUID_PATTERN.test(value.operationId)
  ) return null;
  if (
    value.type !== "secure-file.perform"
    && value.type !== "secure-file.recover"
  ) return null;
  const request = parseSecureFileRequest(value.request);
  return request
    ? { type: value.type, operationId: value.operationId, request }
    : null;
}

export function parseSecureFileWorkerEvent(
  value: unknown,
): SecureFileWorkerEvent | null {
  if (!record(value)) return null;
  if (
    typeof value.operationId !== "string"
    || !UUID_PATTERN.test(value.operationId)
  ) return null;
  if (value.type === "secure-file.commit") {
    return Object.keys(value).length === 3
      && (value.phase === "started" || value.phase === "finished")
      ? { type: value.type, operationId: value.operationId, phase: value.phase }
      : null;
  }
  if (value.type === "secure-file.recovery-result") {
    return Object.keys(value).length === 3 && typeof value.ok === "boolean"
      ? { type: value.type, operationId: value.operationId, ok: value.ok }
      : null;
  }
  if (value.type !== "secure-file.result" || Object.keys(value).length !== 3) {
    return null;
  }
  const result = parseSecureFileResult(value.result);
  return result
    ? { type: value.type, operationId: value.operationId, result }
    : null;
}
