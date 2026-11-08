import { z } from "zod";

/**
 * Read-only Git history and blame. The author and committer fields never
 * carry email addresses; names, dates and subjects are bounded by the
 * runtime before they cross the process boundary. A commit body is passed
 * through as written, so trailers such as Signed-off-by keep any address the
 * author put there.
 */
export const GIT_HISTORY_LIMITS = {
  logPageDefault: 50,
  logPageMax: 100,
  commitBodyBytes: 8 * 1024,
  commitFiles: 500,
  commitDiffBytes: 256 * 1024,
  blameLinesPerPage: 2_000,
  subjectCharacters: 1_000,
  authorNameCharacters: 256,
  cursorCharacters: 256,
} as const;

/** An abbreviated or full commit id, up to a 64-character SHA-256 object name. */
export const GIT_COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/u;
export const GIT_LOG_CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u;

export interface GitLogCommit {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  /** Strict ISO 8601 author date as recorded by Git. */
  authorDate: string;
  parents: string[];
  isMerge: boolean;
}

export interface GitLogPage {
  /** The commit the history was anchored to on its first page; null when the branch is unborn. */
  head: string | null;
  path: string | null;
  commits: GitLogCommit[];
  /** Opaque continuation token; null when this is the last page. */
  nextCursor: string | null;
}

export type GitCommitFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type-changed"
  | "unmerged"
  | "unknown";

export interface GitCommitFile {
  path: string;
  previousPath: string | null;
  status: GitCommitFileStatus;
  /** Null for binary content. */
  additions: number | null;
  deletions: number | null;
}

export interface GitCommitDetail {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  bodyTruncated: boolean;
  authorName: string;
  authorDate: string;
  parents: string[];
  isMerge: boolean;
  files: GitCommitFile[];
  filesTruncated: boolean;
  /** Unified diff against the first parent (or the empty tree for a root commit). */
  diff: string;
  diffTruncated: boolean;
}

export interface GitBlameLine {
  line: number;
  sha: string;
  shortSha: string;
  authorName: string;
  authorDate: string;
  summary: string;
  uncommitted: boolean;
}

export type GitBlameState = "ready" | "untracked" | "binary" | "unsupported";

export interface GitBlamePage {
  path: string;
  state: GitBlameState;
  startLine: number;
  endLine: number;
  lineCount: number;
  lines: GitBlameLine[];
  /** First line of the next page; null when the file has no more lines. */
  nextStartLine: number | null;
}

const fullSha = z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/u);
const shortSha = z.string().regex(/^[0-9a-f]{4,64}$/u);
const boundedName = z.string().max(GIT_HISTORY_LIMITS.authorNameCharacters);
const boundedSubject = z.string().max(GIT_HISTORY_LIMITS.subjectCharacters);
const isoDate = z.string().min(1).max(64).refine((value) => Number.isFinite(Date.parse(value)));
const repositoryPath = z.string().min(1).max(4_096);

const gitLogCommitSchema = z.object({
  sha: fullSha,
  shortSha,
  subject: boundedSubject,
  authorName: boundedName,
  authorDate: isoDate,
  parents: z.array(fullSha).max(64),
  isMerge: z.boolean(),
}).strict();

export const gitLogPageSchema = z.object({
  head: fullSha.nullable(),
  path: repositoryPath.nullable(),
  commits: z.array(gitLogCommitSchema).max(GIT_HISTORY_LIMITS.logPageMax),
  nextCursor: z.string().regex(GIT_LOG_CURSOR_PATTERN).nullable(),
}).strict();

const gitCommitFileSchema = z.object({
  path: repositoryPath,
  previousPath: repositoryPath.nullable(),
  status: z.enum([
    "added", "modified", "deleted", "renamed", "copied", "type-changed",
    "unmerged", "unknown",
  ]),
  additions: z.number().int().min(0).nullable(),
  deletions: z.number().int().min(0).nullable(),
}).strict();

export const gitCommitDetailSchema = z.object({
  sha: fullSha,
  shortSha,
  subject: boundedSubject,
  body: z.string().max(GIT_HISTORY_LIMITS.commitBodyBytes),
  bodyTruncated: z.boolean(),
  authorName: boundedName,
  authorDate: isoDate,
  parents: z.array(fullSha).max(64),
  isMerge: z.boolean(),
  files: z.array(gitCommitFileSchema).max(GIT_HISTORY_LIMITS.commitFiles),
  filesTruncated: z.boolean(),
  diff: z.string().max(GIT_HISTORY_LIMITS.commitDiffBytes),
  diffTruncated: z.boolean(),
}).strict();

const gitBlameLineSchema = z.object({
  line: z.number().int().min(1),
  sha: fullSha,
  shortSha: z.string().max(64),
  authorName: boundedName,
  authorDate: isoDate,
  summary: boundedSubject,
  uncommitted: z.boolean(),
}).strict();

export const gitBlamePageSchema = z.object({
  path: repositoryPath,
  state: z.enum(["ready", "untracked", "binary", "unsupported"]),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(0),
  lineCount: z.number().int().min(0),
  lines: z.array(gitBlameLineSchema).max(GIT_HISTORY_LIMITS.blameLinesPerPage),
  nextStartLine: z.number().int().min(1).nullable(),
}).strict();

/** Request-result validators for the renderer's server-event boundary. */
export const gitHistoryResultValidators = {
  "git.log": (value: Record<string, unknown>) =>
    gitLogPageSchema.safeParse(value.page).success,
  "git.commit.show": (value: Record<string, unknown>) =>
    gitCommitDetailSchema.safeParse(value.commit).success,
  "git.blame": (value: Record<string, unknown>) =>
    gitBlamePageSchema.safeParse(value.blame).success,
} as const;
