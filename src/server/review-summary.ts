import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";

import type {
  DiffFile,
  DiffReviewClassification,
  DiffReviewClassificationHint,
  DiffReviewSummary,
  ProviderId,
} from "../shared/contracts";
import { sha256 } from "../shared/diff-review";

export const DIFF_REVIEW_CLASSIFICATIONS = [
  "behavior-change",
  "regression-risk",
  "security-sensitive",
  "migration",
  "test-impact",
  "performance-sensitive",
  "documentation-only",
] as const satisfies readonly DiffReviewClassification[];

export const MAX_REVIEW_PATCH_CHARS = 180_000;
export const MAX_REVIEW_PROMPT_CHARS = 240_000;
export const MAX_REVIEW_RESULT_CHARS = 512_000;
export const DEFAULT_REVIEW_SUMMARY_TIMEOUT_MS = 120_000;
const MAX_PERSISTED_REVIEW_FILES_CHARS = 250_000;

const classificationSchema = z.object({
  classification: z.enum(DIFF_REVIEW_CLASSIFICATIONS),
  evidence: z.string().trim().min(1).max(500),
}).strict();

const hunkSummarySchema = z.object({
  hunkId: z.string().min(1).max(128),
  summary: z.string().trim().min(1).max(800),
  classifications: z.array(classificationSchema).max(DIFF_REVIEW_CLASSIFICATIONS.length),
}).strict();

const fileSummarySchema = z.object({
  path: z.string().min(1).max(4_096),
  summary: z.string().trim().min(1).max(1_000),
  classifications: z.array(classificationSchema).max(DIFF_REVIEW_CLASSIFICATIONS.length),
  hunks: z.array(hunkSummarySchema).max(2_000),
}).strict();

const reviewSummarySchema = z.object({
  overall: z.string().trim().min(1).max(2_000),
  classifications: z.array(classificationSchema).max(DIFF_REVIEW_CLASSIFICATIONS.length),
  files: z.array(fileSummarySchema).min(1).max(100),
}).strict();

export class ReviewSummaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewSummaryError";
  }
}

export class ReviewSummaryTimeoutError extends ReviewSummaryError {
  constructor() {
    super("The agent summary timed out and was stopped. No summary was saved.");
    this.name = "ReviewSummaryTimeoutError";
  }
}

