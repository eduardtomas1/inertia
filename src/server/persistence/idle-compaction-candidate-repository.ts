import type Database from "better-sqlite3";

import type { PromptCacheFacts } from "../../shared/compact-on-return";
import { PROMPT_CACHE_FACT_SOURCES } from "../../shared/compact-on-return";

const MAX_CANDIDATES = 64;

export interface IdleCompactionCandidate {
  conversationId: string;
  usedTokens: number;
  promptCache: PromptCacheFacts;
}

interface CandidateRow {
  conversation_id: string;
  used_tokens: number;
  last_request_started_at: string;
  prompt_cache_lifetime_ms: number | null;
  prompt_cache_source: string;
}

export class IdleCompactionCandidateRepository {
  constructor(private readonly database: () => Database.Database) {}

  candidates(input: { startedSince: string; startedBefore: string; minimumTokens: number }): IdleCompactionCandidate[] {
    const rows = this.database().prepare(`
      SELECT usage.conversation_id, usage.used_tokens, usage.last_request_started_at,
        usage.prompt_cache_lifetime_ms, usage.prompt_cache_source
      FROM thread_usage AS usage
      JOIN conversations ON conversations.id = usage.conversation_id
      WHERE conversations.archived_at IS NULL
        AND conversations.provider_id = 'claude'
        AND usage.used_tokens >= @minimumTokens
        AND usage.last_request_started_at IS NOT NULL
        AND usage.last_request_started_at >= @startedSince
        AND usage.last_request_started_at <= @startedBefore
        AND usage.prompt_cache_source IS NOT NULL
      ORDER BY usage.last_request_started_at ASC
      LIMIT ${MAX_CANDIDATES}
    `).all(input) as CandidateRow[];
    return rows.flatMap((row) => {
      if (!PROMPT_CACHE_FACT_SOURCES.includes(row.prompt_cache_source as PromptCacheFacts["source"])) return [];
      return [{
        conversationId: row.conversation_id,
        usedTokens: row.used_tokens,
        promptCache: {
          lastRequestStartedAt: row.last_request_started_at,
          lifetimeMs: row.prompt_cache_lifetime_ms,
          source: row.prompt_cache_source as PromptCacheFacts["source"],
        },
      }];
    });
  }
}
