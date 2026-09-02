import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute } from "node:path";

import type {
  GitScanExecution,
  GitScanRequest,
  GitScanScope,
  ValidatedGitScanIdentity,
} from "./scan-contracts";
import { GitError } from "./types";

export type {
  GitScanExecution,
  GitScanRequest,
  GitScanScope,
  ValidatedGitScanIdentity,
} from "./scan-contracts";

/**
 * Refresh scans may run four repository keys at once. A repository-status scan
 * owns at most three simultaneous Git inspections (numstat plus the two remote
 * probes), so the shared logical process budget is twelve Git payloads. Linux
 * and macOS wrap each payload in one guardian, making the corresponding
 * operating-system descendant ceilings six per key and twenty-four globally.
 */
export const GIT_SCAN_MAX_CONCURRENT_KEYS = 4;
export const GIT_SCAN_PROCESS_BUDGET_PER_KEY = 3;
export const GIT_SCAN_GLOBAL_PROCESS_BUDGET =
  GIT_SCAN_MAX_CONCURRENT_KEYS * GIT_SCAN_PROCESS_BUDGET_PER_KEY;
export const GIT_SCAN_GUARDED_DESCENDANT_BUDGET_PER_KEY =
  GIT_SCAN_PROCESS_BUDGET_PER_KEY * 2;
export const GIT_SCAN_GLOBAL_GUARDED_DESCENDANT_BUDGET =
  GIT_SCAN_GLOBAL_PROCESS_BUDGET * 2;

const GIT_SCAN_TIMEOUT_MS = 15_000;

interface ScanRun<Result> {
  execute: (execution: GitScanExecution) => Promise<Result>;
  invalidation: number;
  promise: Promise<Result>;
  scope: GitScanScope;
}

interface Deferred<Result> {
  promise: Promise<Result>;
  reject: (error: unknown) => void;
  resolve: (value: Result) => void;
}

interface TrailingScan<Result> extends Deferred<Result> {
  execute: (execution: GitScanExecution) => Promise<Result>;
  invalidation: number;
  scope: GitScanScope;
}

interface ScanState<Result> {
  active: ScanRun<Result>;
  trailing: TrailingScan<Result> | null;
}

interface GateWaiter {
  cancel?: () => void;
  reject: (error: unknown) => void;
  resolve: (release: () => void) => void;
  signal?: AbortSignal;
  timer?: NodeJS.Timeout;
}

function timeoutError(): GitError {
  return new GitError("timeout", "Git inspection was cancelled.");
}

class ConcurrencyGate {
  private active = 0;
  private readonly waiters: GateWaiter[] = [];

  constructor(readonly limit: number) {}

  acquire(options: {
    deadlineAt?: number;
    signal?: AbortSignal;
  } = {}): Promise<() => void> {
    if (
      options.signal?.aborted
      || options.deadlineAt !== undefined && Date.now() >= options.deadlineAt
    ) {
      return Promise.reject(timeoutError());
    }
    return new Promise((resolve, reject) => {
      const waiter: GateWaiter = {
        reject,
        resolve,
        ...(options.signal ? { signal: options.signal } : {}),
      };
      const cancel = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.signal?.removeEventListener("abort", cancel);
        reject(timeoutError());
      };
      waiter.cancel = cancel;
      if (options.signal) {
        options.signal.addEventListener("abort", cancel, { once: true });
      }
      if (options.deadlineAt !== undefined) {
        waiter.timer = setTimeout(
          cancel,
          Math.max(1, options.deadlineAt - Date.now()),
        );
        waiter.timer.unref();
      }
      this.waiters.push(waiter);
      this.pump();
    });
  }

  get empty(): boolean {
    return this.active === 0 && this.waiters.length === 0;
  }

  private pump(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (waiter.timer) clearTimeout(waiter.timer);
      if (waiter.cancel) {
        waiter.signal?.removeEventListener("abort", waiter.cancel);
      }
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.pump();
      };
      if (waiter.signal?.aborted) {
        waiter.reject(timeoutError());
        continue;
      }
      this.active += 1;
      waiter.resolve(release);
    }
  }
}

