import { randomUUID } from "node:crypto";
import type { UtilityProcess } from "electron";
import { resolve } from "node:path";

import {
  secureFilePathSegments,
  type SecureFileRequest,
  type SecureFileResult,
} from "../node/secure-file-protocol.js";
import {
  parseSecureFileWorkerEvent,
  type SecureFileWorkerRequest,
} from "./secure-file-worker-protocol.js";

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_KILL_GRACE_MS = 3_000;
const MAX_ACTIVE_HELPERS = 4;
const MAX_PENDING_HELPERS = 64;

interface SlotWaiter {
  signal: AbortSignal | undefined;
  onAbort: (() => void) | null;
  resolve: (acquired: boolean) => void;
}

export interface SecureFileBrokerOptions {
  spawn(parent: string): UtilityProcess;
  retryUnconfirmedShutdown?: boolean;
  timeoutMs?: number;
  killGraceMs?: number;
}

export class SecureFileBroker {
  private readonly timeoutMs: number;
  private readonly killGraceMs: number;
  private readonly active = new Set<UtilityProcess>();
  private readonly activeWaiters = new Set<(stopped: boolean) => void>();
  private readonly operationControllers = new Set<AbortController>();
  private readonly activeOperations = new Set<Promise<SecureFileResult>>();
  private readonly poisonedTargets = new Set<string>();
  private readonly unconfirmedTargets = new Set<string>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly slotWaiters: SlotWaiter[] = [];
  private activeSlots = 0;
  private pending = 0;
  private closed = false;
  private shutdownPromise: Promise<boolean> | null = null;

  constructor(private readonly options: SecureFileBrokerOptions) {
    this.timeoutMs = Math.max(
      1,
      Math.min(Math.trunc(options.timeoutMs ?? DEFAULT_TIMEOUT_MS), 30_000),
    );
    this.killGraceMs = Math.max(
      1,
      Math.min(
        Math.trunc(options.killGraceMs ?? DEFAULT_KILL_GRACE_MS),
        10_000,
      ),
    );
  }

