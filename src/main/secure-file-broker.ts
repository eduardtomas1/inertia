import type { UtilityProcess } from "electron";
import { resolve } from "node:path";

import {
  parseSecureFileResult,
  secureFilePathSegments,
  type SecureFileRequest,
  type SecureFileResult,
} from "../node/secure-file-protocol.js";

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
  timeoutMs?: number;
  killGraceMs?: number;
}

export class SecureFileBroker {
  private readonly timeoutMs: number;
  private readonly killGraceMs: number;
  private readonly active = new Set<UtilityProcess>();
  private readonly poisonedTargets = new Set<string>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly slotWaiters: SlotWaiter[] = [];
  private activeSlots = 0;
  private pending = 0;
  private closed = false;

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
          : "The secure file service is busy.",
      });
    }
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
    return predecessor.catch(() => undefined).then(async () => {
      if (this.closed || this.poisonedTargets.has(key)) {
        return {
          ok: false,
          code: "unavailable",
          message: this.poisonedTargets.has(key)
            ? "A previous secure file helper has not stopped."
            : "The secure file service is unavailable.",
        } satisfies SecureFileResult;
      }
      const acquired = await this.acquireSlot(signal);
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
          signal,
          () => this.releaseSlot(),
        );
        releaseSlotOnReturn = outcome.exitConfirmed;
        return outcome.result;
      } finally {
        if (releaseSlotOnReturn) this.releaseSlot();
      }
    }).finally(() => {
      this.pending -= 1;
      releaseTail();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
  }

  private run(
    request: SecureFileRequest,
    key: string,
    signal?: AbortSignal,
    onLateExit?: () => void,
  ): Promise<{ result: SecureFileResult; exitConfirmed: boolean }> {
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
    this.active.add(child);
    return new Promise((resolve) => {
      let settled = false;
      let exitConfirmed = false;
      let poisonedAfterReturn = false;
      let reported: SecureFileResult | null = null;
      let stoppingResult: SecureFileResult | null = null;
      let killGraceTimer: NodeJS.Timeout | null = null;
      const settle = (
        result: SecureFileResult,
        confirmed: boolean,
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killGraceTimer) clearTimeout(killGraceTimer);
        signal?.removeEventListener("abort", onAbort);
        if (confirmed) this.active.delete(child);
        resolve({ result, exitConfirmed: confirmed });
      };
      const unavailable = (message: string): SecureFileResult => ({
        ok: false,
        code: "unavailable",
        message,
      });
      const stop = (message: string): void => {
        if (stoppingResult || settled) return;
        stoppingResult = unavailable(message);
        child.kill();
        killGraceTimer = setTimeout(() => {
          if (exitConfirmed || settled || !stoppingResult) return;
          this.poisonedTargets.add(key);
          poisonedAfterReturn = true;
          settle(stoppingResult, false);
        }, this.killGraceMs);
        killGraceTimer.unref();
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
          child.kill();
          return;
        }
        try {
          child.postMessage(request);
        } catch {
          stop("The secure file request could not be delivered.");
        }
      });
      child.on("message", (value) => {
        const result = parseSecureFileResult(value);
        if (!result || reported) {
          stop("The secure file service returned an invalid result.");
          return;
        }
        reported = result;
      });
      child.once("error", () => {
        stop("The secure file service stopped unexpectedly.");
      });
      child.once("exit", () => {
        exitConfirmed = true;
        this.active.delete(child);
        if (killGraceTimer) clearTimeout(killGraceTimer);
        if (poisonedAfterReturn) {
          this.poisonedTargets.delete(key);
          onLateExit?.();
          return;
        }
        if (settled) return;
        settle(
          stoppingResult
            ?? reported
            ?? unavailable(
              "The secure file service stopped before replying.",
            ),
          true,
        );
      });
    });
  }

  close(): void {
    this.closed = true;
    for (const child of this.active) child.kill();
    this.active.clear();
    for (const waiter of this.slotWaiters.splice(0)) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(false);
    }
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
