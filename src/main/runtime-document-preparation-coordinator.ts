import { documentPreparationResultMatches, parseDocumentPreparationResult, type DocumentPreparationExecution, type DocumentPreparationResult, type DocumentPreparationRunner } from "../node/document-preparation";
import type { RuntimeDocumentPreparationEvent, RuntimeDocumentPreparationResult } from "../node/runtime-document-preparation-protocol";
import type { RuntimeProcessRecord } from "./runtime-supervisor-types";

interface RecordState {
  completions: Set<Promise<boolean>>;
  terminations: Set<Promise<void>>;
  draining: boolean;
  suppressReplies: boolean;
  confirmed: boolean;
  permanentFailure: boolean;
}
interface Options {
  runner?: DocumentPreparationRunner;
  retryUnconfirmedShutdown?: boolean;
  accepts(record: RuntimeProcessRecord): boolean;
  post(record: RuntimeProcessRecord, result: RuntimeDocumentPreparationResult): void;
}

export class RuntimeDocumentPreparationCoordinator {
  private readonly pending = new Map<string, { record: RuntimeProcessRecord; controller: AbortController }>();
  private readonly used = new WeakMap<RuntimeProcessRecord, Set<string>>();
  private readonly states = new Map<RuntimeProcessRecord, RecordState>();

  constructor(private readonly options: Options) {}

  handle(record: RuntimeProcessRecord, event: RuntimeDocumentPreparationEvent): void {
    if (event.type === "runtime.document-preparation-cancel") {
      const pending = this.pending.get(event.requestId);
      if (pending?.record === record) pending.controller.abort();
      return;
    }
    const prior = this.states.get(record);
    if (!this.options.accepts(record) || !this.options.runner || prior?.draining || prior?.confirmed === false) {
      this.fail(record, event.requestId, prior?.confirmed !== false);
      return;
    }
    const used = this.used.get(record) ?? new Set<string>();
    this.used.set(record, used);
    if (used.has(event.requestId) || this.pending.has(event.requestId) || this.pending.size >= 3) {
      this.fail(record, event.requestId, true);
      return;
    }
    used.add(event.requestId);
    if (used.size > 512) used.delete(used.values().next().value!);
    const controller = new AbortController();
    const state: RecordState = prior ?? { completions: new Set(), terminations: new Set(), draining: false,
      suppressReplies: false, confirmed: true, permanentFailure: false };
    let execution: DocumentPreparationExecution;
    try { execution = this.options.runner(event.operation, controller.signal); }
    catch {
      state.confirmed = false;
      state.permanentFailure = true;
      this.states.set(record, state);
      this.clear(record);
      this.fail(record, event.requestId, false);
      return;
    }
    this.states.set(record, state);
    this.pending.set(event.requestId, { record, controller });
    const stopped = execution.stopped.then(() => true, () => {
      state.confirmed = false;
      if (!this.options.retryUnconfirmedShutdown) state.permanentFailure = true;
      else {
        state.terminations.add(execution.termination);
        void execution.termination.then(() => {
          state.terminations.delete(execution.termination);
          if (!state.permanentFailure && state.terminations.size === 0) state.confirmed = true;
        }, () => { state.permanentFailure = true; });
      }
      return false;
    });
    let completion!: Promise<boolean>;
    completion = (async () => {
      let result: DocumentPreparationResult | undefined;
      let message = "The document could not be prepared safely.";
      try {
        const received = parseDocumentPreparationResult(await execution.result);
        if (received && documentPreparationResultMatches(event.operation, received)) result = received;
      }
      catch (error) {
        if (error instanceof Error) message = error.message.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 300) || message;
      }
      const confirmed = await stopped;
      if (!state.suppressReplies) {
        if (confirmed && state.confirmed && result) this.options.post(record, {
          type: "runtime.document-preparation-result", requestId: event.requestId, ok: true, shutdownConfirmed: true, result,
        });
        else this.fail(record, event.requestId, confirmed && state.confirmed, message);
      }
      return confirmed;
    })().catch(() => {
      state.permanentFailure = true;
      state.confirmed = false;
      return false;
    }).finally(() => {
      this.pending.delete(event.requestId);
      state.completions.delete(completion);
      if (!state.draining && state.confirmed && state.completions.size === 0) this.states.delete(record);
    });
    state.completions.add(completion);
  }

  clear(record: RuntimeProcessRecord | null): void {
    if (!record) return;
    for (const pending of this.pending.values()) if (pending.record === record) pending.controller.abort();
  }

  hasOperations(record: RuntimeProcessRecord | null): boolean {
    return record !== null && this.states.has(record);
  }

  async drain(record: RuntimeProcessRecord | null, suppressReplies = false): Promise<boolean> {
    if (!record) return true;
    const state = this.states.get(record);
    if (!state) { this.used.delete(record); return true; }
    state.draining = true;
    state.suppressReplies ||= suppressReplies;
    this.clear(record);
    while (state.completions.size > 0) await Promise.all(state.completions);
    if (!state.confirmed) return false;
    this.states.delete(record);
    this.used.delete(record);
    return true;
  }

  async shutdown(): Promise<boolean> {
    const results = await Promise.all([...this.states.keys()].map((record) => this.drain(record).catch(() => false)));
    return results.every(Boolean);
  }

  private fail(record: RuntimeProcessRecord, requestId: string, confirmed: boolean,
    message = "Document preparation is unavailable."): void {
    this.options.post(record, { type: "runtime.document-preparation-result", requestId, ok: false,
      shutdownConfirmed: confirmed, message: confirmed ? message : "Document decoder shutdown is unconfirmed." });
  }
}