const scanExecution = new AsyncLocalStorage<{ processKey: string }>();
const globalProcessGate = new ConcurrencyGate(GIT_SCAN_GLOBAL_PROCESS_BUDGET);
const processGatesByKey = new Map<string, ConcurrencyGate>();

/** Applies the documented process budget to every Git inspection. */
export async function withGitScanProcessSlot<Result>(
  options: { deadlineAt?: number; signal?: AbortSignal },
  operation: () => Promise<Result>,
): Promise<Result> {
  const processKey = scanExecution.getStore()?.processKey;
  const keyGate = processKey
    ? processGatesByKey.get(processKey)
      ?? new ConcurrencyGate(GIT_SCAN_PROCESS_BUDGET_PER_KEY)
    : null;
  if (processKey && keyGate && !processGatesByKey.has(processKey)) {
    processGatesByKey.set(processKey, keyGate);
  }
  const releaseKey = keyGate ? await keyGate.acquire(options) : null;
  let releaseGlobal: (() => void) | null = null;
  try {
    releaseGlobal = await globalProcessGate.acquire(options);
    return await operation();
  } finally {
    releaseGlobal?.();
    releaseKey?.();
    if (processKey && keyGate?.empty) processGatesByKey.delete(processKey);
  }
}

function scopeRank(scope: GitScanScope): number {
  return scope === "workspace" ? 1 : 0;
}

function broaderScope(left: GitScanScope, right: GitScanScope): GitScanScope {
  return scopeRank(left) >= scopeRank(right) ? left : right;
}

