import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import { durableId, durableTimestamp } from "./json";
import type { EffectState, JsonValue, OrchestrationEffect } from "./types";

interface EffectRow {
  sequence: number; id: string; project_id: string; thread_id: string;
  event_sequence: number; kind: string; replay_policy: "process-bound" | "replay-safe";
  runtime_id: string; state: EffectState; attempts: number; available_at: string;
  claim_id: string | null; claimed_at: string | null; settled_at: string | null;
  failure_code: string | null; payload_json: string;
}

export const MAX_EFFECT_ATTEMPTS = 5;
export const SETTLED_EFFECT_PRUNE_BATCH = 500;
export const EFFECT_WORKER_SLOT_WAIT = 30_000;
export const MALFORMED_EFFECT_PAYLOAD_CODE = "malformed-effect-payload";
export const PRIORITY_NON_BLOCKING_EFFECT_KINDS = ["provider.interrupt"] as const;

function tryParsePayload(payloadJson: string): { ok: true; value: JsonValue } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(payloadJson) as JsonValue };
  } catch {
    return { ok: false };
  }
}

function fromRow(row: EffectRow, parsedPayload?: JsonValue): OrchestrationEffect {
  const payload = parsedPayload !== undefined ? parsedPayload : (tryParsePayload(row.payload_json).ok
    ? (JSON.parse(row.payload_json) as JsonValue) : null);
  return {
    sequence: row.sequence, id: row.id, projectId: row.project_id, threadId: row.thread_id,
    eventSequence: row.event_sequence, kind: row.kind, replayPolicy: row.replay_policy,
    runtimeId: row.runtime_id, state: row.state, attempts: row.attempts,
    availableAt: row.available_at, claimId: row.claim_id, claimedAt: row.claimed_at,
    settledAt: row.settled_at, failureCode: row.failure_code,
    payload,
  };
}

function kindList(kinds: Iterable<string>): string {
  return JSON.stringify([...kinds].map((kind) => durableId(kind)));
}

const PRIORITY_KIND_JSON = kindList(PRIORITY_NON_BLOCKING_EFFECT_KINDS);

function validatePerKindCaps(perKindCaps: Readonly<Record<string, number>> | undefined): void {
  if (!perKindCaps) return;
  for (const [kind, cap] of Object.entries(perKindCaps)) {
    durableId(kind);
    if (!Number.isSafeInteger(cap) || cap < 0) {
      throw new Error(`Invalid orchestration effect per-kind cap for ${kind}.`);
    }
  }
}

const unblockedCandidate = `NOT EXISTS (SELECT 1 FROM orchestration_v2_effects predecessor
  WHERE predecessor.thread_id = candidate.thread_id AND predecessor.sequence < candidate.sequence
    AND predecessor.state IN ('pending','running')
    AND (candidate.kind NOT IN (SELECT value FROM json_each('${PRIORITY_KIND_JSON}'))
      OR predecessor.kind IN (SELECT value FROM json_each('${PRIORITY_KIND_JSON}'))))`;

export class OrchestrationEffectOutbox {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly database: Database.Database,
    readonly runtimeId: string,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {
    durableId(runtimeId);
  }

  get open(): boolean {
    return this.database.open;
  }