  perform(
    request: SecureFileRequest,
    signal?: AbortSignal,
  ): Promise<SecureFileResult> {
    if (
      this.closed
      || signal?.aborted
      || this.pending >= MAX_PENDING_HELPERS
    ) {
      return Promise.resolve({
        ok: false,
        code: "unavailable",
        message: signal?.aborted
          ? "The secure file operation was cancelled."
          : this.closed
            ? "The secure file service is unavailable."
            : "The secure file service is busy.",
      });
    }
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onExternalAbort, { once: true });
    this.operationControllers.add(controller);
    this.pending += 1;
    const normalizedPath = (
      process.platform === "win32" || process.platform === "darwin"
        ? request.path.normalize("NFC").toLocaleLowerCase("en-US")
        : request.path
    );
    const key = [
      request.rootIdentity.dev,
      request.rootIdentity.ino,
      normalizedPath,
    ].join("\0");
    const predecessor = this.tails.get(key) ?? Promise.resolve();
    let releaseTail = (): void => undefined;
    const tailGate = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    const tail = predecessor.catch(() => undefined).then(() => tailGate);
    this.tails.set(key, tail);
    const operation = predecessor.catch(() => undefined).then(async () => {
      const poisoned = this.poisonedTargets.has(key);
      if (
        this.closed
        || (
          poisoned
          && (
            request.operation !== "recover"
            || this.unconfirmedTargets.has(key)
          )
        )
      ) {
        return {
          ok: false,
          code: "unavailable",
          message: this.poisonedTargets.has(key)
            ? "A previous secure file operation has not been recovered safely."
            : "The secure file service is unavailable.",
        } satisfies SecureFileResult;
      }
      const acquired = await this.acquireSlot(controller.signal);
      if (!acquired) {
        return {
          ok: false,
          code: "unavailable",
          message: "The secure file operation was cancelled.",
        } satisfies SecureFileResult;
      }
      let releaseSlotOnReturn = true;
      try {
        const outcome = await this.run(
          request,
          key,
          controller.signal,
          () => this.releaseSlot(),
        );
        if (
          request.operation === "recover"
          && outcome.exitConfirmed
          && outcome.result.ok
          && outcome.result.operation === "recover"
        ) {
          this.poisonedTargets.delete(key);
        }
        releaseSlotOnReturn = outcome.exitConfirmed
          && !this.unconfirmedTargets.has(key);
        return outcome.result;
      } finally {
        if (releaseSlotOnReturn) this.releaseSlot();
      }
    }).finally(() => {
      this.pending -= 1;
      releaseTail();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    let tracked: Promise<SecureFileResult>;
    tracked = operation.finally(() => {
      signal?.removeEventListener("abort", onExternalAbort);
      this.operationControllers.delete(controller);
      this.activeOperations.delete(tracked);
    });
    this.activeOperations.add(tracked);
    return tracked;
  }

  private run(
    request: SecureFileRequest,
    key: string,
    signal?: AbortSignal,
    onLateExit?: () => void,
  ): Promise<{ result: SecureFileResult; exitConfirmed: boolean }> {
    const operationId = randomUUID();
    let child: UtilityProcess;
    try {
      const segments = secureFilePathSegments(request.path);
      if (!segments) {
        throw new Error("Invalid secure file path.");
      }
      child = this.options.spawn(resolve(
        request.root,
        ...segments.slice(0, -1),
      ));
    } catch {
      return Promise.resolve({
        result: {
          ok: false,
          code: "unavailable",
          message: "The secure file service could not be started.",
        },
        exitConfirmed: true,
      });
    }
    this.trackChild(child);
    return new Promise((resolve) => {
      let settled = false;
      let exitConfirmed = false;
      let poisonedAfterReturn = false;
      let reported: SecureFileResult | null = null;
      let stoppingResult: SecureFileResult | null = null;
      let killGraceTimer: NodeJS.Timeout | null = null;
      let commitGraceTimer: NodeJS.Timeout | null = null;
      let commitInProgress = false;
      let commitStarted = false;
      let commitFinished = false;
      let killAccepted = false;
      let delivered = false;
      const settle = (
        result: SecureFileResult,
        confirmed: boolean,
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killGraceTimer) clearTimeout(killGraceTimer);
        if (commitGraceTimer) clearTimeout(commitGraceTimer);
        signal?.removeEventListener("abort", onAbort);
        if (confirmed) this.untrackChild(child);
        resolve({ result, exitConfirmed: confirmed });
      };
      const unavailable = (message: string): SecureFileResult => ({
        ok: false,
        code: "unavailable",
        message,
      });
      const killChild = (): void => {
        if (killAccepted || exitConfirmed) return;
        killAccepted = child.kill();
        if (killGraceTimer) return;
        killGraceTimer = setTimeout(() => {
          if (exitConfirmed || settled || !stoppingResult) return;
          this.poisonedTargets.add(key);
          this.unconfirmedTargets.add(key);
          poisonedAfterReturn = true;
          settle(stoppingResult, false);
        }, this.killGraceMs);
        killGraceTimer.unref();
      };
      const stop = (message: string): void => {
        if (stoppingResult || settled) return;
        stoppingResult = unavailable(message);
        if (!commitInProgress) {
          killChild();
          return;
        }
        // A worker that has claimed the target owns a bounded, journaled
        // commit window. Let it finish before escalating to process kill.
        commitGraceTimer = setTimeout(killChild, this.killGraceMs);
        commitGraceTimer.unref();
      };
      const onAbort = (): void => {
        stop("The secure file operation was cancelled.");
      };
      const timer = setTimeout(() => {
        stop("The secure file operation timed out.");
      }, this.timeoutMs);
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      child.once("spawn", () => {
        if (stoppingResult || settled) {
          killChild();
          return;
        }
        try {
          child.postMessage({
            type: "secure-file.perform",
            operationId,
            request,
          } satisfies SecureFileWorkerRequest);
          delivered = true;
        } catch {
          stop("The secure file request could not be delivered.");
        }
      });
      child.on("message", (value) => {
        const event = parseSecureFileWorkerEvent(value);
        if (!delivered || !event || event.operationId !== operationId) {
          stop("The secure file service returned an invalid result.");
          return;
        }
        if (event.type === "secure-file.commit") {
          if (
            request.operation !== "replace"
            || reported
            || (
              event.phase === "started"
                ? commitStarted
                : !commitInProgress || commitFinished
            )
          ) {
            stop("The secure file service returned an invalid result.");
            return;
          }
          commitInProgress = event.phase === "started";
          commitStarted ||= commitInProgress;
          commitFinished ||= !commitInProgress;
          if (!commitInProgress && stoppingResult) {
            if (commitGraceTimer) clearTimeout(commitGraceTimer);
            killChild();
          }
          return;
        }
        if (
          event.type !== "secure-file.result"
          || reported
          || commitInProgress
          || (request.operation === "replace" && commitStarted && !commitFinished)
        ) {
          stop("The secure file service returned an invalid result.");
          return;
        }
        reported = event.result;
        try {
          child.postMessage({
            type: "secure-file.result-ack",
            operationId,
          } satisfies SecureFileWorkerRequest);
        } catch {
          stop("The secure file result acknowledgement could not be delivered.");
        }
      });
      child.once("error", () => {
        stop("The secure file service stopped unexpectedly.");
      });
      child.once("exit", (code) => {
        exitConfirmed = true;
        if (killGraceTimer) clearTimeout(killGraceTimer);
        if (commitGraceTimer) clearTimeout(commitGraceTimer);
        if (poisonedAfterReturn) {
          this.unconfirmedTargets.delete(key);
          const recovery = request.operation === "replace" && delivered
            ? this.recoverAfterExit(request, key, onLateExit)
            : Promise.resolve(true);
          this.untrackChild(child);
          void recovery.then((recovered) => {
            if (recovered) this.poisonedTargets.delete(key);
            if (!this.unconfirmedTargets.has(key)) onLateExit?.();
          });
          return;
        }
        if (settled) {
          this.untrackChild(child);
          return;
        }
        if (
          !stoppingResult
          && reported
          && code !== (reported.ok ? 0 : 1)
        ) {
          stoppingResult = unavailable(
            "The secure file service stopped unexpectedly.",
          );
        }
        const result = stoppingResult
          ?? reported
          ?? unavailable(
            "The secure file service stopped before replying.",
          );
        const needsRecovery = request.operation === "replace" && delivered
          && Boolean(
            stoppingResult
            || !reported
            || (commitStarted && !reported.ok),
          );
        if (!needsRecovery) {
          settle(result, true);
          return;
        }
        const recovery = this.recoverAfterExit(request, key, onLateExit);
        this.untrackChild(child);
        void recovery.then((recovered) => {
          if (!recovered) this.poisonedTargets.add(key);
          settle(
            recovered
              ? result
              : unavailable(
                  "The secure file service could not verify save recovery.",
                ),
            true,
          );
        });
      });
    });
  }

