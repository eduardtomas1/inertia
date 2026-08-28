import type { BackendCredentialStatus } from "../shared/backend-credentials.js";
import type {
  RuntimeCredentialOperation,
  RuntimeWorkerCommand,
} from "../node/runtime-process-protocol.js";
import type {
  PendingCredentialRequest,
  RuntimeCredentialBroker,
  RuntimeProcessRecord,
  RuntimeSupervisorTimer,
} from "./runtime-supervisor-types.js";
import { drainRuntimeRecordRequests } from
  "./runtime-supervisor-process-record.js";

export type RuntimeCredentialRequest = {
  type: "runtime.credential-request";
  requestId: string;
  operation: RuntimeCredentialOperation;
  secretReference: string;
};

export class RuntimeCredentialCoordinator {
  private readonly pending = new Map<string, PendingCredentialRequest>();

  constructor(private readonly options: {
    broker?: RuntimeCredentialBroker;
    timeoutMs: number;
    setTimer: typeof setTimeout;
    clearTimer: (timer: RuntimeSupervisorTimer) => void;
    accepts: (record: RuntimeProcessRecord) => boolean;
    post: (record: RuntimeProcessRecord, command: RuntimeWorkerCommand) => boolean;
  }) {}

  handle(record: RuntimeProcessRecord, event: RuntimeCredentialRequest): void {
    if (!this.options.accepts(record) || !this.options.broker) {
      this.result(record, event, false, "unavailable",
        "Secure credential storage is unavailable.");
      return;
    }
    if (record.credentialRequestIds.has(event.requestId)) {
      this.result(record, event, false, "invalid",
        "The credential request identifier was already used.");
      return;
    }
    record.credentialRequestIds.add(event.requestId);
    if (record.credentialRequestIds.size > 512) {
      const oldest = record.credentialRequestIds.values().next().value;
      if (typeof oldest === "string") record.credentialRequestIds.delete(oldest);
    }
    const controller = new AbortController();
    const pending: PendingCredentialRequest = {
      record,
      operation: event.operation,
      controller,
      timer: this.options.setTimer(() => {
        if (this.pending.get(event.requestId) !== pending) return;
        this.pending.delete(event.requestId);
        pending.controller.abort();
        if (!this.options.accepts(record)) return;
        this.result(record, event, false, "unavailable",
          "Secure credential storage did not respond in time.");
      }, this.options.timeoutMs),
    };
    this.pending.set(event.requestId, pending);
    const broker = this.options.broker;
    const operation = Promise.resolve().then<
      string | null | boolean | BackendCredentialStatus
    >(() => event.operation === "resolve"
      ? broker.resolve(event.secretReference, controller.signal)
      : event.operation === "status"
        ? broker.status(event.secretReference, controller.signal)
        : event.operation === "clear"
          ? broker.clear(event.secretReference, controller.signal)
          : broker.forget(event.secretReference, controller.signal));
    void operation.then(
      (value) => this.finish(record, event, pending, value),
      () => {
        if (!this.consume(event.requestId, pending)
          || !this.options.accepts(record)) return;
        this.result(record, event, false, "unavailable",
          "Secure credential storage is unavailable.");
      },
    );
  }

  clear(record: RuntimeProcessRecord | null): void {
    drainRuntimeRecordRequests(this.pending, record, (pending) => {
      this.options.clearTimer(pending.timer);
      pending.controller.abort();
    });
  }

  private finish(
    record: RuntimeProcessRecord,
    event: RuntimeCredentialRequest,
    pending: PendingCredentialRequest,
    value: string | null | boolean | BackendCredentialStatus,
  ): void {
    if (!this.consume(event.requestId, pending)
      || !this.options.accepts(record)) return;
    if (event.operation === "resolve") {
      if (typeof value !== "string") {
        this.result(record, event, false, "not-found",
          "The backend credential is unavailable.");
      } else {
        this.options.post(record, {
          type: "runtime.credential-result",
          requestId: event.requestId,
          operation: "resolve",
          ok: true,
          secret: value,
        });
      }
      return;
    }
    if (event.operation === "status") {
      const status = typeof value === "object" && value !== null
        ? value as BackendCredentialStatus
        : { hasSecret: false, credentialGeneration: null };
      this.options.post(record, {
        type: "runtime.credential-result",
        requestId: event.requestId,
        operation: "status",
        ok: true,
        hasSecret: status.hasSecret,
        credentialGeneration: status.credentialGeneration,
      });
      return;
    }
    this.options.post(record, {
      type: "runtime.credential-result",
      requestId: event.requestId,
      operation: event.operation,
      ok: true,
      removed: value === true,
    });
  }

  private consume(requestId: string, pending: PendingCredentialRequest): boolean {
    if (this.pending.get(requestId) !== pending) return false;
    this.pending.delete(requestId);
    this.options.clearTimer(pending.timer);
    return true;
  }

  private result(
    record: RuntimeProcessRecord,
    event: RuntimeCredentialRequest,
    ok: false,
    code: "invalid" | "not-found" | "unavailable",
    message: string,
  ): void {
    this.options.post(record, {
      type: "runtime.credential-result",
      requestId: event.requestId,
      operation: event.operation,
      ok,
      code,
      message,
    });
  }
}
