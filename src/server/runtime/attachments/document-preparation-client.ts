import { randomUUID } from "node:crypto";
import {
  DOCUMENT_PREPARATION_TIMEOUT_MS,
  documentPreparationResultMatches,
  parseDocumentPreparationOperation,
  type DocumentPreparationOperation,
  type DocumentPreparationResult,
  type DocumentPreparationRunner,
} from "../../../node/document-preparation";
import type { RuntimeDocumentPreparationEvent, RuntimeDocumentPreparationResult } from "../../../node/runtime-document-preparation-protocol";
import { DocumentAttachmentError } from "./attachment-errors";

interface Pending {
  operation: DocumentPreparationOperation;
  signal?: AbortSignal;
  onAbort(): void;
  timer: NodeJS.Timeout;
  reject(error: Error): void;
  resolve(result: DocumentPreparationResult): void;
  resolveStopped(): void;
  rejectStopped(error: Error): void;
  resolveTermination(): void;
  resultSettled: boolean;
}

export class RuntimeDocumentPreparationClient {
  private readonly pending = new Map<string, Pending>();
  private closed = false;

  constructor(private readonly post: (event: RuntimeDocumentPreparationEvent) => void) {}

  readonly runner: DocumentPreparationRunner = (operation, signal) => {
    let resolve!: Pending["resolve"];
    let reject!: Pending["reject"];
    let resolveStopped!: Pending["resolveStopped"];
    let rejectStopped!: Pending["rejectStopped"];
    let resolveTermination!: Pending["resolveTermination"];
    const result = new Promise<DocumentPreparationResult>((yes, no) => { resolve = yes; reject = no; });
    const stopped = new Promise<void>((yes, no) => { resolveStopped = yes; rejectStopped = no; });
    const termination = new Promise<void>((yes) => { resolveTermination = yes; });
    if (this.closed || signal?.aborted || !parseDocumentPreparationOperation(operation)
      || operation.deadlineAt <= Date.now() || this.pending.size >= 3) {
      reject(new DocumentAttachmentError("Document preparation is unavailable or cancelled."));
      resolveStopped();
      resolveTermination();
      return { result, stopped, termination };
    }
    const requestId = randomUUID();
    const onAbort = (): void => {
      this.rejectResult(requestId, "Document preparation was cancelled.");
      this.cancel(requestId);
    };
    const timer = setTimeout(() => {
      this.rejectResult(requestId, "Document preparation did not respond before its deadline.");
      this.cancel(requestId);
    }, Math.max(1, Math.min(DOCUMENT_PREPARATION_TIMEOUT_MS, operation.deadlineAt - Date.now())));
    timer.unref();
    this.pending.set(requestId, { operation, signal, onAbort, timer, resolve, reject, resolveStopped,
      rejectStopped, resolveTermination, resultSettled: false });
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      this.post({ type: "runtime.document-preparation-request", requestId, operation });
    } catch {
      this.finish(requestId, undefined, "Document preparation could not be delivered.", false);
    }
    return { result, stopped, termination };
  };

  handle(event: RuntimeDocumentPreparationResult): boolean {
    const pending = this.pending.get(event.requestId);
    if (!pending) return false;
    if (!event.ok) this.finish(event.requestId, undefined, event.message, event.shutdownConfirmed);
    else if (!documentPreparationResultMatches(pending.operation, event.result)) {
      this.finish(event.requestId, undefined, "The decoder returned an unrelated document result.", true);
    } else this.finish(event.requestId, event.result, undefined, true);
    return true;
  }

  close(): void {
    this.closed = true;
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener("abort", pending.onAbort);
      this.rejectResult(requestId, "Document preparation stopped.");
      // Only main can prove decoder termination; closure is not that proof.
      this.cancel(requestId);
    }
  }

  private rejectResult(requestId: string, message: string): void {
    const pending = this.pending.get(requestId);
    if (!pending || pending.resultSettled) return;
    pending.resultSettled = true;
    pending.reject(new DocumentAttachmentError(message));
  }

  private cancel(requestId: string): void {
    try { this.post({ type: "runtime.document-preparation-cancel", requestId }); }
    catch { this.finish(requestId, undefined, "Document decoder shutdown is unconfirmed.", false); }
  }

  private finish(requestId: string, result: DocumentPreparationResult | undefined, message: string | undefined, confirmed: boolean): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.onAbort);
    if (confirmed) { pending.resolveStopped(); pending.resolveTermination(); }
    else pending.rejectStopped(new DocumentAttachmentError("Document decoder shutdown is unconfirmed."));
    if (pending.resultSettled) return;
    pending.resultSettled = true;
    if (message || !result) pending.reject(new DocumentAttachmentError(message ?? "Document preparation failed."));
    else pending.resolve(result);
  }
}
