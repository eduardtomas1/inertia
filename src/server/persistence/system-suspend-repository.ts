import type Database from "better-sqlite3";

import type { RuntimeSystemSuspendInterval } from "../../node/runtime-process-protocol";

interface SystemSuspendIntervalRow {
  id: string;
  suspended_at: string;
  resumed_at: string;
}

interface SequencedSystemSuspendIntervalRow extends SystemSuspendIntervalRow {
  sequence: number;
}

interface OverlappingTurnRow {
  id: string;
  conversation_id: string;
  started_at: string;
  completed_at: string | null;
  suspended_duration_ms: number;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function timestamp(value: string, label: string): { iso: string; milliseconds: number } {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is invalid.`);
  return { iso: new Date(milliseconds).toISOString(), milliseconds };
}

function fromRow(row: SystemSuspendIntervalRow): RuntimeSystemSuspendInterval {
  return {
    id: row.id,
    suspendedAt: row.suspended_at,
    resumedAt: row.resumed_at,
  };
}

/** Persists trusted desktop suspend windows and attributes them to overlapping turns. */
export class SystemSuspendRepository {
  constructor(private readonly database: Database.Database) {}

  record(input: RuntimeSystemSuspendInterval): string[] {
    if (!UUID_PATTERN.test(input.id)) {
      throw new Error("The system suspend interval identity is invalid.");
    }
    const suspended = timestamp(input.suspendedAt, "The system suspend time");
    const resumed = timestamp(input.resumedAt, "The system resume time");
    if (resumed.milliseconds < suspended.milliseconds) {
      throw new Error("The system resume time cannot precede its suspend time.");
    }
    return this.database.transaction(() => {
      const existing = this.database.prepare(`
        SELECT sequence, id, suspended_at, resumed_at
        FROM system_suspend_intervals
        WHERE id = ?
      `).get(input.id) as SequencedSystemSuspendIntervalRow | undefined;
      const predecessor = existing
        ? this.database.prepare(`
            SELECT resumed_at
            FROM system_suspend_intervals
            WHERE sequence < ?
            ORDER BY sequence DESC
            LIMIT 1
          `).get(existing.sequence) as { resumed_at: string } | undefined
        : this.database.prepare(`
            SELECT resumed_at
            FROM system_suspend_intervals
            ORDER BY sequence DESC
            LIMIT 1
          `).get() as { resumed_at: string } | undefined;
      const previousResume = predecessor
        ? timestamp(predecessor.resumed_at, "The previous system resume time")
        : null;
      const suspendedMilliseconds = Math.max(
        suspended.milliseconds,
        previousResume?.milliseconds ?? suspended.milliseconds,
      );
      const resumedMilliseconds = Math.max(
        resumed.milliseconds,
        suspendedMilliseconds,
      );
      const interval: RuntimeSystemSuspendInterval = {
        id: input.id,
        suspendedAt: new Date(suspendedMilliseconds).toISOString(),
        resumedAt: new Date(resumedMilliseconds).toISOString(),
      };
      if (existing) {
        const persisted = fromRow(existing);
        if (
          persisted.suspendedAt === interval.suspendedAt
          && persisted.resumedAt === interval.resumedAt
        ) return [];
        throw new Error("The system suspend interval identity is already in use.");
      }

      const overlap = this.database.prepare(`
        SELECT id
        FROM system_suspend_intervals
        WHERE suspended_at < @resumedAt
          AND resumed_at > @suspendedAt
        LIMIT 1
      `).get({
        suspendedAt: interval.suspendedAt,
        resumedAt: interval.resumedAt,
      }) as { id: string } | undefined;
      if (overlap) throw new Error("System suspend intervals cannot overlap.");

      this.database.prepare(`
        INSERT INTO system_suspend_intervals (id, suspended_at, resumed_at)
        VALUES (@id, @suspendedAt, @resumedAt)
      `).run(interval);

      const turns = this.database.prepare(`
        SELECT id, conversation_id, started_at, completed_at,
          suspended_duration_ms
        FROM agent_turns
        WHERE started_at IS NOT NULL
          AND started_at < @resumedAt
          AND (completed_at IS NULL OR completed_at > @suspendedAt)
        ORDER BY id ASC
      `).all({
        suspendedAt: interval.suspendedAt,
        resumedAt: interval.resumedAt,
      }) as OverlappingTurnRow[];
      const update = this.database.prepare(`
        UPDATE agent_turns
        SET suspended_duration_ms = ?
        WHERE id = ?
      `);
      const conversationIds = new Set<string>();
      for (const turn of turns) {
        const startedAt = Date.parse(turn.started_at);
        const completedAt = turn.completed_at
          ? Date.parse(turn.completed_at)
          : resumedMilliseconds;
        const duration = Math.min(completedAt, resumedMilliseconds)
          - Math.max(startedAt, suspendedMilliseconds);
        if (!Number.isSafeInteger(duration) || duration <= 0) continue;
        const next = turn.suspended_duration_ms + duration;
        if (!Number.isSafeInteger(next) || next < 0) {
          throw new Error("The suspended turn duration is too large.");
        }
        update.run(next, turn.id);
        conversationIds.add(turn.conversation_id);
      }
      return [...conversationIds].sort();
    })();
  }

  read(fromInclusive: string, toExclusive: string): RuntimeSystemSuspendInterval[] {
    const from = timestamp(fromInclusive, "The suspend range start");
    const to = timestamp(toExclusive, "The suspend range end");
    if (from.milliseconds >= to.milliseconds) {
      throw new Error("The suspend interval range is invalid.");
    }
    return (this.database.prepare(`
      SELECT id, suspended_at, resumed_at
      FROM system_suspend_intervals
      WHERE suspended_at < ?
        AND resumed_at > ?
      ORDER BY suspended_at ASC, id ASC
    `).all(to.iso, from.iso) as SystemSuspendIntervalRow[]).map(fromRow);
  }
}
