import { randomUUID } from "node:crypto";

import type { RuntimeWorkerCommand, RuntimeWorkerEvent } from "../node/runtime-process-protocol.js";
import type { OpenProjectPathRequest } from "../shared/desktop.js";
import { drainRuntimeRecordRequests } from "./runtime-supervisor-process-record.js";
import type { RuntimeProcessRecord, RuntimeSupervisorTimer } from "./runtime-supervisor-types.js";

type RuntimeSupervisorQueryEvent = Extract<RuntimeWorkerEvent, {
  type:
    | "runtime.project-path-resolved"
    | "runtime.project-path-rejected"
    | "runtime.attachment-conversations-resolved"
    | "runtime.attachment-conversations-rejected";
}>;

interface PendingQuery {
  record: RuntimeProcessRecord;
  kind: "project-path" | "attachment-conversations";
  timer: RuntimeSupervisorTimer;
  resolve: (value: string | readonly string[]) => void;
  reject: (error: Error) => void;
}

interface RuntimeSupervisorQueriesOptions {
  requestTimeoutMs: number;
  setTimer: typeof setTimeout;
  clearTimer: typeof clearTimeout;
  readyRecord: () => RuntimeProcessRecord | Error;
  post: (record: RuntimeProcessRecord, command: RuntimeWorkerCommand) => boolean;
}

/**
 * Correlates main's read-only questions to the runtime that owns the
 * database: where a project path resolves, and which chats sent a stored
 * attachment.
 */
export class RuntimeSupervisorQueries {
  private readonly pending = new Map<string, PendingQuery>();

  constructor(private readonly options: RuntimeSupervisorQueriesOptions) {}

  resolveProjectPath(request: OpenProjectPathRequest): Promise<string> {
    return this.ask<string>("project-path", "The project path request timed out.", (requestId) => ({
      type: "runtime.resolve-project-path", requestId, request,
    }));
  }

  attachmentConversations(attachmentId: string): Promise<readonly string[]> {
    return this.ask<readonly string[]>("attachment-conversations", "The attachment owner request timed out.", (requestId) => ({
      type: "runtime.attachment-conversations", requestId, attachmentId,
    }));
  }

  handle(record: RuntimeProcessRecord, event: RuntimeWorkerEvent): event is RuntimeSupervisorQueryEvent {
    let kind: PendingQuery["kind"];
    let value: string | readonly string[] | Error;
    if (event.type === "runtime.project-path-resolved") [kind, value] = ["project-path", event.path];
    else if (event.type === "runtime.project-path-rejected") [kind, value] = ["project-path", new Error(event.message)];
    else if (event.type === "runtime.attachment-conversations-resolved") [kind, value] = ["attachment-conversations", event.conversationIds];
    else if (event.type === "runtime.attachment-conversations-rejected") [kind, value] = ["attachment-conversations", new Error(event.message)];
    else return false;
    const pending = this.pending.get(event.requestId);
    if (!pending || pending.record !== record || pending.kind !== kind) return true;
    this.pending.delete(event.requestId);
    this.options.clearTimer(pending.timer);
    if (value instanceof Error) pending.reject(value);
    else pending.resolve(value);
    return true;
  }

  reject(record: RuntimeProcessRecord | null, message: string): void {
    drainRuntimeRecordRequests(this.pending, record, (pending) => {
      this.options.clearTimer(pending.timer);
      pending.reject(new Error(message));
    });
  }

  private ask<Value extends string | readonly string[]>(
    kind: PendingQuery["kind"],
    timeoutMessage: string,
    command: (requestId: string) => RuntimeWorkerCommand,
  ): Promise<Value> {
    const record = this.options.readyRecord();
    if (record instanceof Error) return Promise.reject(record);
    const requestId = randomUUID();
    return new Promise<Value>((resolve, reject) => {
      const timer = this.options.setTimer(() => {
        this.pending.delete(requestId);
        reject(new Error(timeoutMessage));
      }, this.options.requestTimeoutMs);
      this.pending.set(requestId, {
        record,
        kind,
        timer,
        resolve: resolve as (value: string | readonly string[]) => void,
        reject,
      });
      this.options.post(record, command(requestId));
    });
  }
}
