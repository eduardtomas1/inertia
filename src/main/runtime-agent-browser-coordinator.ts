import type {
  RuntimeWorkerCommand,
  RuntimeWorkerEvent,
} from "../node/runtime-process-protocol.js";
import type { RuntimeAgentBrowserResult } from "../node/runtime-agent-browser-protocol.js";
import type {
  RuntimeAgentBrowserBroker,
  RuntimeProcessRecord,
} from "./runtime-supervisor-types.js";
import { RuntimeCorrelatedRequests } from "./runtime-correlated-requests.js";

type BrowserRequest = Extract<
  RuntimeWorkerEvent,
  { type: "runtime.agent-browser-request" }
>;
type BrowserCancel = Extract<
  RuntimeWorkerEvent,
  { type: "runtime.agent-browser-cancel" }
>;

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
  private readonly requests: RuntimeCorrelatedRequests<BrowserRequest["identity"], RuntimeAgentBrowserResult["result"]>;

  constructor(private readonly options: RuntimeAgentBrowserCoordinatorOptions) {
    this.requests = new RuntimeCorrelatedRequests({
      requestIds: (record) => record.agentBrowserRequestIds,
      sameIdentity,
      accepts: (record) => this.options.accepts(record),
      reply: (record, requestId, result) => this.reply(record, requestId, result),
      repeated: {
        ok: false,
        code: "invalid",
        message: "The browser request identifier was already used.",
      },
      failed: {
        ok: false,
        code: "unavailable",
        message: "The browser action could not be completed.",
      },
    });
  }

  handle(
    record: RuntimeProcessRecord,
    event: BrowserRequest | BrowserCancel,
  ): void {
    if (event.type === "runtime.agent-browser-cancel") {
      this.requests.cancel(record, event.requestId, event.identity);
      return;
    }
    const broker = this.options.broker;
    if (!this.options.accepts(record) || !broker) {
      this.reply(record, event.requestId, {
        ok: false,
        code: "unavailable",
        message: "The Inertia browser service is unavailable.",
      });
      return;
    }
    const command = event.command;
    if (!command) {
      this.reply(record, event.requestId, {
        ok: false,
        code: "invalid",
        message: "The browser request arguments were not accepted. Check the tool's input schema and try again.",
      });
      return;
    }
    this.requests.begin(record, event.requestId, event.identity, (signal) => broker.perform(
      event.identity,
      command,
      signal,
    ));
  }

  clear(record: RuntimeProcessRecord | null): void {
    this.requests.clear(record);
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