function compactText(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function validatedHints(hints: readonly DiffReviewClassificationHint[], target: string): DiffReviewClassificationHint[] {
  const seen = new Set<DiffReviewClassification>();
  return hints.map((hint) => {
    if (seen.has(hint.classification)) {
      throw new ReviewSummaryError(`The review agent duplicated the ${hint.classification} classification for ${target}. No summary was saved.`);
    }
    seen.add(hint.classification);
    return { classification: hint.classification, evidence: compactText(hint.evidence) };
  });
}

function parsedJson(text: string): unknown {
  if (text.length > MAX_REVIEW_RESULT_CHARS) {
    throw new ReviewSummaryError("The review agent returned an oversized result. No summary was saved.");
  }
  try {
    return JSON.parse(text.trim()) as unknown;
  } catch {
    throw new ReviewSummaryError("The review agent did not return one valid JSON object. No summary was saved.");
  }
}

export function buildReviewSummaryPrompt(patch: string, files: readonly DiffFile[]): string {
  if (patch.length > MAX_REVIEW_PATCH_CHARS) {
    throw new ReviewSummaryError("This diff is too large for a concise review. Review or commit it in smaller parts.");
  }
  const inventory = files.map((file) => ({
    path: file.path,
    hunks: file.hunks.map((hunk) => ({ hunkId: hunk.id, header: hunk.header })),
  }));
  const prompt = [
    "Review only the complete Git diff supplied below. Do not use tools, request interaction, or modify files.",
    "Return exactly one JSON object and no Markdown or surrounding text, using this exact shape:",
    '{"overall":"1-3 sentence summary","classifications":[{"classification":"behavior-change","evidence":"specific evidence visible in the diff"}],"files":[{"path":"exact path","summary":"what changed and why","classifications":[],"hunks":[{"hunkId":"exact id","summary":"what this hunk changes and how it fits its surrounding code","classifications":[]}]}]}',
    `Allowed classification hints: ${DIFF_REVIEW_CLASSIFICATIONS.join(", ")}.`,
    "Classifications are compact review hints, not established facts. Include one only when concrete evidence is visible in the diff; otherwise use an empty array. Never repeat a classification within one target.",
    "Every required file and hunk must appear exactly once. Do not add unknown paths, hunk IDs, fields, or entries.",
    `Required inventory: ${JSON.stringify(inventory)}`,
    "Complete diff:",
    patch,
  ].join("\n\n");
  if (prompt.length > MAX_REVIEW_PROMPT_CHARS) {
    throw new ReviewSummaryError("This diff has too much review metadata for a safe agent request. Review or commit it in smaller parts.");
  }
  return prompt;
}

export function parseReviewSummaryResult(
  conversationId: string,
  providerId: ProviderId,
  fingerprint: string,
  expectedFiles: readonly DiffFile[],
  text: string,
  generatedAt = new Date().toISOString(),
): DiffReviewSummary {
  const result = reviewSummarySchema.safeParse(parsedJson(text));
  if (!result.success) {
    throw new ReviewSummaryError("The review agent returned an invalid structured result. No summary was saved.");
  }

  const expectedPaths = new Set(expectedFiles.map(({ path }) => path));
  const fileCandidates = new Map<string, (typeof result.data.files)[number]>();
  for (const candidate of result.data.files) {
    if (!expectedPaths.has(candidate.path)) {
      throw new ReviewSummaryError(`The review agent returned the unknown file ${candidate.path}. No summary was saved.`);
    }
    if (fileCandidates.has(candidate.path)) {
      throw new ReviewSummaryError(`The review agent returned ${candidate.path} more than once. No summary was saved.`);
    }
    fileCandidates.set(candidate.path, candidate);
  }
  const missingFile = expectedFiles.find(({ path }) => !fileCandidates.has(path));
  if (missingFile) {
    throw new ReviewSummaryError(`The review agent omitted ${missingFile.path}. No summary was saved.`);
  }

  const files = expectedFiles.map((file) => {
    const candidate = fileCandidates.get(file.path)!;
    const expectedHunkIds = new Set(file.hunks.map(({ id }) => id));
    const hunkCandidates = new Map<string, (typeof candidate.hunks)[number]>();
    for (const hunk of candidate.hunks) {
      if (!expectedHunkIds.has(hunk.hunkId)) {
        throw new ReviewSummaryError(`The review agent returned an unknown hunk for ${file.path}. No summary was saved.`);
      }
      if (hunkCandidates.has(hunk.hunkId)) {
        throw new ReviewSummaryError(`The review agent returned a hunk more than once for ${file.path}. No summary was saved.`);
      }
      hunkCandidates.set(hunk.hunkId, hunk);
    }
    const missingHunk = file.hunks.find(({ id }) => !hunkCandidates.has(id));
    if (missingHunk) {
      throw new ReviewSummaryError(`The review agent omitted a hunk for ${file.path}. No summary was saved.`);
    }
    return {
      path: file.path,
      summary: compactText(candidate.summary),
      classifications: validatedHints(candidate.classifications, file.path),
      hunks: file.hunks.map((hunk) => {
        const item = hunkCandidates.get(hunk.id)!;
        return {
          hunkId: hunk.id,
          summary: compactText(item.summary),
          classifications: validatedHints(item.classifications, `${file.path} · ${hunk.header}`),
        };
      }),
    };
  });
  if (JSON.stringify(files).length > MAX_PERSISTED_REVIEW_FILES_CHARS) {
    throw new ReviewSummaryError("The review agent returned too much structured detail. No summary was saved.");
  }

  return {
    conversationId,
    fingerprint,
    providerId,
    overall: compactText(result.data.overall),
    classifications: validatedHints(result.data.classifications, "the overall summary"),
    files,
    generatedAt,
  };
}

export function requireCurrentReviewSummaryFingerprint(
  expectedFingerprint: string,
  currentPatch: string,
  truncated: boolean,
): void {
  if (truncated || sha256(currentPatch) !== expectedFingerprint) {
    throw new ReviewSummaryError("The diff changed while it was being summarized. The stale summary was discarded.");
  }
}

export type ReviewSummaryStopReason = "cancelled" | "disconnected" | "unsupported-interaction" | "timeout";

interface ActiveReviewSummary<Owner> {
  conversationId: string;
  temporaryConversationId: string;
  owner: Owner;
  stopReason: ReviewSummaryStopReason | null;
  cancel: (() => void) | null;
}

export class ActiveReviewSummaryRegistry<Owner> {
  private readonly active = new Map<string, ActiveReviewSummary<Owner>>();

  reserve(conversationId: string, temporaryConversationId: string, owner: Owner): void {
    if (this.active.has(conversationId)) {
      throw new ReviewSummaryError("A change summary is already running for this thread.");
    }
    this.active.set(conversationId, {
      conversationId,
      temporaryConversationId,
      owner,
      stopReason: null,
      cancel: null,
    });
  }

  has(conversationId: string): boolean {
    return this.active.has(conversationId);
  }

  attachCancel(conversationId: string, temporaryConversationId: string, cancel: () => void): void {
    const active = this.active.get(conversationId);
    if (!active || active.temporaryConversationId !== temporaryConversationId) return;
    active.cancel = cancel;
    if (active.stopReason) cancel();
  }

  stop(conversationId: string, reason: ReviewSummaryStopReason): boolean {
    const active = this.active.get(conversationId);
    if (!active) return false;
    active.stopReason ??= reason;
    try {
      active.cancel?.();
    } catch {
      // Cancellation is best effort; the provider manager still owns force-kill cleanup.
    }
    return true;
  }

  stopOwned(owner: Owner, reason: ReviewSummaryStopReason): string[] {
    const stopped: string[] = [];
    for (const active of this.active.values()) {
      if (active.owner !== owner) continue;
      this.stop(active.conversationId, reason);
      stopped.push(active.conversationId);
    }
    return stopped;
  }

  stopReason(conversationId: string, temporaryConversationId: string): ReviewSummaryStopReason | null {
    const active = this.active.get(conversationId);
    return active?.temporaryConversationId === temporaryConversationId ? active.stopReason : null;
  }

  finish(conversationId: string, temporaryConversationId: string): void {
    const active = this.active.get(conversationId);
    if (active?.temporaryConversationId === temporaryConversationId) this.active.delete(conversationId);
  }
}

export async function withReviewSummaryTimeout<T>(
  run: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
  settleGraceMs = 5_000,
): Promise<T> {
  const timeout = Math.max(1, Math.min(timeoutMs, 10 * 60_000));
  let timer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    run.then((value) => ({ kind: "result" as const, value })),
    new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), timeout);
      timer.unref();
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (outcome.kind === "result") return outcome.value;

  onTimeout();
  if (settleGraceMs > 0) {
    await Promise.race([
      run.then(() => undefined, () => undefined),
      delay(settleGraceMs, undefined, { ref: false }),
    ]);
  }
  throw new ReviewSummaryTimeoutError();
}
