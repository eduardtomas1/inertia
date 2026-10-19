import {
  APP_CONTROL_REQUEST_ID_REPLAY_LIMIT,
  appControlFailure,
  sameAppControlIdentity,
  type AppControlCommand,
  type AppControlIdentity,
  type AppControlResult,
  type RuntimeAppControlEvent,
} from "../node/runtime-app-control-protocol.js";
import type { RuntimeWorkerCommand } from "../node/runtime-process-protocol.js";
import { RuntimeCorrelatedRequests } from "./runtime-correlated-requests.js";
import type { RuntimeProcessRecord } from "./runtime-supervisor-types.js";

/**
 * The processes a launch's root may be a direct child of. The runtime's launch
 * manager spawns the root itself (on Linux and macOS the root is the process
 * guardian wrapping the app), so this is the asking runtime's own pid; the
 * supervisor records no separate guardian for the runtime process.
 */
export interface AppControlRuntimeParents {
  parentPids: readonly number[];
}

/** Main's App control service as the runtime brokers reach it. */
export interface RuntimeAppControlMainBroker {
  perform(
    identity: AppControlIdentity,
    command: AppControlCommand,
    signal: AbortSignal,
    runtime: AppControlRuntimeParents,
  ): Promise<AppControlResult>;
}

interface RuntimeAppControlCoordinatorOptions {
  broker?: RuntimeAppControlMainBroker;
  accepts(record: RuntimeProcessRecord): boolean;
  post(record: RuntimeProcessRecord, command: RuntimeWorkerCommand): void;
}

/** The runtime process record's own pid, the only parent a launch root may have. */
export function runtimeAppControlParents(record: RuntimeProcessRecord): AppControlRuntimeParents {
  const pid = (record.child as { pid?: unknown } | undefined)?.pid;
  return { parentPids: typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? [pid] : [] };
}

/**
 * Correlates App control requests from one runtime process record with main's
 * App control service. Request ids are single use per record (the last 512
 * are remembered), a cancel aborts work only when every identity field
 * matches, and results for a replaced or cleared runtime are dropped.
 */
export class RuntimeAppControlCoordinator {
  private readonly requests: RuntimeCorrelatedRequests<AppControlIdentity, AppControlResult>;

  constructor(private readonly options: RuntimeAppControlCoordinatorOptions) {
    this.requests = new RuntimeCorrelatedRequests({
      requestIds: (record) => record.appControlRequestIds,
      sameIdentity: sameAppControlIdentity,
      accepts: (record) => this.options.accepts(record),
      reply: (record, requestId, result) => this.reply(record, requestId, result),
      repeated: appControlFailure("invalid"),
      failed: appControlFailure("native-failure"),
      replayLimit: APP_CONTROL_REQUEST_ID_REPLAY_LIMIT,
    });
  }

  get pendingCount(): number {
    return this.requests.size;
  }

  handle(record: RuntimeProcessRecord, event: RuntimeAppControlEvent): void {
    if (event.type === "runtime.app-control-cancel") {
      this.requests.cancel(record, event.requestId, event.identity);
      return;
    }
    const broker = this.options.broker;
    if (!this.options.accepts(record) || !broker) {
      this.reply(record, event.requestId, appControlFailure("unavailable"));
      return;
    }
    const command = event.command;
    if (!command) {
      this.reply(record, event.requestId, appControlFailure("invalid"));
      return;
    }
    const runtime = runtimeAppControlParents(record);
    this.requests.begin(record, event.requestId, event.identity, (signal) => broker.perform(event.identity, command, signal, runtime));
  }

  clear(record: RuntimeProcessRecord | null): void {
    this.requests.clear(record);
  }

  private reply(record: RuntimeProcessRecord, requestId: string, result: AppControlResult): void {
    this.options.post(record, { type: "runtime.app-control-result", requestId, result });
  }
}
