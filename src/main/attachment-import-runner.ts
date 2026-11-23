import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

import type { UtilityProcess } from "electron";

import { isExtractedDocumentAttachmentMimeType } from "../shared/attachments.js";
import {
  AttachmentImportValidationError,
  type AttachmentImportDocumentExtractExecution,
  type AttachmentImportDocumentExtractOperation,
  type AttachmentImportDocumentExtractResult,
  type AttachmentImportFileOperation,
  type AttachmentImportValidationExecution,
  type AttachmentImportValidationReceipt,
  type AttachmentImportValidationRunner,
} from "./attachment-import-file.js";
import {
  attachmentImportFailureError,
  parseAttachmentImportExtractWorkerEvent,
  parseAttachmentImportWorkerEvent,
  type AttachmentImportWorkerRequest,
} from "./attachment-import-worker-protocol.js";

const IMPORT_TIMEOUT_MS = 30_000;
export const DOCUMENT_IMPORT_TIMEOUT_MS = 15_000;
const IMPORT_KILL_GRACE_MS = 3_000;
const MAX_ACTIVE_IMPORTS = 2;
const MAX_PENDING_IMPORTS = 16;

export interface AttachmentImportUtilityRunnerOptions {
  spawn(cwd: string): UtilityProcess;
  timeoutMs?: number;
  killGraceMs?: number;
  maxActiveOperations?: number;
  maxPendingOperations?: number;
}

type RunnerRequest =
  | { readonly kind: "validate"; readonly operation: AttachmentImportFileOperation }
  | { readonly kind: "extract"; readonly operation: AttachmentImportDocumentExtractOperation };

interface RunnerJob {
  readonly request: RunnerRequest;
  readonly signal: AbortSignal | undefined;
  readonly resolveResult: (value: unknown) => void;
  readonly rejectResult: (error: Error) => void;
  readonly resolveStopped: () => void;
  readonly rejectStopped: (error: Error) => void;
  readonly onAbort: () => void;
}

function cancelled(): Error {
  return new Error("Attachment import was cancelled.");
}

function unavailable(message: string): Error {
  return new Error(message);
}

