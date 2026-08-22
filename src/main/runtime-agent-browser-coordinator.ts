import type {
  RuntimeWorkerCommand,
  RuntimeWorkerEvent,
} from "../node/runtime-process-protocol.js";
import type { RuntimeAgentBrowserResult } from "../node/runtime-agent-browser-protocol.js";
import type {
  RuntimeAgentBrowserBroker,
  RuntimeProcessRecord,
} from "./runtime-supervisor-types.js";

type BrowserRequest = Extract<
  RuntimeWorkerEvent,
  { type: "runtime.agent-browser-request" }
>;
type BrowserCancel = Extract<
  RuntimeWorkerEvent,
  { type: "runtime.agent-browser-cancel" }
>;

interface PendingBrowserRequest {
  record: RuntimeProcessRecord;
  identity: BrowserRequest["identity"];
  controller: AbortController;
}

function sameIdentity(
  left: BrowserRequest["identity"],
  right: BrowserRequest["identity"],
): boolean {
  return left.conversationId === right.conversationId
    && left.runId === right.runId
    && left.turnId === right.turnId;
}

interface RuntimeAgentBrowserCoordinatorOptions {
  broker?: RuntimeAgentBrowserBroker;
  accepts(record: RuntimeProcessRecord): boolean;
  post(record: RuntimeProcessRecord, command: RuntimeWorkerCommand): void;
}

export class RuntimeAgentBrowserCoordinator {
  private readonly pending = new Map<string, PendingBrowserRequest>();

  constructor(private readonly options: RuntimeAgentBrowserCoordinatorOptions) {}

  handle(
    record: RuntimeProcessRecord,
    event: BrowserRequest | BrowserCancel,
  ): void {
    if (event.type === "runtime.agent-browser-cancel") {
      const pending = this.pending.get(event.requestId);
      if (
        pending?.record === record
        && sameIdentity(pending.identity, event.identity)
      ) {
        this.pending.delete(event.requestId);
        pending.controller.abort();
      }
      return;
    }
    if (!this.options.accepts(record) || !this.options.broker) {
      this.reply(record, event.requestId, {
        ok: false,
        code: "unavailable",
        message: "The Inertia browser service is unavailable.",
      });
      return;
    }
    if (record.agentBrowserRequestIds.has(event.requestId)) {
      const repeated = this.pending.get(event.requestId);
      if (repeated?.record === record) {
        this.pending.delete(event.requestId);
        repeated.controller.abort();
      }
      this.reply(record, event.requestId, {
        ok: false,
        code: "invalid",
        message: "The browser request identifier was already used.",
      });
      return;
    }
    record.agentBrowserRequestIds.add(event.requestId);
    if (record.agentBrowserRequestIds.size > 512) {
      const oldest = record.agentBrowserRequestIds.values().next().value;
      if (typeof oldest === "string") record.agentBrowserRequestIds.delete(oldest);
    }
    const controller = new AbortController();
    const pending = {
      record,
      identity: event.identity,
      controller,
    };
    this.pending.set(event.requestId, pending);
    void this.options.broker.perform(
      event.identity,
      event.command,
      controller.signal,
    ).then(
      (result) => {
        if (this.pending.get(event.requestId) !== pending) return;
        this.pending.delete(event.requestId);
        if (this.options.accepts(record)) {
          this.reply(record, event.requestId, result);
        }
      },
      () => {
        if (this.pending.get(event.requestId) !== pending) return;
        this.pending.delete(event.requestId);
        if (this.options.accepts(record)) {
          this.reply(record, event.requestId, {
            ok: false,
            code: "unavailable",
            message: "The browser action could not be completed.",
          });
        }
      },
    );
  }

  clear(record: RuntimeProcessRecord | null): void {
    if (!record) return;
    for (const [requestId, pending] of this.pending) {
      if (pending.record !== record) continue;
      this.pending.delete(requestId);
      pending.controller.abort();
    }
  }

  private reply(
    record: RuntimeProcessRecord,
    requestId: string,
    result: RuntimeAgentBrowserResult["result"],
  ): void {
    this.options.post(record, {
      type: "runtime.agent-browser-result",
      requestId,
      result,
    });
  }
}