  private recoverAfterExit(
    request: SecureFileRequest,
    key: string,
    onLateExit?: () => void,
  ): Promise<boolean> {
    const operationId = randomUUID();
    const segments = secureFilePathSegments(request.path);
    if (!segments) return Promise.resolve(false);
    const parent = resolve(request.root, ...segments.slice(0, -1));
    let child: UtilityProcess;
    try {
      child = this.options.spawn(parent);
    } catch {
      return Promise.resolve(false);
    }
    this.trackChild(child);
    this.unconfirmedTargets.add(key);
    return new Promise((resolveRecovery) => {
      let reported: boolean | null = null;
      let delivered = false;
      let exited = false;
      let settled = false;
      let failed = false;
      let killAccepted = false;
      let killTimer: NodeJS.Timeout | null = null;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        resolveRecovery(ok);
      };
      const killChild = (): void => {
        if (killAccepted || exited) return;
        killAccepted = child.kill();
      };
      const stop = (): void => {
        failed = true;
        if (exited) return;
        killChild();
        if (killTimer || settled) return;
        killTimer = setTimeout(() => {
          this.poisonedTargets.add(key);
          finish(false);
        }, this.killGraceMs);
        killTimer.unref();
      };
      const timeout = setTimeout(stop, this.timeoutMs);
      timeout.unref();
      child.once("spawn", () => {
        if (failed) {
          killChild();
          return;
        }
        try {
          child.postMessage({
            type: "secure-file.recover",
            operationId,
            request,
          } satisfies SecureFileWorkerRequest);
          delivered = true;
        } catch {
          stop();
        }
      });
      child.on("message", (value) => {
        const event = parseSecureFileWorkerEvent(value);
        if (
          failed
          || !delivered
          || event?.type !== "secure-file.recovery-result"
          || event.operationId !== operationId
          || reported !== null
        ) {
          stop();
          return;
        }
        reported = event.ok;
        try {
          child.postMessage({
            type: "secure-file.result-ack",
            operationId,
          } satisfies SecureFileWorkerRequest);
        } catch {
          stop();
        }
      });
      child.once("error", stop);
      child.once("exit", (code) => {
        const returnedAfterTimeout = settled;
        exited = true;
        this.untrackChild(child);
        this.unconfirmedTargets.delete(key);
        finish(
          !failed
          && delivered
          && reported === true
          && code === 0,
        );
        if (returnedAfterTimeout) onLateExit?.();
      });
    });
  }

  close(): void {
    void this.shutdown();
  }

  shutdown(): Promise<boolean> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closed = true;
    for (const controller of this.operationControllers) controller.abort();
    for (const waiter of this.slotWaiters.splice(0)) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(false);
    }
    const timeoutMs = Math.min(
      30_000,
      this.timeoutMs + this.killGraceMs * 2,
    );
    const resetRetryableShutdown = (): void => {
      if (
        this.options.retryUnconfirmedShutdown === true
        && this.shutdownPromise === shutdown
      ) this.shutdownPromise = null;
    };
    const shutdown = this.finishShutdown(timeoutMs).then((confirmed) => {
      if (
        !confirmed
      ) resetRetryableShutdown();
      return confirmed;
    }, (error: unknown) => {
      resetRetryableShutdown();
      throw error;
    });
    this.shutdownPromise = shutdown;
    return shutdown;
  }

  private async finishShutdown(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const operationsStopped = await this.waitBounded(
      Promise.allSettled(this.activeOperations).then(() => true),
      Math.max(1, deadline - Date.now()),
    );
    if (!operationsStopped) {
      for (const child of this.active) child.kill();
      return false;
    }
    if (this.active.size === 0) return true;
    for (const child of this.active) child.kill();
    return await this.waitForNoActive(Math.max(1, deadline - Date.now()));
  }

  private waitBounded(
    pending: Promise<boolean>,
    timeoutMs: number,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(false);
      }, timeoutMs);
      timer.unref();
      void pending.then((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  private waitForNoActive(timeoutMs: number): Promise<boolean> {
    if (this.active.size === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (stopped: boolean): void => {
        clearTimeout(timer);
        this.activeWaiters.delete(finish);
        resolve(stopped);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref();
      this.activeWaiters.add(finish);
      if (this.active.size === 0) finish(true);
    });
  }

  private trackChild(child: UtilityProcess): void {
    this.active.add(child);
  }

  private untrackChild(child: UtilityProcess): void {
    this.active.delete(child);
    if (this.active.size > 0) return;
    for (const finish of this.activeWaiters) finish(true);
  }

  private acquireSlot(signal?: AbortSignal): Promise<boolean> {
    if (this.closed || signal?.aborted) return Promise.resolve(false);
    if (this.activeSlots < MAX_ACTIVE_HELPERS) {
      this.activeSlots += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const waiter: SlotWaiter = {
        signal,
        onAbort: null,
        resolve,
      };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.slotWaiters.indexOf(waiter);
          if (index >= 0) this.slotWaiters.splice(index, 1);
          resolve(false);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.slotWaiters.push(waiter);
    });
  }

  private releaseSlot(): void {
    const waiter = this.slotWaiters.shift();
    if (!waiter) {
      this.activeSlots = Math.max(0, this.activeSlots - 1);
      return;
    }
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    waiter.resolve(true);
  }
}