export function createAttachmentImportUtilityRunner(
  options: AttachmentImportUtilityRunnerOptions,
): AttachmentImportValidationRunner {
  const defaultTimeoutMs = Math.max(
    1,
    Math.min(Math.trunc(options.timeoutMs ?? IMPORT_TIMEOUT_MS), 60_000),
  );
  const documentTimeoutMs = Math.max(
    1,
    Math.min(
      Math.trunc(options.timeoutMs ?? DOCUMENT_IMPORT_TIMEOUT_MS),
      60_000,
    ),
  );
  const killGraceMs = Math.max(
    1,
    Math.min(
      Math.trunc(options.killGraceMs ?? IMPORT_KILL_GRACE_MS),
      10_000,
    ),
  );
  const maxActiveOperations = Math.max(
    1,
    Math.min(Math.trunc(
      options.maxActiveOperations ?? MAX_ACTIVE_IMPORTS,
    ), 8),
  );
  const maxPendingOperations = Math.max(
    0,
    Math.min(Math.trunc(
      options.maxPendingOperations ?? MAX_PENDING_IMPORTS,
    ), 64),
  );
  let activeOperations = 0;
  let closed = false;
  let poisonError: Error | null = null;
  let shutdownPromise: Promise<boolean> | null = null;
  const queued: RunnerJob[] = [];
  const activeControllers = new Set<AbortController>();
  const activeStops = new Set<Promise<void>>();

  const failQueued = (next: RunnerJob, error: Error): void => {
    next.signal?.removeEventListener("abort", next.onAbort);
    next.rejectResult(error);
    next.rejectStopped(error);
  };
  const poison = (): Error => {
    poisonError ??= unavailable(
      "Attachment validation utility shutdown is unconfirmed.",
    );
    for (const next of queued.splice(0)) failQueued(next, poisonError);
    for (const controller of activeControllers) controller.abort();
    return poisonError;
  };

  const runJobNow = (
    job: RunnerRequest,
    signal?: AbortSignal,
  ): { readonly result: Promise<unknown>; readonly stopped: Promise<void> } => {
    const operationId = randomUUID();
    const documentJob = job.kind === "extract"
      || isExtractedDocumentAttachmentMimeType(job.operation.mimeType);
    const timeoutMs = documentJob ? documentTimeoutMs : defaultTimeoutMs;
    let resolveStopped!: () => void;
    let rejectStopped!: (error: Error) => void;
    const stopped = new Promise<void>((resolve, reject) => {
      resolveStopped = resolve;
      rejectStopped = reject;
    });
    if (signal?.aborted) {
      resolveStopped();
      return { result: Promise.reject(cancelled()), stopped };
    }
    let child: UtilityProcess;
    try {
      child = options.spawn(job.kind === "validate" ? job.operation.root : tmpdir());
    } catch {
      resolveStopped();
      return {
        result: Promise.reject(unavailable(
          "Attachment validation utility could not be started.",
        )),
        stopped,
      };
    }
    const result = new Promise<unknown>((resolveImport, rejectImport) => {
      let reportedValidate: ReturnType<typeof parseAttachmentImportWorkerEvent> = null;
      let reportedExtract: ReturnType<typeof parseAttachmentImportExtractWorkerEvent> = null;
      let stoppingError: Error | null = null;
      let killGraceTimer: NodeJS.Timeout | null = null;
      let settled = false;
      let spawned = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        if (killGraceTimer) clearTimeout(killGraceTimer);
        signal?.removeEventListener("abort", onAbort);
      };
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          rejectImport(error);
          return;
        }
        if (job.kind === "validate") {
          if (!reportedValidate) {
            rejectImport(unavailable(
              "Attachment validation utility stopped before replying.",
            ));
            return;
          }
          if (!reportedValidate.ok) {
            rejectImport(attachmentImportFailureError(reportedValidate));
            return;
          }
          resolveImport(reportedValidate.receipt);
          return;
        }
        if (!reportedExtract) {
          rejectImport(unavailable(
            "Attachment validation utility stopped before replying.",
          ));
          return;
        }
        if (!reportedExtract.ok) {
          rejectImport(new AttachmentImportValidationError(reportedExtract.code));
          return;
        }
        resolveImport({
          text: reportedExtract.text,
          truncated: reportedExtract.truncated,
        } satisfies AttachmentImportDocumentExtractResult);
      };
      const stop = (error: Error): void => {
        if (stoppingError || settled) return;
        stoppingError = error;
        child.kill();
        killGraceTimer = setTimeout(() => {
          const unconfirmed = unavailable(
            "Attachment validation utility shutdown is unconfirmed.",
          );
          rejectStopped(unconfirmed);
          settle(error);
        }, killGraceMs);
        killGraceTimer.unref();
      };
      const onAbort = (): void => stop(cancelled());
      const timer = setTimeout(() => {
        stop(documentJob
          ? new AttachmentImportValidationError("document-limit")
          : unavailable("Attachment validation timed out."));
      }, timeoutMs);
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
      child.once("spawn", () => {
        spawned = true;
        if (stoppingError) {
          child.kill();
          return;
        }
        if (signal?.aborted) {
          onAbort();
          return;
        }
        try {
          child.postMessage(
            job.kind === "validate"
              ? ({
                  type: "attachment-import.validate",
                  operationId,
                  operation: job.operation,
                } satisfies AttachmentImportWorkerRequest)
              : ({
                  type: "attachment-import.extract",
                  operationId,
                  operation: job.operation,
                } satisfies AttachmentImportWorkerRequest),
          );
        } catch {
          stop(unavailable(
            "Attachment validation request could not be delivered.",
          ));
        }
      });
      child.on("message", (value) => {
        if (!spawned) {
          stop(unavailable(
            "Attachment validation returned a result before startup.",
          ));
          return;
        }
        if (job.kind === "validate") {
          const event = parseAttachmentImportWorkerEvent(value);
          if (!event || event.operationId !== operationId || reportedValidate) {
            stop(unavailable(
              "Attachment validation returned an invalid result.",
            ));
            return;
          }
          reportedValidate = event;
        } else {
          const event = parseAttachmentImportExtractWorkerEvent(value);
          if (!event || event.operationId !== operationId || reportedExtract) {
            stop(unavailable(
              "Attachment validation returned an invalid result.",
            ));
            return;
          }
          reportedExtract = event;
        }
        try {
          child.postMessage({
            type: "attachment-import.result-ack",
            operationId,
          } satisfies AttachmentImportWorkerRequest);
        } catch {
          stop(unavailable(
            "Attachment validation acknowledgement could not be delivered.",
          ));
        }
      });
      child.once("error", () => {
        if (!spawned) {
          stoppingError ??= unavailable(
            "Attachment validation utility could not be started.",
          );
          resolveStopped();
          settle(stoppingError);
          return;
        }
        stop(unavailable(
          "Attachment validation utility stopped unexpectedly.",
        ));
      });
      (child as unknown as {
        once(
          event: "exit",
          listener: (code: number, signal?: string) => void,
        ): void;
      }).once("exit", (code, exitSignal) => {
        if (killGraceTimer) clearTimeout(killGraceTimer);
        resolveStopped();
        const reportedOk = job.kind === "validate"
          ? reportedValidate?.ok === true
          : reportedExtract?.ok === true;
        const expectedExit = reportedOk ? code === 0 : code === 1;
        settle(stoppingError ?? (
          expectedExit && !exitSignal
            ? undefined
            : unavailable(
                "Attachment validation utility stopped unexpectedly.",
              )
        ));
      });
    });
    return { result, stopped };
  };

  const pump = (): void => {
    while (
      !closed
      && !poisonError
      && activeOperations < maxActiveOperations
      && queued.length > 0
    ) {
      const next = queued.shift();
      if (!next) return;
      next.signal?.removeEventListener("abort", next.onAbort);
      if (next.signal?.aborted) {
        next.rejectResult(cancelled());
        next.resolveStopped();
        continue;
      }
      activeOperations += 1;
      const controller = new AbortController();
      activeControllers.add(controller);
      const signal = next.signal
        ? AbortSignal.any([next.signal, controller.signal])
        : controller.signal;
      const running = runJobNow(next.request, signal);
      activeStops.add(running.stopped);
      void running.result.then(next.resolveResult, next.rejectResult);
      void running.stopped.then(
        next.resolveStopped,
        () => next.rejectStopped(poison()),
      ).finally(() => {
        activeStops.delete(running.stopped);
        activeControllers.delete(controller);
        activeOperations -= 1;
        pump();
      });
    }
  };

  const enqueue = <T>(
    request: RunnerRequest,
    signal?: AbortSignal,
  ): { readonly result: Promise<T>; readonly stopped: Promise<void> } => {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (error: Error) => void;
    let resolveStopped!: () => void;
    let rejectStopped!: (error: Error) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const stopped = new Promise<void>((resolve, reject) => {
      resolveStopped = resolve;
      rejectStopped = reject;
    });
    if (closed || poisonError || signal?.aborted) {
      const error = poisonError ?? (signal?.aborted
        ? cancelled()
        : unavailable("Attachment validation utility is unavailable."));
      rejectResult(error);
      if (poisonError) rejectStopped(error);
      else resolveStopped();
      return { result, stopped };
    }
    if (
      activeOperations >= maxActiveOperations
      && queued.length >= maxPendingOperations
    ) {
      rejectResult(unavailable(
        "Attachment validation is at bounded capacity.",
      ));
      resolveStopped();
      return { result, stopped };
    }
    const next: RunnerJob = {
      request,
      signal,
      resolveResult: (value) => resolveResult(value as T),
      rejectResult,
      resolveStopped,
      rejectStopped,
      onAbort: () => {
        const index = queued.indexOf(next);
        if (index < 0) return;
        queued.splice(index, 1);
        next.signal?.removeEventListener("abort", next.onAbort);
        next.rejectResult(cancelled());
        next.resolveStopped();
      },
    };
    signal?.addEventListener("abort", next.onAbort, { once: true });
    queued.push(next);
    pump();
    return { result, stopped };
  };

  const run: AttachmentImportValidationRunner = Object.assign(
    (
      operation: AttachmentImportFileOperation,
      signal?: AbortSignal,
    ): AttachmentImportValidationExecution =>
      enqueue<AttachmentImportValidationReceipt>({ kind: "validate", operation }, signal),
    {
      extract: (
        operation: AttachmentImportDocumentExtractOperation,
        signal?: AbortSignal,
      ): AttachmentImportDocumentExtractExecution =>
        enqueue<AttachmentImportDocumentExtractResult>({ kind: "extract", operation }, signal),
      shutdown: (): Promise<boolean> => {
        if (shutdownPromise) return shutdownPromise;
        closed = true;
        const shutdownError = unavailable(
          "Attachment validation utility is unavailable.",
        );
        for (const next of queued.splice(0)) failQueued(next, shutdownError);
        for (const controller of activeControllers) controller.abort();
        shutdownPromise = Promise.allSettled(activeStops).then((results) =>
          !poisonError && results.every(({ status }) => status === "fulfilled"));
        return shutdownPromise;
      },
    },
  );

  return run;
}
