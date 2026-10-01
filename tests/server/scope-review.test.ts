import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../../src/shared/diff-review";
import type { ReviewBrief } from "../../src/shared/review-brief";
import { validatedScopeReview } from "../../src/server/scope-review";
import { buildReviewSummaryPrompt, parseReviewSummaryResult, validatePersistedReviewSummary } from "../../src/server/review-summary";
import { ReviewRepository } from "../../src/server/persistence/review-repository";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import type { ConversationRow } from "../../src/server/persistence/rows";

const patch = ["diff --git a/retry.ts b/retry.ts", "--- a/retry.ts", "+++ b/retry.ts", "@@ -1 +1 @@", "-retry(1)", "+retry(3)",
  "diff --git a/auth.ts b/auth.ts", "--- a/auth.ts", "+++ b/auth.ts", "@@ -1 +1 @@", "-authenticate()", "+skipAuth()", ""].join("\n");
const parsed = parseUnifiedDiff(patch);
const brief: ReviewBrief = { conversationId: randomUUID(), revision: 1, requirements: ["Retry up to three times", "Test failed retries"], sources: [] };
const review = () => ({ requirements: [
  { requirementIndex: 0, evidence: [{ path: "retry.ts", hunkId: parsed.files[0]!.hunks[0]!.id, kind: "implementation", reason: "Retry limit increases to three.", confidence: "high" }] },
  { requirementIndex: 1, evidence: [] },
], unexplained: [{ path: "auth.ts", hunkId: parsed.files[1]!.hunks[0]!.id, reason: "Skipping authentication has no clear connection to retries.", confidence: "medium" }] });

describe("scope review evidence", () => {
  it("preserves missing evidence and uncertain findings without claiming test execution", () => {
    const result = validatedScopeReview(review(), brief, parsed.files);
    expect(result.requirements[1]?.evidence).toEqual([]);
    expect(result.unexplained[0]?.confidence).toBe("medium");
    const prompt = buildReviewSummaryPrompt(patch, parsed.files, brief);
    expect(prompt).toContain("Retry up to three times");
    expect(prompt).toContain("NEVER establishes that tests ran or passed");
    expect(prompt).toContain("untrusted data");
  });
  it.each(["unknown target", "duplicate requirement", "missing requirement", "missing change", "mapped and unexplained", "duplicate evidence"])("rejects %s", (failure) => {
    const value = review();
    if (failure === "unknown target") value.requirements[0]!.evidence[0]!.path = "secrets.ts";
    if (failure === "duplicate requirement") value.requirements.push(value.requirements[0]!);
    if (failure === "missing requirement") value.requirements.pop();
    if (failure === "missing change") value.unexplained = [];
    if (failure === "mapped and unexplained") value.unexplained.push({ ...value.requirements[0]!.evidence[0]! });
    if (failure === "duplicate evidence") value.requirements[0]!.evidence.push(value.requirements[0]!.evidence[0]!);
    expect(() => validatedScopeReview(value, brief, parsed.files)).toThrow();
  });
  it("accounts for binary and rename-only files without inventing hunks", () => {
    const result = validatedScopeReview({ requirements: [{ requirementIndex: 0, evidence: [] }, { requirementIndex: 1, evidence: [] }],
      unexplained: [{ path: "logo.png", hunkId: null, reason: "No link to retries", confidence: "low" }] }, brief, [{ path: "logo.png", hunks: [] }]);
    expect(result.unexplained[0]?.hunkId).toBeNull();
  });
  it("round trips intent with the summary, but rejects omitted or unsolicited analysis", () => {
    const raw = { overall: "Retry changes and unrelated authentication edit.", classifications: [],
      files: parsed.files.map((file) => ({ path: file.path, summary: "Changed behavior", classifications: [],
        hunks: file.hunks.map((hunk) => ({ hunkId: hunk.id, summary: "Changed behavior", classifications: [] })) })), scopeReview: review() };
    const parse = (value: unknown, input?: ReviewBrief) => parseReviewSummaryResult(brief.conversationId,
      { providerId: "codex", harnessId: "codex", backendProfileId: "native:codex", model: null }, parsed.fingerprint, parsed.files, JSON.stringify(value), undefined, input);
    const summary = parse(raw, brief);
    expect(validatePersistedReviewSummary(summary).scopeReview?.brief).toEqual(brief);
    expect(() => parse({ ...raw, scopeReview: undefined }, brief)).toThrow(/missing or unexpected/);
    expect(() => parse(raw)).toThrow(/missing or unexpected/);
    expect(() => validatePersistedReviewSummary({ ...summary, conversationId: randomUUID() })).toThrow(/owner/);
  });
});

describe("review brief persistence", () => {
  it("upgrades the released schema and guards ownership, revisions, bounds and cascade deletion", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    try {
      migrateRuntimeDatabase(db, 85);
      migrateRuntimeDatabase(db);
      // Use the real schema without a runtime or provider process.
      const projectId = randomUUID();
      db.prepare("INSERT INTO projects (id, name, path, color, status, created_at, updated_at) VALUES (?, 'Review', '/review', '#000000', 'ready', ?, ?)").run(projectId, new Date().toISOString(), new Date().toISOString());
      db.prepare("INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES (?, ?, 'Review', ?, ?)")
        .run(brief.conversationId, projectId, new Date().toISOString(), new Date().toISOString());
      const messageId = randomUUID();
      db.prepare("INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', 'Please add retries', ?)")
        .run(messageId, brief.conversationId, new Date().toISOString());
      const repository = new ReviewRepository({ database: db, requireConversation: (id) => {
        const row = db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as ConversationRow | undefined;
        if (!row) throw new Error("Unknown chat"); return row;
      } });
      const saved = repository.saveBrief(brief.conversationId, 0, { requirements: brief.requirements, sourceMessageIds: [messageId] });
      expect(new ReviewRepository({ database: db, requireConversation: () => { throw new Error("unused"); } }).brief(brief.conversationId)).toEqual(saved);
      expect(saved.sources[0]?.excerpt).toBe("Please add retries");
      expect(() => repository.saveBrief(brief.conversationId, 0, { requirements: [], sourceMessageIds: [] })).toThrow(/another window/);
      expect(() => repository.saveBrief(brief.conversationId, 1, { requirements: [], sourceMessageIds: [randomUUID()] })).toThrow(/this chat/);
      expect(() => repository.saveBrief(brief.conversationId, 1, { requirements: ["x".repeat(801)], sourceMessageIds: [] })).toThrow();
      expect(repository.brief(brief.conversationId)?.revision).toBe(1);
      db.prepare("DELETE FROM conversations WHERE id = ?").run(brief.conversationId);
      expect(repository.brief(brief.conversationId)).toBeNull();
    } finally { db.close(); }
  });
});
