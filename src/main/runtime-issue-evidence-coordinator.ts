import type {
  IssueHostEvidence,
  RuntimeIssueEvidenceRequest,
  RuntimeIssueEvidenceResult,
} from "../node/runtime-issue-evidence-protocol.js";
import type { RuntimeProcessRecord } from "./runtime-supervisor-types.js";

export interface RuntimeIssueEvidenceBroker {
  collect(request: { attachDiagnostics: boolean }, signal?: AbortSignal): Promise<IssueHostEvidence>;
}

interface Options {
  broker?: RuntimeIssueEvidenceBroker;
  accepts(record: RuntimeProcessRecord): boolean;
  post(record: RuntimeProcessRecord, result: RuntimeIssueEvidenceResult): void;
}

export class RuntimeIssueEvidenceCoordinator {
  private readonly pending = new Map<string, { record: RuntimeProcessRecord; controller: AbortController }>();
  private readonly used = new WeakMap<RuntimeProcessRecord, Set<string>>();

  constructor(private readonly options: Options) {}

  handle(record: RuntimeProcessRecord, event: RuntimeIssueEvidenceRequest): void {
    const used = this.used.get(record) ?? new Set<string>();
    this.used.set(record, used);
    if (!this.options.accepts(record) || !this.options.broker || used.has(event.requestId) || this.pending.size >= 2) {
      this.options.post(record, { type: "runtime.issue-evidence-result", requestId: event.requestId, ok: false });
      return;
    }
    used.add(event.requestId);
    if (used.size > 64) used.delete(used.values().next().value!);
    const controller = new AbortController();
    const pending = { record, controller };
    this.pending.set(event.requestId, pending);
    const settle = (result: RuntimeIssueEvidenceResult): void => {
      if (this.pending.get(event.requestId) !== pending) return;
      this.pending.delete(event.requestId);
      if (this.options.accepts(record)) this.options.post(record, result);
    };
    void this.options.broker.collect({ attachDiagnostics: event.attachDiagnostics }, controller.signal).then(
      (evidence) => settle({ type: "runtime.issue-evidence-result", requestId: event.requestId, ok: true, evidence }),
      () => settle({ type: "runtime.issue-evidence-result", requestId: event.requestId, ok: false }),
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
}
