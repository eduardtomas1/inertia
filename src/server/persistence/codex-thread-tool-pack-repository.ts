import type Database from "better-sqlite3";

import type {
  ThreadToolPackDigests,
  ThreadToolRegistrations,
} from "../runtime/thread-tool-registrations";

/** Newest registrations kept even before any chat records their thread. */
const KEPT_RECENT_THREADS = 1_024;
const MAX_PACKS_PER_THREAD = 16;
const PACK_ID = /^[a-z][a-z0-9.-]{0,63}$/u;
const PACK_DIGEST = /^[0-9a-f]{64}$/u;

/** A provider thread id is untrusted text: bounded, without control characters. */
export function validThreadId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 512
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

/**
 * The capability packs each Codex thread registered when it started. A
 * registration replaces any earlier one for the same thread. Registrations of
 * threads no chat resumes from are pruned once they fall out of the newest
 * ones.
 */
export class CodexThreadToolPackRepository implements ThreadToolRegistrations {
  constructor(
    private readonly database: () => Database.Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  record(threadId: string, packs: ThreadToolPackDigests): void {
    if (!validThreadId(threadId) || packs.size > MAX_PACKS_PER_THREAD) return;
    const entries = [...packs].filter(([id, digest]) => PACK_ID.test(id) && PACK_DIGEST.test(digest));
    const database = this.database();
    const registeredAt = this.now();
    database.transaction(() => {
      database.prepare("DELETE FROM codex_thread_tool_packs WHERE thread_id = ?").run(threadId);
      const insert = database.prepare(`
        INSERT INTO codex_thread_tool_packs (thread_id, pack_id, pack_digest, registered_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const [id, digest] of entries) insert.run(threadId, id, digest, registeredAt);
      database.prepare(`
        DELETE FROM codex_thread_tool_packs
        WHERE thread_id NOT IN (
          SELECT thread_id FROM codex_thread_tool_packs
          GROUP BY thread_id
          ORDER BY MAX(registered_at) DESC, thread_id DESC
          LIMIT ?
        )
        AND thread_id NOT IN (
          SELECT provider_session_id FROM conversations WHERE provider_session_id IS NOT NULL
        )
      `).run(KEPT_RECENT_THREADS);
    })();
  }

  /** The packs a thread registered, or null when Inertia has no record of it. */
  read(threadId: string): ThreadToolPackDigests | null {
    if (!validThreadId(threadId)) return null;
    const rows = this.database().prepare(`
      SELECT pack_id, pack_digest FROM codex_thread_tool_packs
      WHERE thread_id = ?
      ORDER BY pack_id
      LIMIT ?
    `).all(threadId, MAX_PACKS_PER_THREAD) as Array<{ pack_id: string; pack_digest: string }>;
    if (rows.length === 0) return null;
    return new Map(rows
      .filter(({ pack_id, pack_digest }) => PACK_ID.test(pack_id) && PACK_DIGEST.test(pack_digest))
      .map(({ pack_id, pack_digest }) => [pack_id, pack_digest]));
  }
}
