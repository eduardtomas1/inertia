import type Database from "better-sqlite3";

import type { SubagentTrace } from "../../shared/contracts";
import { MAX_OBSERVED_CHILDREN } from "../../shared/observed-child-thread";
import { subagentTraceFromRow } from "./codecs";
import type { SubagentTraceRow } from "./rows";

export const MAX_LIVE_NATIVE_CHILD_IDS = 128;

const LIVE_TRACE = `is_live = 1
  AND status NOT IN ('completed', 'failed', 'cancelled', 'interrupted', 'lost')`;

export interface LiveNativeChildren {
  conversationId: string;
  turnId: string;
  count: number;
  traceIds: string[];
}

export interface ObservedChildTraceQuery {
  conversationId: string;
  turnId?: string | null;
}

export interface ObservedChildTraceRead {
  conversationExists: boolean;
  traces: SubagentTrace[];
  truncated: boolean;
}

/**
 * Counts provider-managed agents that are still live in one exact turn of one
 * conversation. Traces from other turns, including earlier turns of the same
 * conversation, never contribute.
 */
export function liveNativeChildren(
  database: Database.Database,
  conversationId: string,
  turnId: string,
): LiveNativeChildren {
  return database.transaction((): LiveNativeChildren => {
    const { count } = database.prepare(`
      SELECT COUNT(*) AS count FROM subagent_traces
      WHERE conversation_id = ? AND turn_id = ? AND ${LIVE_TRACE}
    `).get(conversationId, turnId) as { count: number };
    const traceIds = (database.prepare(`
      SELECT id FROM subagent_traces
      WHERE conversation_id = ? AND turn_id = ? AND ${LIVE_TRACE}
      ORDER BY created_at ASC, sequence ASC, id ASC
      LIMIT ?
    `).all(conversationId, turnId, MAX_LIVE_NATIVE_CHILD_IDS) as { id: string }[])
      .map(({ id }) => id);
    return { conversationId, turnId, count, traceIds };
  })();
}

/**
 * Reads the bounded trace set an observed-child view is derived from: every
 * trace of one turn, or the newest traces of the conversation, oldest first.
 */
export function readObservedChildTraces(
  database: Database.Database,
  query: ObservedChildTraceQuery,
): ObservedChildTraceRead {
  return database.transaction((): ObservedChildTraceRead => {
    const conversationExists = database.prepare(
      "SELECT 1 FROM conversations WHERE id = ?",
    ).get(query.conversationId) !== undefined;
    if (!conversationExists) return { conversationExists, traces: [], truncated: false };
    const turnId = query.turnId ?? null;
    const rows = (turnId === null
      ? database.prepare(`
          SELECT * FROM subagent_traces
          WHERE conversation_id = ?
          ORDER BY created_at DESC, sequence DESC, id DESC
          LIMIT ?
        `).all(query.conversationId, MAX_OBSERVED_CHILDREN + 1)
      : database.prepare(`
          SELECT * FROM subagent_traces
          WHERE conversation_id = ? AND turn_id = ?
          ORDER BY created_at DESC, sequence DESC, id DESC
          LIMIT ?
        `).all(query.conversationId, turnId, MAX_OBSERVED_CHILDREN + 1)) as SubagentTraceRow[];
    const truncated = rows.length > MAX_OBSERVED_CHILDREN;
    const traces = rows.slice(0, MAX_OBSERVED_CHILDREN).reverse().map(subagentTraceFromRow);
    return { conversationExists, traces, truncated };
  })();
}

export function readObservedChildTrace(
  database: Database.Database,
  traceId: string,
): SubagentTrace | null {
  const row = database.prepare(
    "SELECT * FROM subagent_traces WHERE id = ?",
  ).get(traceId) as SubagentTraceRow | undefined;
  return row ? subagentTraceFromRow(row) : null;
}

export class ObservedChildRepository {
  constructor(private readonly database: Database.Database) {}

  liveNativeChildren(conversationId: string, turnId: string): LiveNativeChildren {
    return liveNativeChildren(this.database, conversationId, turnId);
  }

  traces(query: ObservedChildTraceQuery): ObservedChildTraceRead {
    return readObservedChildTraces(this.database, query);
  }

  trace(traceId: string): SubagentTrace | null {
    return readObservedChildTrace(this.database, traceId);
  }
}