function deferred<Result>(): Deferred<Result> {
  let resolve!: (value: Result) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Result>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function waitForCaller<Result>(
  promise: Promise<Result>,
  request: Pick<GitScanRequest, "deadlineAt" | "signal">,
): Promise<Result> {
  if (
    request.signal?.aborted
    || request.deadlineAt !== undefined && Date.now() >= request.deadlineAt
  ) {
    return Promise.reject(timeoutError());
  }
  if (!request.signal && request.deadlineAt === undefined) return promise;
  return new Promise<Result>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      request.signal?.removeEventListener("abort", cancel);
      callback();
    };
    const cancel = (): void => finish(() => reject(timeoutError()));
    request.signal?.addEventListener("abort", cancel, { once: true });
    if (request.deadlineAt !== undefined) {
      timer = setTimeout(
        cancel,
        Math.max(1, request.deadlineAt - Date.now()),
      );
      timer.unref();
    }
    void promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/**
 * Coalesces refresh work without caching it. One scan may be active for a key;
 * invalidations or a status-to-workspace escalation merge into one trailing
 * scan whose execution uses the newest invalidation and broadest scope.
 */
export class GitScanCoordinator {
  private readonly activeKeyGate = new ConcurrencyGate(
    GIT_SCAN_MAX_CONCURRENT_KEYS,
  );
  private readonly invalidations = new Map<string, number>();
  private readonly states = new Map<string, ScanState<unknown>>();

  constructor(private readonly scanTimeoutMs = GIT_SCAN_TIMEOUT_MS) {}

  currentInvalidation(identity: ValidatedGitScanIdentity): number {
    return this.invalidations.get(identity.key) ?? 0;
  }

  invalidate(identity: ValidatedGitScanIdentity): number {
    const next = this.currentInvalidation(identity) + 1;
    this.invalidations.set(identity.key, next);
    return next;
  }

  request<Result>(
    request: GitScanRequest,
    execute: (execution: GitScanExecution) => Promise<Result>,
  ): Promise<Result> {
    if (
      !request.authorityGeneration
      || !request.optionsKey
      || !Number.isSafeInteger(request.invalidation)
      || request.invalidation < 0
    ) {
      return Promise.reject(new GitError(
        "invalid-input",
        "The Git scan identity is invalid.",
      ));
    }
    const key = JSON.stringify([
      request.identity.key,
      request.authorityGeneration,
      request.optionsKey,
    ]);
    const state = this.states.get(key) as ScanState<Result> | undefined;
    if (!state) {
      const created: ScanState<Result> = {
        active: this.start(key, request.invalidation, request.scope, execute),
        trailing: null,
      };
      this.states.set(key, created as ScanState<unknown>);
      this.observeCompletion(key, created, created.active);
      return waitForCaller(created.active.promise, request);
    }

    if (
      state.active.invalidation >= request.invalidation
      && scopeRank(state.active.scope) >= scopeRank(request.scope)
    ) {
      return waitForCaller(state.active.promise, request);
    }
    if (
      state.trailing
      && state.trailing.invalidation >= request.invalidation
      && scopeRank(state.trailing.scope) >= scopeRank(request.scope)
    ) {
      return waitForCaller(state.trailing.promise, request);
    }

    if (!state.trailing) {
      state.trailing = {
        ...deferred<Result>(),
        execute,
        invalidation: Math.max(
          state.active.invalidation,
          request.invalidation,
        ),
        scope: broaderScope(state.active.scope, request.scope),
      };
    } else {
      const replaceExecution =
        request.invalidation >= state.trailing.invalidation;
      state.trailing.invalidation = Math.max(
        state.trailing.invalidation,
        request.invalidation,
      );
      state.trailing.scope = broaderScope(
        state.trailing.scope,
        request.scope,
      );
      if (replaceExecution) state.trailing.execute = execute;
    }
    return waitForCaller(state.trailing.promise, request);
  }

  private start<Result>(
    processKey: string,
    invalidation: number,
    scope: GitScanScope,
    execute: (execution: GitScanExecution) => Promise<Result>,
  ): ScanRun<Result> {
    const deadlineAt = Date.now() + this.scanTimeoutMs;
    const promise = this.activeKeyGate.acquire({ deadlineAt }).then(async (release) => {
      const controller = new AbortController();
      const timedOut = deferred<never>();
      const timer = setTimeout(() => {
        controller.abort();
        timedOut.reject(timeoutError());
      }, Math.max(1, deadlineAt - Date.now()));
      timer.unref();
      try {
        const operation = scanExecution.run(
          { processKey },
          async () => await execute({
            deadlineAt,
            invalidation,
            scope,
            signal: controller.signal,
          }),
        );
        return await Promise.race([operation, timedOut.promise]);
      } finally {
        controller.abort();
        clearTimeout(timer);
        release();
      }
    });
    return { execute, invalidation, promise, scope };
  }

  private observeCompletion<Result>(
    key: string,
    state: ScanState<Result>,
    run: ScanRun<Result>,
  ): void {
    void run.promise.then(
      () => this.promoteTrailing(key, state, run),
      () => this.promoteTrailing(key, state, run),
    );
  }

  private promoteTrailing<Result>(
    key: string,
    state: ScanState<Result>,
    completed: ScanRun<Result>,
  ): void {
    if (state.active !== completed) return;
    const trailing = state.trailing;
    if (!trailing) {
      if (this.states.get(key) === state) this.states.delete(key);
      return;
    }
    state.trailing = null;
    const promoted = this.start(
      key,
      trailing.invalidation,
      trailing.scope,
      trailing.execute,
    );
    state.active = promoted;
    void promoted.promise.then(trailing.resolve, trailing.reject);
    this.observeCompletion(key, state, promoted);
  }
}

/**
 * Constructs a scan identity only after the caller has canonicalized the root
 * and validated the exact per-worktree/common Git metadata marker identity.
 */
export function validatedGitScanIdentity(
  repositoryRoot: string,
  metadataMarkerIdentity: string,
): ValidatedGitScanIdentity {
  if (
    !isAbsolute(repositoryRoot)
    || repositoryRoot.includes("\0")
    || !metadataMarkerIdentity
    || metadataMarkerIdentity.includes("\r")
    || metadataMarkerIdentity.includes("\n")
  ) {
    throw new GitError("invalid-input", "The Git scan identity is invalid.");
  }
  return Object.freeze({
    repositoryRoot,
    metadataMarkerIdentity,
    key: JSON.stringify([repositoryRoot, metadataMarkerIdentity]),
  });
}

export const gitScanCoordinator = new GitScanCoordinator();
