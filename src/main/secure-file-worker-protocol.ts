import {
  parseSecureFileRequest,
  parseSecureFileResult,
  type SecureFileRequest,
  type SecureFileResult,
} from "../node/secure-file-protocol.js";

export type SecureFileWorkerRequest =
  | {
      type: "secure-file.perform";
      request: SecureFileRequest;
    }
  | {
      type: "secure-file.recover";
      request: SecureFileRequest;
    };

export type SecureFileWorkerEvent =
  | {
      type: "secure-file.commit";
      phase: "started" | "finished";
    }
  | {
      type: "secure-file.result";
      result: SecureFileResult;
    }
  | {
      type: "secure-file.recovery-result";
      ok: boolean;
    };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseSecureFileWorkerRequest(
  value: unknown,
): SecureFileWorkerRequest | null {
  if (!record(value) || Object.keys(value).length !== 2) return null;
  if (
    value.type !== "secure-file.perform"
    && value.type !== "secure-file.recover"
  ) return null;
  const request = parseSecureFileRequest(value.request);
  return request ? { type: value.type, request } : null;
}

export function parseSecureFileWorkerEvent(
  value: unknown,
): SecureFileWorkerEvent | null {
  if (!record(value)) return null;
  if (value.type === "secure-file.commit") {
    return Object.keys(value).length === 2
      && (value.phase === "started" || value.phase === "finished")
      ? { type: value.type, phase: value.phase }
      : null;
  }
  if (value.type === "secure-file.recovery-result") {
    return Object.keys(value).length === 2 && typeof value.ok === "boolean"
      ? { type: value.type, ok: value.ok }
      : null;
  }
  if (value.type !== "secure-file.result" || Object.keys(value).length !== 2) {
    return null;
  }
  const result = parseSecureFileResult(value.result);
  return result ? { type: value.type, result } : null;
}
