import type {
  PrivateConnectRuntimeAuthorization,
  PrivateConnectRuntimeRequest,
  PrivateConnectRuntimeResponse,
} from "../shared/private-connect/runtime-contract";
import type {
  RuntimeWorkerCommand,
  RuntimeWorkerEvent,
} from "../node/runtime-process-protocol.js";
import { drainRuntimeRecordRequests } from "./runtime-supervisor-process-record.js";
import type {
  PendingPrivateConnectRuntimeRequest,
  RuntimeProcessRecord,
} from "./runtime-supervisor-types.js";

type PrivateConnectResponseEvent = Extract<RuntimeWorkerEvent, {
  type: "runtime.private-connect-response";
}>;

interface RuntimePrivateConnectRequestCoordinatorOptions {
  requestTimeoutMs: number;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
  post: (record: RuntimeProcessRecord, command: RuntimeWorkerCommand) => boolean;
}

export class RuntimePrivateConnectRequestCoordinator {
  private readonly pending = new Map<string, PendingPrivateConnectRuntimeRequest>();

  constructor(
    private readonly options: RuntimePrivateConnectRequestCoordinatorOptions,
  ) {}

  request(
    record: RuntimeProcessRecord,
    subject: PrivateConnectRuntimeAuthorization,
    request: Exclude<PrivateConnectRuntimeRequest, { type: "prompt.send" }>,
  ): Promise<PrivateConnectRuntimeResponse> {
    if (this.pending.has(request.requestId)) {
      return Promise.reject(new Error(
        "The Private Connect request identifier is already active.",
      ));
    }
    return new Promise<PrivateConnectRuntimeResponse>((resolve, reject) => {
      const timer = this.options.setTimer(() => {
        this.pending.delete(request.requestId);
        reject(new Error("The Private Connect request timed out."));
      }, this.options.requestTimeoutMs);
      this.pending.set(request.requestId, {
        record,
        timer,
        resolve,
        reject,
      });
      this.options.post(record, {
        type: "runtime.private-connect-request",
        requestId: request.requestId,
        subject,
        request,
      });
    });
  }

  handle(record: RuntimeProcessRecord, event: PrivateConnectResponseEvent): void {
    const pending = this.pending.get(event.requestId);
    if (!pending || pending.record !== record) return;
    this.pending.delete(event.requestId);
    this.options.clearTimer(pending.timer);
    pending.resolve(event.response);
  }

  reject(record: RuntimeProcessRecord | null, message: string): void {
    drainRuntimeRecordRequests(this.pending, record, (pending) => {
      this.options.clearTimer(pending.timer);
      pending.reject(new Error(message));
    });
  }
}
