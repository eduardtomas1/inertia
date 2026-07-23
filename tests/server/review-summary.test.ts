import { describe, expect, it, vi } from "vitest";

import { parseUnifiedDiff } from "../../src/shared/diff-review";
import {
  ActiveReviewSummaryRegistry,
  buildReviewSummaryPrompt,
  parseReviewSummaryResult,
  requireCurrentReviewSummaryFingerprint,
  withReviewSummaryTimeout,
} from "../../src/server/review-summary";

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-export const value = 1;",
  "+export const value = 2;",
  "diff --git a/src/b.ts b/src/b.ts",
  "index 3333333..4444444 100644",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -2 +2 @@",
  "-export const enabled = false;",
  "+export const enabled = true;",
  "",
].join("\n");

const structured = parseUnifiedDiff(patch);

function validResult(): {
  overall: string;
  classifications: Array<{ classification: string; evidence: string }>;
  files: Array<{
    path: string;
    summary: string;
    classifications: Array<{ classification: string; evidence: string }>;
    hunks: Array<{
      hunkId: string;
      summary: string;
      classifications: Array<{ classification: string; evidence: string }>;
    }>;
  }>;
} {
  return {
    overall: "Updates two exported defaults.",
    classifications: [{ classification: "behavior-change", evidence: "Both exported values change." }],
    files: structured.files.map((file) => ({
      path: file.path,
      summary: `Updates ${file.path}.`,
      classifications: [],
      hunks: file.hunks.map((hunk) => ({
        hunkId: hunk.id,
        summary: "Changes the exported value.",
        classifications: [{ classification: "test-impact", evidence: "An exported value changed." }],
      })),
    })),
  };
}

function parse(value: unknown): ReturnType<typeof parseReviewSummaryResult> {
  return parseReviewSummaryResult(
    "conversation",
    "claude",
    structured.fingerprint,
    structured.files,
    JSON.stringify(value),
    "2026-07-23T10:00:00.000Z",
  );
}

describe("AI diff review summaries", () => {
  it("builds a bounded tool-free prompt with a complete exact inventory", () => {
    const prompt = buildReviewSummaryPrompt(patch, structured.files);
    expect(prompt).toContain("Do not use tools, request interaction, or modify files.");
    expect(prompt).toContain(structured.files[0]!.hunks[0]!.id);
    expect(prompt).toContain("Classifications are compact review hints, not established facts.");
    expect(prompt.endsWith(patch)).toBe(true);
  });

  it("accepts exactly one summary per expected file and hunk with evidence-backed hints", () => {
    expect(parse(validResult())).toEqual({
      conversationId: "conversation",
      providerId: "claude",
      fingerprint: structured.fingerprint,
      overall: "Updates two exported defaults.",
      classifications: [{ classification: "behavior-change", evidence: "Both exported values change." }],
      files: structured.files.map((file) => ({
        path: file.path,
        summary: `Updates ${file.path}.`,
        classifications: [],
        hunks: file.hunks.map((hunk) => ({
          hunkId: hunk.id,
          summary: "Changes the exported value.",
          classifications: [{ classification: "test-impact", evidence: "An exported value changed." }],
        })),
      })),
      generatedAt: "2026-07-23T10:00:00.000Z",
    });
  });

  it("rejects unknown, duplicated, and missing file IDs", () => {
    const unknown = validResult();
    unknown.files[0]!.path = "src/unknown.ts";
    expect(() => parse(unknown)).toThrow(/unknown file/u);

    const duplicated = validResult();
    duplicated.files[1] = structuredClone(duplicated.files[0]!);
    expect(() => parse(duplicated)).toThrow(/more than once/u);

    const missing = validResult();
    missing.files.pop();
    expect(() => parse(missing)).toThrow(/omitted src\/b\.ts/u);
  });

  it("rejects unknown, duplicated, and missing hunk IDs", () => {
    const unknown = validResult();
    unknown.files[0]!.hunks[0]!.hunkId = "unknown-hunk";
    expect(() => parse(unknown)).toThrow(/unknown hunk/u);

    const duplicated = validResult();
    duplicated.files[0]!.hunks.push(structuredClone(duplicated.files[0]!.hunks[0]!));
    expect(() => parse(duplicated)).toThrow(/hunk more than once/u);

    const missing = validResult();
    missing.files[0]!.hunks = [];
    expect(() => parse(missing)).toThrow(/omitted a hunk/u);
  });

  it("rejects surrounding Markdown, unknown fields, invalid hints, and duplicated hints", () => {
    expect(() => parseReviewSummaryResult(
      "conversation",
      "codex",
      structured.fingerprint,
      structured.files,
      `\`\`\`json\n${JSON.stringify(validResult())}\n\`\`\``,
    )).toThrow(/one valid JSON object/u);

    const extra = { ...validResult(), confidence: 1 };
    expect(() => parse(extra)).toThrow(/invalid structured result/u);

    const invalid = validResult();
    invalid.classifications[0]!.classification = "certainly-a-regression";
    expect(() => parse(invalid)).toThrow(/invalid structured result/u);

    const duplicated = validResult();
    duplicated.classifications.push(structuredClone(duplicated.classifications[0]!));
    expect(() => parse(duplicated)).toThrow(/duplicated the behavior-change classification/u);
  });

  it("does not call persistence after a stale or truncated SHA-256 fingerprint", () => {
    const persist = vi.fn();
    const saveIfCurrent = (currentPatch: string, truncated = false) => {
      requireCurrentReviewSummaryFingerprint(structured.fingerprint, currentPatch, truncated);
      persist();
    };
    saveIfCurrent(patch);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(() => saveIfCurrent(`${patch}\n# concurrent change`)).toThrow(/stale summary was discarded/u);
    expect(() => saveIfCurrent(patch, true)).toThrow(/stale summary was discarded/u);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("deduplicates runs, cancels explicit and unsupported interactions, and cleans up by owner", () => {
    const registry = new ActiveReviewSummaryRegistry<object>();
    const owner = {};
    const otherOwner = {};
    const cancel = vi.fn();
    registry.reserve("thread-a", "temporary-a", owner);
    expect(() => registry.reserve("thread-a", "temporary-b", otherOwner)).toThrow(/already running/u);
    registry.attachCancel("thread-a", "temporary-a", cancel);
    expect(registry.stop("thread-a", "unsupported-interaction")).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(registry.stopReason("thread-a", "temporary-a")).toBe("unsupported-interaction");
    registry.finish("thread-a", "temporary-a");
    expect(registry.has("thread-a")).toBe(false);

    registry.reserve("thread-a", "temporary-c", owner);
    registry.attachCancel("thread-a", "temporary-c", cancel);
    registry.reserve("thread-b", "temporary-d", otherOwner);
    expect(registry.stopOwned(owner, "disconnected")).toEqual(["thread-a"]);
    expect(registry.stopReason("thread-a", "temporary-c")).toBe("disconnected");
    expect(registry.stopReason("thread-b", "temporary-d")).toBeNull();
  });

  it("times out bounded runs and invokes cancellation", async () => {
    const cancel = vi.fn();
    await expect(withReviewSummaryTimeout(new Promise<never>(() => undefined), 5, cancel, 0))
      .rejects.toThrow(/timed out/u);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
