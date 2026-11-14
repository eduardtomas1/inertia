export interface ClaudeUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
}

export interface TranscriptCall {
  at: string | null;
  model: string | null;
  usage: ClaudeUsage;
}

export interface TranscriptCompaction {
  at: string | null;
  trigger: string;
  preTokens: number;
}

export interface TranscriptSummary {
  entrypoint: string | null;
  calls: TranscriptCall[];
  compactions: TranscriptCompaction[];
}

export interface UsageSession extends TranscriptSummary {
  app: "inertia" | "t3-code" | "other";
  subagent: boolean;
}

export interface RebuildBucket {
  count: number;
  weightedTokens: number;
}

export interface UsageGroup {
  sessions: number;
  calls: number;
  outputTokens: number;
  weightedTokens: number;
  contextTokens: number;
  largeContextCalls: number;
  compactions: { auto: number; manual: number; other: number; preTokens: number };
  rebuilds: { afterHour: RebuildBucket; afterMinutes: RebuildBucket; quick: RebuildBucket };
}

export interface UsageGroupMetrics {
  sessions: number;
  calls: number;
  outputTokens: number;
  weightedTokens: number;
  weightedPerOutputToken: number | null;
  averageContextTokens: number | null;
  largeContextShare: number | null;
  compactions: number;
  averageTokensAtCompaction: number | null;
  rebuilds: UsageGroup["rebuilds"];
}

export interface UsageReport {
  root: string;
  since: string | null;
  until: string | null;
  weights: typeof TOKEN_WEIGHTS;
  groups: Record<string, UsageGroupMetrics>;
}

export const TOKEN_WEIGHTS: Readonly<{
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
}>;
export const LARGE_CONTEXT_TOKENS: number;
export function classifyTranscriptHead(text: string): UsageSession["app"];
export function weighUsage(usage: ClaudeUsage): number;
export function contextTokens(usage: ClaudeUsage): number;
export function summarizeTranscriptLines(lines: Iterable<string>): TranscriptSummary;
export function aggregateSessions(
  sessions: readonly UsageSession[],
  window?: { since: number | null; until: number | null },
): Record<string, UsageGroup>;
export function groupMetrics(group: UsageGroup): UsageGroupMetrics;
export function analyzeClaudeProjects(input: { root: string; since?: string | null; until?: string | null }): Promise<UsageReport>;
export function formatUsageReport(report: UsageReport): string;