  /** @internal */
  get connection(): Database.Database {
    return this.database;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  get(id: string): OrchestrationEffect | null {
    const row = this.database.prepare("SELECT * FROM orchestration_v2_effects WHERE id = ?")
      .get(id) as EffectRow | undefined;
    return row ? fromRow(row) : null;
  }

  /** Terminal decisions can withdraw work that has not crossed the claim boundary. */
  retirePending(id: string, code: string): boolean {
    const retired = this.database.prepare(`UPDATE orchestration_v2_effects
      SET state = 'retired', settled_at = ?, failure_code = ?
      WHERE id = ? AND state = 'pending'`)
      .run(durableTimestamp(this.clock()), durableId(code), id).changes === 1;
    if (retired) this.notifyAvailable();
    return retired;
  }

  cancelUnsettled(threadId: string, kinds: readonly string[], code: string): string[] {
    durableId(threadId);
    if (kinds.length === 0) return [];
    const rows = this.database.prepare(`UPDATE orchestration_v2_effects
      SET state = 'retired', settled_at = ?, claim_id = NULL, claimed_at = NULL, failure_code = ?
      WHERE thread_id = ? AND state IN ('pending','running')
        AND kind IN (SELECT value FROM json_each(?))
      RETURNING id`).all(durableTimestamp(this.clock()), durableId(code), threadId, kindList(kinds)) as { id: string }[];
    if (rows.length > 0) this.notifyAvailable();
    return rows.map(({ id }) => id);
  }

  /** Call before accepting commands, once exclusive ownership of the runtime database is established. */
  recover(): { retired: number; replayable: number } {
    const recovered = this.database.transaction(() => {
      const now = durableTimestamp(this.clock());
      const retired = this.database.prepare(`UPDATE orchestration_v2_effects
        SET state = 'retired', settled_at = ?, claim_id = NULL, claimed_at = NULL,
          failure_code = 'runtime-lost'
        WHERE runtime_id <> ? AND replay_policy = 'process-bound' AND state IN ('pending','running')`)
        .run(now, this.runtimeId).changes;
      const replayable = this.database.prepare(`UPDATE orchestration_v2_effects
        SET state = 'pending', runtime_id = ?, claim_id = NULL, claimed_at = NULL
        WHERE runtime_id <> ? AND replay_policy = 'replay-safe' AND state IN ('pending','running')`)
        .run(this.runtimeId, this.runtimeId).changes;
      return { retired, replayable };
    }).immediate();
    if (recovered.retired + recovered.replayable > 0) this.notifyAvailable();
    return recovered;
  }

  /** One exact claim per lane. A delayed predecessor holds later effects in that thread unless its kind is passed over. */
  claim(id?: string, options: { passing?: Iterable<string> } = {}): OrchestrationEffect | null {
    const passing = options.passing === undefined ? null : kindList(options.passing);
    return this.claimWhere(id ?? null, null, passing === "[]" ? null : passing);
  }

  claimControl(id: string): OrchestrationEffect | null {
    durableId(id);
    let skippedMalformed = false;
    const claimed = this.database.transaction(() => {
      const now = durableTimestamp(this.clock());
      const row = this.database.prepare(`SELECT * FROM orchestration_v2_effects
        WHERE id = ? AND state = 'pending' AND runtime_id = ?`).get(id, this.runtimeId) as EffectRow | undefined;
      if (!row) return null;
      const parsed = tryParsePayload(row.payload_json);
      if (!parsed.ok) {
        this.markMalformedFailed(row.id, now);
        skippedMalformed = true;
        return null;
      }
      const claimId = randomUUID();
      const changed = this.database.prepare(`UPDATE orchestration_v2_effects
        SET state = 'running', claim_id = ?, claimed_at = ?, attempts = attempts + 1
        WHERE id = ? AND state = 'pending' AND runtime_id = ?`)
        .run(claimId, now, row.id, this.runtimeId).changes;
      if (changed !== 1) return null;
      return fromRow({ ...row, state: "running", claim_id: claimId, claimed_at: now, attempts: row.attempts + 1 }, parsed.value);
    }).immediate();
    if (skippedMalformed) this.notifyAvailable();
    return claimed;
  }

  claimNext(kinds: Iterable<string>, options: { perKindCaps?: Readonly<Record<string, number>> } = {}): OrchestrationEffect | null {
    validatePerKindCaps(options.perKindCaps);
    const kindArray = [...kinds].map((kind) => durableId(kind));
    if (kindArray.length === 0) return null;
    return this.claimWhere(null, kindArray, null, options.perKindCaps);
  }

  unsettledBefore(threadId: string, sequence: number, kinds: Iterable<string>): string[] {
    durableId(threadId);
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Invalid effect sequence.");
    const list = kindList(kinds);
    if (list === "[]") return [];
    return (this.database.prepare(`SELECT id FROM orchestration_v2_effects
      WHERE thread_id = ? AND sequence < ? AND state IN ('pending','running')
        AND kind IN (SELECT value FROM json_each(?)) ORDER BY sequence`)
      .all(threadId, sequence, list) as { id: string }[]).map(({ id }) => id);
  }

  nextClaimableAt(kinds: Iterable<string>, options: { perKindCaps?: Readonly<Record<string, number>> } = {}): string | null {
    validatePerKindCaps(options.perKindCaps);
    const eligible = this.filterKindsByCaps([...kinds].map((kind) => durableId(kind)), options.perKindCaps);
    if (eligible.length === 0) return null;
    const list = JSON.stringify(eligible);
    const row = this.database.prepare(`SELECT MIN(candidate.available_at) AS available_at
      FROM orchestration_v2_effects candidate
      WHERE candidate.state = 'pending' AND candidate.runtime_id = ?
        AND candidate.kind IN (SELECT value FROM json_each(?)) AND ${unblockedCandidate}`)
      .get(this.runtimeId, list) as { available_at: string | null } | undefined;
    return row?.available_at ?? null;
  }

  settle(effect: OrchestrationEffect, outcome: { kind: "succeeded" } | {
    kind: "failed";
    /** Stable classification only; never persist raw provider errors or secrets. */
    code: string;
    retryable?: boolean;
  }): boolean {
    if (!effect.claimId || effect.runtimeId !== this.runtimeId) return false;
    const now = durableTimestamp(this.clock());
    const retry = outcome.kind === "failed" && outcome.retryable === true
      && effect.replayPolicy === "replay-safe" && effect.attempts < MAX_EFFECT_ATTEMPTS;
    const state = retry ? "pending" : outcome.kind;
    const availableAt = retry
      ? new Date(Date.parse(now) + Math.min(30_000, 100 * 2 ** (effect.attempts - 1))).toISOString()
      : now;
    const code = outcome.kind === "failed" ? durableId(outcome.code) : null;
    const settled = this.database.prepare(`UPDATE orchestration_v2_effects
      SET state = ?, available_at = ?, claim_id = NULL, claimed_at = NULL,
        settled_at = ?, failure_code = ?
      WHERE id = ? AND runtime_id = ? AND state = 'running' AND claim_id = ? AND attempts = ?`)
      .run(state, availableAt, retry ? null : now, code, effect.id, this.runtimeId,
        effect.claimId, effect.attempts).changes === 1;
    if (settled) this.notifyAvailable();
    return settled;
  }

  requeue(effect: OrchestrationEffect): boolean {
    if (!effect.claimId || effect.runtimeId !== this.runtimeId) return false;
    const requeued = this.database.prepare(`UPDATE orchestration_v2_effects
      SET state = 'pending', available_at = ?, claim_id = NULL, claimed_at = NULL
      WHERE id = ? AND runtime_id = ? AND state = 'running' AND claim_id = ? AND attempts = ?`)
      .run(durableTimestamp(this.clock()), effect.id, this.runtimeId, effect.claimId, effect.attempts).changes === 1;
    if (requeued) this.notifyAvailable();
    return requeued;
  }

  pruneSettled(before: string, options: { kinds?: Iterable<string>; limit?: number } = {}): number {
    durableTimestamp(before);
    const limit = options.limit ?? SETTLED_EFFECT_PRUNE_BATCH;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("Invalid effect prune batch.");
    const kinds = options.kinds === undefined ? null : kindList(options.kinds);
    if (kinds === "[]") return 0;
    // Failed rows remain inspectable. Events and command receipts are not pruned here.
    return this.database.prepare(`DELETE FROM orchestration_v2_effects WHERE sequence IN (
      SELECT sequence FROM orchestration_v2_effects
      WHERE replay_policy = 'replay-safe' AND state IN ('succeeded','retired') AND settled_at < ?
        AND (? IS NULL OR kind IN (SELECT value FROM json_each(?)))
      ORDER BY sequence LIMIT ?)`)
      .run(before, kinds, kinds, limit).changes;
  }

  private filterKindsByCaps(kinds: readonly string[], perKindCaps: Readonly<Record<string, number>> | undefined): string[] {
    if (!perKindCaps || Object.keys(perKindCaps).length === 0) return [...kinds];
    const runningRows = this.database.prepare(`SELECT kind, COUNT(*) AS count FROM orchestration_v2_effects
      WHERE state = 'running' AND runtime_id = ? GROUP BY kind`)
      .all(this.runtimeId) as { kind: string; count: number }[];
    const runningByKind = new Map(runningRows.map(({ kind, count }) => [kind, count]));
    return kinds.filter((kind) => {
      if (!Object.hasOwn(perKindCaps, kind)) return true;
      const cap = perKindCaps[kind]!;
      return cap > 0 && (runningByKind.get(kind) ?? 0) < cap;
    });
  }

  private markMalformedFailed(id: string, now: string): void {
    this.database.prepare(`UPDATE orchestration_v2_effects
      SET state = 'failed', settled_at = ?, claim_id = NULL, claimed_at = NULL, failure_code = ?
      WHERE id = ? AND state = 'pending' AND runtime_id = ?`)
      .run(now, MALFORMED_EFFECT_PAYLOAD_CODE, id, this.runtimeId);
  }

  private claimWhere(
    id: string | null,
    kinds: readonly string[] | null,
    passing: string | null,
    perKindCaps?: Readonly<Record<string, number>>,
  ): OrchestrationEffect | null {
    let skippedMalformed = false;
    const claimed = this.database.transaction(() => {
      const now = durableTimestamp(this.clock());
      let kindJson: string | null = null;
      if (kinds !== null) {
        const eligible = this.filterKindsByCaps(kinds, perKindCaps);
        if (eligible.length === 0) return null;
        kindJson = JSON.stringify(eligible);
      }
      const select = this.database.prepare(`SELECT candidate.* FROM orchestration_v2_effects candidate
        WHERE candidate.state = 'pending' AND candidate.runtime_id = ? AND candidate.available_at <= ?
          AND (? IS NULL OR candidate.id = ?)
          AND (? IS NULL OR candidate.kind IN (SELECT value FROM json_each(?)))
          AND NOT EXISTS (SELECT 1 FROM orchestration_v2_effects predecessor
            WHERE predecessor.thread_id = candidate.thread_id AND predecessor.sequence < candidate.sequence
              AND predecessor.state IN ('pending','running')
              AND (? IS NULL OR predecessor.kind NOT IN (SELECT value FROM json_each(?)))
              AND (candidate.kind NOT IN (SELECT value FROM json_each(?))
                OR predecessor.kind IN (SELECT value FROM json_each(?))))
        ORDER BY CASE WHEN candidate.kind IN (SELECT value FROM json_each(?)) THEN 0 ELSE 1 END,
          candidate.sequence LIMIT 1`);
      for (;;) {
        const row = select.get(
          this.runtimeId, now, id, id, kindJson, kindJson, passing, passing,
          PRIORITY_KIND_JSON, PRIORITY_KIND_JSON, PRIORITY_KIND_JSON,
        ) as EffectRow | undefined;
        if (!row) return null;
        const parsed = tryParsePayload(row.payload_json);
        if (!parsed.ok) {
          this.markMalformedFailed(row.id, now);
          skippedMalformed = true;
          if (id !== null) return null;
          continue;
        }
        const claimId = randomUUID();
        const changed = this.database.prepare(`UPDATE orchestration_v2_effects
          SET state = 'running', claim_id = ?, claimed_at = ?, attempts = attempts + 1
          WHERE id = ? AND state = 'pending' AND runtime_id = ?`)
          .run(claimId, now, row.id, this.runtimeId).changes;
        if (changed !== 1) return null;
        return fromRow({ ...row, state: "running", claim_id: claimId, claimed_at: now, attempts: row.attempts + 1 }, parsed.value);
      }
    }).immediate();
    if (skippedMalformed) this.notifyAvailable();
    return claimed;
  }

  /**
   * Runs one write with the connection's busy timeout lowered to at most `ms`.
   * better-sqlite3 waits for a lock on the calling thread, so a recovery write
   * that retries must not wait the connection's full timeout on every attempt.
   * The statement is synchronous, so no other statement on this connection can
   * observe the lowered value.
   */
  withBusyTimeout<T>(ms: number, write: () => T): T {
    if (!Number.isSafeInteger(ms) || ms < 0) throw new Error("Invalid busy timeout.");
    const previous = this.database.pragma("busy_timeout", { simple: true }) as number;
    if (previous <= ms) return write();
    this.database.pragma(`busy_timeout = ${ms}`);
    try {
      return write();
    } finally {
      this.database.pragma(`busy_timeout = ${previous}`);
    }
  }

  notifyAvailable(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { continue; }
    }
  }
}

