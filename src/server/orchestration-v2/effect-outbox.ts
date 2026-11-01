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

function fromRow(row: EffectRow): OrchestrationEffect {
  return {
    sequence: row.sequence, id: row.id, projectId: row.project_id, threadId: row.thread_id,
    eventSequence: row.event_sequence, kind: row.kind, replayPolicy: row.replay_policy,
    runtimeId: row.runtime_id, state: row.state, attempts: row.attempts,
    availableAt: row.available_at, claimId: row.claim_id, claimedAt: row.claimed_at,
    settledAt: row.settled_at, failureCode: row.failure_code,
    payload: JSON.parse(row.payload_json) as JsonValue,
  };
}

function kindList(kinds: Iterable<string>): string {
  return JSON.stringify([...kinds].map((kind) => durableId(kind)));
}

const unblockedCandidate = `NOT EXISTS (SELECT 1 FROM orchestration_v2_effects predecessor
  WHERE predecessor.thread_id = candidate.thread_id AND predecessor.sequence < candidate.sequence
    AND predecessor.state IN ('pending','running'))`;

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

  claimNext(kinds: Iterable<string>): OrchestrationEffect | null {
    const list = kindList(kinds);
    return list === "[]" ? null : this.claimWhere(null, list, null);
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

  nextClaimableAt(kinds: Iterable<string>): string | null {
    const list = kindList(kinds);
    if (list === "[]") return null;
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

  private claimWhere(id: string | null, kinds: string | null, passing: string | null): OrchestrationEffect | null {
    return this.database.transaction(() => {
      const now = durableTimestamp(this.clock());
      const row = this.database.prepare(`SELECT candidate.* FROM orchestration_v2_effects candidate
        WHERE candidate.state = 'pending' AND candidate.runtime_id = ? AND candidate.available_at <= ?
          AND (? IS NULL OR candidate.id = ?)
          AND (? IS NULL OR candidate.kind IN (SELECT value FROM json_each(?)))
          AND NOT EXISTS (SELECT 1 FROM orchestration_v2_effects predecessor
            WHERE predecessor.thread_id = candidate.thread_id AND predecessor.sequence < candidate.sequence
              AND predecessor.state IN ('pending','running')
              AND (? IS NULL OR predecessor.kind NOT IN (SELECT value FROM json_each(?))))
        ORDER BY candidate.sequence LIMIT 1`)
        .get(this.runtimeId, now, id, id, kinds, kinds, passing, passing) as EffectRow | undefined;
      if (!row) return null;
      const claimId = randomUUID();
      const changed = this.database.prepare(`UPDATE orchestration_v2_effects
        SET state = 'running', claim_id = ?, claimed_at = ?, attempts = attempts + 1
        WHERE id = ? AND state = 'pending' AND runtime_id = ?`)
        .run(claimId, now, row.id, this.runtimeId).changes;
      if (changed !== 1) return null;
      return fromRow({ ...row, state: "running", claim_id: claimId, claimed_at: now, attempts: row.attempts + 1 });
    }).immediate();
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

export interface OrchestrationEffectDispatcherOptions {
  readonly concurrency?: number;
  readonly onFailure?: (failure: EffectFailure) => void;
  readonly afterTask?: () => void;
}

const SHUTDOWN = Symbol("orchestration-effect-shutdown");

export class OrchestrationEffectDispatcher {
  private readonly active = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private readonly concurrency: number;
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
  }

  get inFlight(): number {
    return this.active.size;
  }

  get saturated(): boolean {
    return this.active.size >= this.concurrency;
  }

  pump(): number {
    let claimed = 0;
    while (!this.closed && this.active.size < this.concurrency && this.handlers.size > 0) {
      const effect = this.outbox.claimNext(this.handlers.keys());
      if (!effect) break;
      claimed += 1;
      const controller = new AbortController();
      const task = Promise.resolve()
        .then(() => this.execute(effect, controller.signal))
        .catch(() => undefined)
        .finally(() => {
          if (this.active.get(effect.id)?.task === task) this.active.delete(effect.id);
          if (!this.closed) this.options.afterTask?.();
        });
      this.active.set(effect.id, { controller, task });
    }
    return claimed;
  }

  cancel(effectIds: readonly string[]): void {
    for (const id of effectIds) this.active.get(id)?.controller.abort(new Error("Orchestration effect cancelled."));
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const { controller } of this.active.values()) controller.abort(SHUTDOWN);
    await Promise.allSettled([...this.active.values()].map(({ task }) => task));
  }

  private async execute(effect: OrchestrationEffect, signal: AbortSignal): Promise<void> {
    let current: OrchestrationEffect | null;
    try {
      current = this.outbox.get(effect.id);
    } catch {
      this.outbox.requeue(effect);
      return;
    }
    if (signal.aborted || current?.state !== "running" || current.claimId !== effect.claimId) return;
    const handler = this.handlers.get(effect.kind);
    if (!handler) {
      this.outbox.requeue(effect);
      return;
    }
    const willRetry = effect.replayPolicy === "replay-safe" && effect.attempts < MAX_EFFECT_ATTEMPTS;
    try {
      await handler(effect, { signal, willRetry });
    } catch (error) {
      if (signal.aborted) return;
      const rejected = error instanceof OrchestrationEffectRejected;
      const code = rejected ? error.code : "effect-execution-failed";
      if (this.outbox.settle(effect, { kind: "failed", code, retryable: !rejected })) {
        try {
          this.options.onFailure?.({ effect, code, willRetry: !rejected && willRetry });
        } catch {
          return;
        }
      }
      return;
    }
    if (signal.aborted && signal.reason !== SHUTDOWN) return;
    this.outbox.settle(effect, { kind: "succeeded" });
  }
}
