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

export class OrchestrationEffectOutbox {
  constructor(
    private readonly database: Database.Database,
    readonly runtimeId: string,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {
    durableId(runtimeId);
  }

  get(id: string): OrchestrationEffect | null {
    const row = this.database.prepare("SELECT * FROM orchestration_v2_effects WHERE id = ?")
      .get(id) as EffectRow | undefined;
    return row ? fromRow(row) : null;
  }

  /** Terminal decisions can withdraw work that has not crossed the claim boundary. */
  retirePending(id: string, code: string): boolean {
    return this.database.prepare(`UPDATE orchestration_v2_effects
      SET state = 'retired', settled_at = ?, failure_code = ?
      WHERE id = ? AND state = 'pending'`)
      .run(durableTimestamp(this.clock()), durableId(code), id).changes === 1;
  }

  /** Call before accepting commands, once exclusive ownership of the runtime database is established. */
  recover(): { retired: number; replayable: number } {
    return this.database.transaction(() => {
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
  }

  /** One exact claim per lane. A delayed predecessor holds later effects in that thread. */
  claim(id?: string): OrchestrationEffect | null {
    return this.database.transaction(() => {
      const now = durableTimestamp(this.clock());
      const row = this.database.prepare(`SELECT candidate.* FROM orchestration_v2_effects candidate
        WHERE candidate.state = 'pending' AND candidate.runtime_id = ? AND candidate.available_at <= ?
          AND (? IS NULL OR candidate.id = ?)
          AND NOT EXISTS (SELECT 1 FROM orchestration_v2_effects predecessor
            WHERE predecessor.thread_id = candidate.thread_id AND predecessor.sequence < candidate.sequence
              AND predecessor.state IN ('pending','running'))
        ORDER BY candidate.sequence LIMIT 1`).get(this.runtimeId, now, id ?? null, id ?? null) as EffectRow | undefined;
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

  settle(effect: OrchestrationEffect, outcome: { kind: "succeeded" } | {
    kind: "failed";
    /** Stable classification only; never persist raw provider errors or secrets. */
    code: string;
    retryable?: boolean;
  }): boolean {
    if (!effect.claimId || effect.runtimeId !== this.runtimeId) return false;
    const now = durableTimestamp(this.clock());
    const retry = outcome.kind === "failed" && outcome.retryable === true
      && effect.replayPolicy === "replay-safe" && effect.attempts < 5;
    const state = retry ? "pending" : outcome.kind;
    const availableAt = retry
      ? new Date(Date.parse(now) + Math.min(30_000, 100 * 2 ** (effect.attempts - 1))).toISOString()
      : now;
    const code = outcome.kind === "failed" ? durableId(outcome.code) : null;
    return this.database.prepare(`UPDATE orchestration_v2_effects
      SET state = ?, available_at = ?, claim_id = NULL, claimed_at = NULL,
        settled_at = ?, failure_code = ?
      WHERE id = ? AND runtime_id = ? AND state = 'running' AND claim_id = ? AND attempts = ?`)
      .run(state, availableAt, retry ? null : now, code, effect.id, this.runtimeId,
        effect.claimId, effect.attempts).changes === 1;
  }

  pruneSettled(before: string): number {
    durableTimestamp(before);
    // Failed rows remain inspectable. Events and command receipts are not pruned here.
    return this.database.prepare(`DELETE FROM orchestration_v2_effects
      WHERE state IN ('succeeded','retired') AND settled_at < ?`).run(before).changes;
  }
}

export type EffectHandler = (effect: OrchestrationEffect) => Promise<void>;

/** Pumping is explicit so startup recovery, admission and shutdown retain their ordering. */
export class OrchestrationEffectDispatcher {
  private readonly active = new Set<Promise<void>>();
  private closed = false;

  constructor(
    private readonly outbox: OrchestrationEffectOutbox,
    private readonly handlers: ReadonlyMap<string, EffectHandler>,
    private readonly onFailure: (effect: OrchestrationEffect, code: string) => void,
    private readonly concurrency = 4,
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
      throw new Error("Invalid orchestration effect concurrency.");
    }
  }

  pump(): void {
    if (this.closed) return;
    while (this.active.size < this.concurrency) {
      const effect = this.outbox.claim();
      if (!effect) break;
      // Defer the handler until its promise is registered, including synchronous failures.
      const task = Promise.resolve().then(async () => {
        const handler = this.handlers.get(effect.kind);
        try {
          if (!handler) throw new Error("unregistered-effect");
          await handler(effect);
          this.outbox.settle(effect, { kind: "succeeded" });
        } catch {
          const code = handler ? "effect-execution-failed" : "unregistered-effect";
          const settled = this.outbox.settle(effect, { kind: "failed", code, retryable: handler !== undefined });
          if (settled) {
            try { this.onFailure(effect, code); } catch { /* Reporting cannot own effect completion. */ }
          }
        }
      }).finally(() => {
        this.active.delete(task);
        this.pump();
      });
      this.active.add(task);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(this.active);
  }
}
