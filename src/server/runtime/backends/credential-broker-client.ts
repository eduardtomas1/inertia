import { randomUUID } from "node:crypto";

import type {
  RuntimeCredentialOperation,
  RuntimeCredentialResult,
  RuntimeWorkerEvent,
} from "../../../node/runtime-process-protocol.js";
import {
  isBackendSecretReference,
  type BackendCredentialStatus,
} from "../../../shared/backend-credentials.js";

const DEFAULT_CREDENTIAL_REQUEST_TIMEOUT_MS = 10_000;
const MAX_CREDENTIAL_REQUEST_TIMEOUT_MS = 30_000;

export type RuntimeCredentialBrokerErrorCode =
  | "invalid-reference"
  | "unavailable"
  | "cancelled"
  | "timeout"
  | "closed";

export class RuntimeCredentialBrokerError extends Error {
  readonly code: RuntimeCredentialBrokerErrorCode;

  constructor(code: RuntimeCredentialBrokerErrorCode, message: string) {
    super(message);
    this.name = "RuntimeCredentialBrokerError";
    this.code = code;
  }
}

interface PendingCredentialRequest {
  operation: RuntimeCredentialOperation;
  timer: NodeJS.Timeout;
  signal: AbortSignal | undefined;
  onAbort: (() => void) | null;
  resolve: (result: RuntimeCredentialResult) => void;
  reject: (error: Error) => void;
}

export interface RuntimeCredentialBrokerClientOptions {
  post: (event: RuntimeWorkerEvent) => void;
  timeoutMs?: number;
}

export class RuntimeCredentialBrokerClient {
  private readonly pending = new Map<string, PendingCredentialRequest>();
  private readonly postEvent: RuntimeCredentialBrokerClientOptions["post"];
  private readonly timeoutMs: number;
  private closed = false;

  constructor(options: RuntimeCredentialBrokerClientOptions) {
    this.postEvent = options.post;
    this.timeoutMs = Math.max(
      1,
      Math.min(
        Math.trunc(options.timeoutMs ?? DEFAULT_CREDENTIAL_REQUEST_TIMEOUT_MS),
        MAX_CREDENTIAL_REQUEST_TIMEOUT_MS,
      ),
    );
  }

  async resolve(
    secretReference: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const result = await this.request("resolve", secretReference, signal);
    if (!result.ok) {
      if (result.code === "not-found") return null;
      throw new RuntimeCredentialBrokerError(
        "unavailable",
        "Secure credential storage is unavailable.",
      );
    }
    return result.operation === "resolve" ? result.secret : null;
  }

  async has(secretReference: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.status(secretReference, signal)).hasSecret;
  }

  async status(
    secretReference: string,
    signal?: AbortSignal,
  ): Promise<BackendCredentialStatus> {
    const result = await this.request("status", secretReference, signal);
    if (!result.ok) {
      if (result.code === "not-found") {
        return { hasSecret: false, credentialGeneration: null };
      }
      throw new RuntimeCredentialBrokerError(
        "unavailable",
        "Secure credential storage is unavailable.",
      );
    }
    return result.operation === "status"
      ? {
          hasSecret: result.hasSecret,
          credentialGeneration: result.credentialGeneration,
        }
      : { hasSecret: false, credentialGeneration: null };
  }

  async clear(secretReference: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.request("clear", secretReference, signal);
    if (!result.ok) {
      if (result.code === "not-found") return false;
      throw new RuntimeCredentialBrokerError(
        "unavailable",
        "Secure credential storage is unavailable.",
      );
    }
    return result.operation === "clear" && result.removed;
  }

  async forget(secretReference: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.request("forget", secretReference, signal);
    if (!result.ok) {
      if (result.code === "not-found") return false;
      throw new RuntimeCredentialBrokerError(
        "unavailable",
        "Secure credential storage is unavailable.",
      );
    }
    return result.operation === "forget" && result.removed;
  }

  handle(result: RuntimeCredentialResult): boolean {
    const pending = this.pending.get(result.requestId);
    if (!pending || pending.operation !== result.operation) return false;
    this.pending.delete(result.requestId);
    this.cleanup(pending);
    pending.resolve(result);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      this.cleanup(pending);
      pending.reject(new RuntimeCredentialBrokerError(
        "closed",
        "The secure credential broker stopped.",
      ));
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }

  private request(
    operation: RuntimeCredentialOperation,
    secretReference: string,
    signal?: AbortSignal,
  ): Promise<RuntimeCredentialResult> {
    if (!isBackendSecretReference(secretReference)) {
      return Promise.reject(new RuntimeCredentialBrokerError(
        "invalid-reference",
        "The backend credential reference is invalid.",
      ));
    }
    if (this.closed) {
      return Promise.reject(new RuntimeCredentialBrokerError(
        "closed",
        "The secure credential broker stopped.",
      ));
    }
    if (signal?.aborted) {
      return Promise.reject(new RuntimeCredentialBrokerError(
        "cancelled",
        "The backend credential request was cancelled.",
      ));
    }
    let requestId = randomUUID();
    while (this.pending.has(requestId)) requestId = randomUUID();
    return new Promise<RuntimeCredentialResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        this.cleanup(pending);
        reject(new RuntimeCredentialBrokerError(
          "timeout",
          "Secure credential storage did not respond in time.",
        ));
      }, this.timeoutMs);
      timer.unref();
      const pending: PendingCredentialRequest = {
        operation,
        timer,
        signal,
        onAbort: null,
        resolve,
        reject,
      };
      if (signal) {
        pending.onAbort = () => {
          if (this.pending.get(requestId) !== pending) return;
          this.pending.delete(requestId);
          this.cleanup(pending);
          reject(new RuntimeCredentialBrokerError(
            "cancelled",
            "The backend credential request was cancelled.",
          ));
        };
        signal.addEventListener("abort", pending.onAbort, { once: true });
      }
      this.pending.set(requestId, pending);
      try {
        this.postEvent({
          type: "runtime.credential-request",
          requestId,
          operation,
          secretReference,
        });
      } catch {
        this.pending.delete(requestId);
        this.cleanup(pending);
        reject(new RuntimeCredentialBrokerError(
          "unavailable",
          "Secure credential storage is unavailable.",
        ));
      }
    });
  }

  private cleanup(pending: PendingCredentialRequest): void {
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
  }
}
