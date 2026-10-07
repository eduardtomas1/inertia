import { randomUUID } from "node:crypto";

import type {
  RuntimeHtmlRenderDocument,
  RuntimeHtmlRenderEvent,
} from "../node/runtime-html-render-protocol.js";
import type { RuntimeWorkerCommand } from "../node/runtime-process-protocol.js";
import { drainRuntimeRecordRequests } from "./runtime-supervisor-process-record.js";
import type {
  RuntimeProcessRecord,
  RuntimeSupervisorTimer,
} from "./runtime-supervisor-types.js";

interface PendingHtmlRenderRead {
  record: RuntimeProcessRecord;
  timer: RuntimeSupervisorTimer;
  resolve: (render: RuntimeHtmlRenderDocument | null) => void;
  reject: (error: Error) => void;
}

interface RuntimeHtmlRenderCoordinatorOptions {
  requestTimeoutMs: number;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
  post: (record: RuntimeProcessRecord, command: RuntimeWorkerCommand) => boolean;
}

/** Correlates main's reads of stored visual replies with the runtime that owns the database. */
export class RuntimeHtmlRenderCoordinator {
  private readonly pending = new Map<string, PendingHtmlRenderRead>();

  constructor(private readonly options: RuntimeHtmlRenderCoordinatorOptions) {}

  request(record: RuntimeProcessRecord, renderId: string): Promise<RuntimeHtmlRenderDocument | null> {
    const requestId = randomUUID();
    return new Promise<RuntimeHtmlRenderDocument | null>((resolve, reject) => {
      const timer = this.options.setTimer(() => {
        this.pending.delete(requestId);
        reject(new Error("The visual reply request timed out."));
      }, this.options.requestTimeoutMs);
      this.pending.set(requestId, { record, timer, resolve, reject });
      this.options.post(record, { type: "runtime.read-html-render", requestId, renderId });
    });
  }

  handle(record: RuntimeProcessRecord, event: RuntimeHtmlRenderEvent): void {
    const pending = this.pending.get(event.requestId);
    if (!pending || pending.record !== record) return;
    this.pending.delete(event.requestId);
    this.options.clearTimer(pending.timer);
    if (event.type === "runtime.html-render-resolved") pending.resolve(event.render);
    else pending.reject(new Error(event.message));
  }

  reject(record: RuntimeProcessRecord | null, message: string): void {
    drainRuntimeRecordRequests(this.pending, record, (pending) => {
      this.options.clearTimer(pending.timer);
      pending.reject(new Error(message));
    });
  }
}