export interface EffectExecutionContext {
  readonly signal: AbortSignal;
  readonly willRetry: boolean;
}

export type EffectHandler = (effect: OrchestrationEffect, context: EffectExecutionContext) => Promise<void>;

export class OrchestrationEffectRejected extends Error {
  constructor(readonly code: string) {
    super(`Orchestration effect rejected: ${code}.`);
    this.name = "OrchestrationEffectRejected";
  }
}

export interface EffectFailure {
  readonly effect: OrchestrationEffect;
  readonly code: string;
  readonly willRetry: boolean;
}

/** How a recovery write is retried while the database stays locked. */
export interface EffectSettleRetryPolicy {
  /** Longest a single attempt waits for the lock, on the runtime thread. */
  readonly busyTimeoutMs: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  /** After this, the claim stays `running` and startup recovery owns it. */
  readonly budgetMs: number;
}

export const EFFECT_SETTLE_RETRY_POLICY: EffectSettleRetryPolicy = Object.freeze({
  busyTimeoutMs: 250,
  initialDelayMs: 100,
  maxDelayMs: 5_000,
  budgetMs: 60_000,
});

export interface OrchestrationEffectDispatcherOptions {
  readonly concurrency?: number;
  readonly slotWaitMs?: number;
  readonly perKindCaps?: Readonly<Record<string, number>>;
  readonly onFailure?: (failure: EffectFailure) => void;
  readonly afterTask?: () => void;
  readonly settleRetry?: EffectSettleRetryPolicy;
}

