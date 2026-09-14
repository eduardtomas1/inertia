import { randomUUID } from "node:crypto";
import type { UtilityProcess } from "electron";
import {
  DOCUMENT_PREPARATION_TIMEOUT_MS,
  documentPreparationResultMatches,
  parseDocumentPreparationOperation,
  type DocumentPreparationExecution,
  type DocumentPreparationOperation,
  type DocumentPreparationResult,
  type DocumentPreparationRunner,
} from "../node/document-preparation";
import {
  parseDocumentPreparationWorkerEvent,
  type DocumentPreparationWorkerEvent,
  type DocumentPreparationWorkerRequest,
} from "../node/document-preparation-worker-protocol";

interface RunnerOptions {
  spawn(): UtilityProcess;
  now?: () => number;
  killGraceMs?: number;
}

interface Pending {
  operation: DocumentPreparationOperation;
  signal?: AbortSignal;
  timer?: NodeJS.Timeout;
  onAbort(): void;
  resolve(result: DocumentPreparationResult): void;
  reject(error: Error): void;
  resolveStopped(): void;
  rejectStopped(error: Error): void;
  resolveTermination(): void;
}

/** One decoder plus two bounded pending inputs; unconfirmed cleanup blocks admission. */
export function createDocumentPreparationRunner(options: RunnerOptions): DocumentPreparationRunner {
  const now = options.now ?? Date.now;
  const killGraceMs = Math.max(1, Math.min(options.killGraceMs ?? 3_000, 3_000));
  const queued: Pending[] = [];
  let active = false;
  let poisoned: Error | null = null;
  const failBeforeSpawn = (pending: Pending, error: Error): void => {
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.onAbort);
    pending.reject(error);
    pending.resolveStopped();
    pending.resolveTermination();
  };
  const runNow = (pending: Pending): void => {
    clearTimeout(pending.timer);
    active = true;
    const operationId = randomUUID();
    let child: UtilityProcess;
    try {
      child = options.spawn();
    } catch {
      active = false;
      failBeforeSpawn(pending, new Error("The document decoder could not start."));
      pump();
      return;
    }
    let reported: DocumentPreparationWorkerEvent | null = null;
    let stoppingError: Error | null = null;
    let settled = false;
    let spawned = false;
    let exited = false;
    let killAccepted = false;
    let killTimer: NodeJS.Timeout | undefined;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      pending.signal?.removeEventListener("abort", onAbort);
      if (error) pending.reject(error);
      else if (reported?.ok) pending.resolve(reported.result);
      else pending.reject(new Error(reported?.message ?? "The document decoder returned no result."));
    };
    const kill = (): void => {
      if (killAccepted || exited) return;
      try { killAccepted = child.kill(); } catch { /* Exit remains the only cleanup proof. */ }
    };
    const stop = (error: Error): void => {
      if (settled) return;
      stoppingError ??= error;
      kill();
      if (exited || killTimer) return;
      killTimer = setTimeout(() => {
        poisoned = new Error("Document decoder shutdown is unconfirmed.");
        pending.rejectStopped(poisoned);
        settle(stoppingError ?? poisoned);
        for (const entry of queued.splice(0)) failBeforeSpawn(entry, poisoned);
      }, killGraceMs);
      killTimer.unref();
    };
    const onAbort = (): void => stop(new Error("Document preparation was cancelled."));
    const timer = setTimeout(() => stop(new Error("Document preparation timed out.")),
      Math.max(1, Math.min(DOCUMENT_PREPARATION_TIMEOUT_MS, pending.operation.deadlineAt - now())));
    timer.unref();
    pending.signal?.removeEventListener("abort", pending.onAbort);
    pending.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("spawn", () => {
      spawned = true;
      if (stoppingError) { kill(); return; }
      if (pending.signal?.aborted) { onAbort(); return; }
      try {
        child.postMessage({ type: "document.prepare", operationId, operation: pending.operation } satisfies DocumentPreparationWorkerRequest);
      } catch {
        stop(new Error("Document preparation could not be delivered."));
      }
    });
    child.on("message", (value: unknown) => {
      if (settled || stoppingError) return;
      const event = parseDocumentPreparationWorkerEvent(value);
      if (!spawned || reported || !event || event.operationId !== operationId
        || (event.ok && !documentPreparationResultMatches(pending.operation, event.result))) {
        stop(new Error("The document decoder returned an invalid result."));
        return;
      }
      reported = event;
      try {
        child.postMessage({ type: "document.result-ack", operationId } satisfies DocumentPreparationWorkerRequest);
      } catch {
        stop(new Error("The document decoder acknowledgement could not be delivered."));
      }
    });
    child.once("error", () => stop(new Error("The document decoder stopped unexpectedly.")));
    child.once("exit", (code) => {
      exited = true;
      active = false;
      pending.resolveStopped();
      pending.resolveTermination();
      settle(stoppingError ?? (reported && code === (reported.ok ? 0 : 1)
        ? undefined : new Error("The document decoder stopped unexpectedly.")));
      pump();
    });
    if (pending.signal?.aborted) onAbort();
  };
  const pump = (): void => {
    while (!active && !poisoned && queued.length > 0) {
      const pending = queued.shift()!;
      if (pending.signal?.aborted || pending.operation.deadlineAt <= now()) {
        failBeforeSpawn(pending, new Error("Document preparation was cancelled or expired."));
      } else runNow(pending);
    }
  };
  return (operation, signal): DocumentPreparationExecution => {
    let resolve!: Pending["resolve"];
    let reject!: Pending["reject"];
    let resolveStopped!: Pending["resolveStopped"];
    let rejectStopped!: Pending["rejectStopped"];
    let resolveTermination!: Pending["resolveTermination"];
    const result = new Promise<DocumentPreparationResult>((yes, no) => { resolve = yes; reject = no; });
    const stopped = new Promise<void>((yes, no) => { resolveStopped = yes; rejectStopped = no; });
    const termination = new Promise<void>((yes) => { resolveTermination = yes; });
    let pending!: Pending;
    const onAbort = (): void => {
      const index = queued.indexOf(pending);
      if (index < 0) return;
      queued.splice(index, 1);
      failBeforeSpawn(pending, new Error("Document preparation was cancelled."));
    };
    pending = { operation, signal, onAbort, resolve, reject, resolveStopped, rejectStopped, resolveTermination };
    if (poisoned || signal?.aborted || !parseDocumentPreparationOperation(operation)
      || operation.deadlineAt <= now() || (active && queued.length >= 2)) {
      failBeforeSpawn(pending, poisoned ?? new Error("Document preparation is unavailable or exceeds its bounds."));
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
      queued.push(pending);
      pending.timer = setTimeout(() => {
        const index = queued.indexOf(pending);
        if (index < 0) return;
        queued.splice(index, 1);
        failBeforeSpawn(pending, new Error("Document preparation expired while queued."));
      }, Math.max(1, Math.min(DOCUMENT_PREPARATION_TIMEOUT_MS, operation.deadlineAt - now())));
      pending.timer.unref();
      pump();
    }
    return { result, stopped, termination };
  };
}