const SHUTDOWN = Symbol("orchestration-effect-shutdown");

/** Recorded when a process-bound effect ran but its success could not be written. */
export const EFFECT_SETTLE_FAILED_CODE = "effect-settle-failed";

/**
 * SQLite reports a write that outlasted the connection's busy timeout as
 * SQLITE_BUSY (or an extended SQLITE_BUSY_* code), and shared-cache lock
 * contention as SQLITE_LOCKED. Both clear once the other writer commits.
 */
export function isDatabaseLockTimeout(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^SQLITE_(?:BUSY|LOCKED)(?:_|$)/u.test(code);
}

interface ActiveEffectTask {
  readonly kind: string;
  readonly controller: AbortController;
  task: Promise<void>;
  slotted: boolean;
  slotTimer: ReturnType<typeof setTimeout> | null;
}

export class OrchestrationEffectDispatcher {
  private readonly active = new Map<string, ActiveEffectTask>();
  private readonly concurrency: number;
  private readonly slotWaitMs: number;
  private readonly perKindCaps: Readonly<Record<string, number>> | undefined;
  private readonly shutdown = new AbortController();
  private readonly settleRetry: EffectSettleRetryPolicy;
  private closed = false;

  constructor(
    private readonly outbox: OrchestrationEffectOutbox,
    private readonly handlers: ReadonlyMap<string, EffectHandler>,
    private readonly options: OrchestrationEffectDispatcherOptions = {},
  ) {
    this.concurrency = options.concurrency ?? 4;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 32) {
      throw new Error("Invalid orchestration effect concurrency.");
    }
    this.slotWaitMs = options.slotWaitMs ?? EFFECT_WORKER_SLOT_WAIT;
    if (!Number.isSafeInteger(this.slotWaitMs) || this.slotWaitMs < 1) {
      throw new Error("Invalid orchestration effect slot wait.");
    }
    validatePerKindCaps(options.perKindCaps);
    this.perKindCaps = options.perKindCaps ? { ...options.perKindCaps } : undefined;
    this.settleRetry = options.settleRetry ?? EFFECT_SETTLE_RETRY_POLICY;
  }

  get inFlight(): number {
    return this.active.size;
  }

  get saturated(): boolean {
    return this.slottedCount() >= this.concurrency;
  }

  pump(): number {
    let claimed = 0;
    while (!this.closed && this.slottedCount() < this.concurrency && this.handlers.size > 0) {
      const eligibleKinds = this.eligibleKinds();
      if (eligibleKinds.length === 0) break;
      const effect = this.outbox.claimNext(eligibleKinds, this.perKindCaps ? { perKindCaps: this.perKindCaps } : undefined);
      if (!effect) break;
      claimed += 1;
      const controller = new AbortController();
      const entry: ActiveEffectTask = {
        kind: effect.kind,
        controller,
        task: Promise.resolve(),
        slotted: true,
        slotTimer: null,
      };
      const slotTimer = setTimeout(() => {
        if (entry.slotTimer === slotTimer) entry.slotTimer = null;
        if (entry.slotted) {
          entry.slotted = false;
          if (!this.closed) this.options.afterTask?.();
        }
      }, this.slotWaitMs);
      slotTimer.unref?.();
      entry.slotTimer = slotTimer;
      const task = Promise.resolve()
        .then(() => this.execute(effect, controller.signal))
        .catch(() => undefined)
        .finally(() => {
          if (entry.slotTimer) {
            clearTimeout(entry.slotTimer);
            entry.slotTimer = null;
          }
          if (this.active.get(effect.id)?.task === task) this.active.delete(effect.id);
          if (!this.closed) this.options.afterTask?.();
        });
      entry.task = task;
      this.active.set(effect.id, entry);
    }
    return claimed;
  }

  cancel(effectIds: readonly string[]): void {
    for (const id of effectIds) this.active.get(id)?.controller.abort(new Error("Orchestration effect cancelled."));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.shutdown.abort(SHUTDOWN);
    for (const entry of this.active.values()) {
      if (entry.slotTimer) {
        clearTimeout(entry.slotTimer);
        entry.slotTimer = null;
      }
      entry.controller.abort(SHUTDOWN);
    }
    await Promise.allSettled([...this.active.values()].map(({ task }) => task));
  }

  private slottedCount(): number {
    let count = 0;
    for (const entry of this.active.values()) if (entry.slotted) count += 1;
    return count;
  }

  private eligibleKinds(): string[] {
    if (!this.perKindCaps) return [...this.handlers.keys()];
    const runningByKind = new Map<string, number>();
    for (const entry of this.active.values()) {
      runningByKind.set(entry.kind, (runningByKind.get(entry.kind) ?? 0) + 1);
    }
    const eligible: string[] = [];
    for (const kind of this.handlers.keys()) {
      if (Object.hasOwn(this.perKindCaps, kind)) {
        const cap = this.perKindCaps[kind]!;
        if (cap <= 0 || (runningByKind.get(kind) ?? 0) >= cap) continue;
      }
      eligible.push(kind);
    }
    return eligible;
  }

  private async execute(effect: OrchestrationEffect, signal: AbortSignal): Promise<void> {
    let current: OrchestrationEffect | null;
    try {
      current = this.outbox.get(effect.id);
    } catch {
      await this.whileLocked(() => this.outbox.requeue(effect), signal);
      return;
    }
    if (signal.aborted || current?.state !== "running" || current.claimId !== effect.claimId) return;
    const handler = this.handlers.get(effect.kind);
    if (!handler) {
      await this.whileLocked(() => this.outbox.requeue(effect), signal);
      return;
    }
    const willRetry = effect.replayPolicy === "replay-safe" && effect.attempts < MAX_EFFECT_ATTEMPTS;
    try {
      await handler(effect, { signal, willRetry });
    } catch (error) {
      if (signal.aborted) return;
      const rejected = error instanceof OrchestrationEffectRejected;
      const code = rejected ? error.code : "effect-execution-failed";
      const retries = !rejected && willRetry;
      const settled = await this.settleOrRecover(
        () => this.outbox.settle(effect, { kind: "failed", code, retryable: !rejected }),
        retries
          ? () => this.outbox.requeue(effect)
          : () => this.outbox.settle(effect, { kind: "failed", code }),
        signal,
      );
      if (settled) {
        try {
          this.options.onFailure?.({ effect, code, willRetry: retries });
        } catch {
          return;
        }
      }
      return;
    }
    if (signal.aborted && signal.reason !== SHUTDOWN) return;
    await this.settleOrRecover(
      () => this.outbox.settle(effect, { kind: "succeeded" }),
      // A replay-safe effect may run again; a process-bound one never does.
      effect.replayPolicy === "replay-safe"
        ? () => this.outbox.requeue(effect)
        : () => this.outbox.settle(effect, { kind: "failed", code: EFFECT_SETTLE_FAILED_CODE }),
      signal,
    );
  }

  /**
   * Only the claiming dispatcher settles its row, and a running row holds every
   * later effect in its thread. The outcome is written once; if that write
   * throws, a recovery write is retried while the database stays locked.
   */
  private async settleOrRecover(settle: () => boolean, recover: () => boolean, signal: AbortSignal): Promise<boolean> {
    try {
      return settle();
    } catch {
      return await this.whileLocked(recover, signal);
    }
  }

  /**
   * Unlike T3, whose SQLite runs off the main thread, a locked write here
   * blocks the runtime thread for its busy timeout. Each attempt therefore
   * waits at most `busyTimeoutMs`, attempts back off exponentially, and after
   * `budgetMs` the claim is left `running`: the next startup requeues a
   * replay-safe row and retires a process-bound one as `runtime-lost`. The loop
   * also ends when the write lands or is fenced off (`false`), fails for
   * another reason, the effect is cancelled, or the dispatcher closes.
   */
  private async whileLocked(write: () => boolean, signal?: AbortSignal): Promise<boolean> {
    const policy = this.settleRetry;
    const deadline = Date.now() + policy.budgetMs;
    let delay = policy.initialDelayMs;
    for (;;) {
      try {
        return this.outbox.withBusyTimeout(policy.busyTimeoutMs, write);
      } catch (error) {
        if (!isDatabaseLockTimeout(error) || this.closed || !this.outbox.open || signal?.aborted) return false;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !await this.pause(Math.min(delay, remaining), signal)) return false;
      delay = Math.min(delay * 2, policy.maxDelayMs);
    }
  }

  private pause(ms: number, cancelled?: AbortSignal): Promise<boolean> {
    const signals = [this.shutdown.signal, ...(cancelled ? [cancelled] : [])];
    if (signals.some(({ aborted }) => aborted)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (resumed: boolean): void => {
        clearTimeout(timer);
        for (const signal of signals) signal.removeEventListener("abort", onAbort);
        resolve(resumed);
      };
      const onAbort = (): void => { done(false); };
      const timer = setTimeout(() => { done(true); }, ms);
      timer.unref?.();
      for (const signal of signals) signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
