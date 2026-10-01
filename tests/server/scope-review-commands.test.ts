import { nativeModelSelection } from "../../src/shared/model-routing";
import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import type { ReviewBrief } from "../../src/shared/review-brief";
import { parseUnifiedDiff } from "../../src/shared/diff-review";
import { createIsolatedReviewCommandHandler, type IsolatedReviewCommandDependencies } from "../../src/server/runtime/commands/isolated-review-commands";

const git = vi.hoisted(() => ({ getUnifiedDiff: vi.fn() }));
vi.mock("../../src/server/git", async (importOriginal) => ({ ...await importOriginal<typeof import("../../src/server/git")>(), getUnifiedDiff: git.getUnifiedDiff }));
const patch = "diff --git a/retry.ts b/retry.ts\n--- a/retry.ts\n+++ b/retry.ts\n@@ -1 +1 @@\n-retry(1)\n+retry(3)\n";
const parsed = parseUnifiedDiff(patch);

describe("review brief generation ownership", () => {
  it.each(["success", "brief changed before", "brief changed during", "diff changed during", "wrong project"])("handles %s without saving stale findings", async (scenario) => {
    const conversationId = randomUUID(), projectId = randomUUID();
    const brief: ReviewBrief = { conversationId, revision: 1, requirements: ["Retry three times"], sources: [] };
    const currentBrief = vi.fn(() => brief);
    const persist = vi.fn();
    git.getUnifiedDiff.mockReset().mockResolvedValue({ text: patch, truncated: false });
    type RunOptions = { request: { executionPrompt: string }; toolPolicy: string; interactionPolicy: string;
      onResult: (output: { text: string; harnessId: string; backendProfileId: string; model: null }, context: { assertActive: () => void }) => Promise<unknown> };
    const run = vi.fn(async (options: RunOptions) => {
      expect(options.request.executionPrompt).toContain("Retry three times");
      expect(options.toolPolicy).toBe("none");
      expect(options.interactionPolicy).toBe("fail-closed");
      if (scenario === "brief changed during") currentBrief.mockReturnValue({ ...brief, revision: 2 });
      if (scenario === "diff changed during") git.getUnifiedDiff.mockResolvedValue({ text: patch + "\n", truncated: false });
      const text = JSON.stringify({ overall: "Adds retries", classifications: [], files: parsed.files.map((file) => ({ path: file.path, summary: "Adds retries", classifications: [],
        hunks: file.hunks.map((hunk) => ({ hunkId: hunk.id, summary: "Three attempts", classifications: [] })) })),
      scopeReview: { requirements: [{ requirementIndex: 0, evidence: [{ path: "retry.ts", hunkId: parsed.files[0]!.hunks[0]!.id, kind: "implementation", reason: "Three attempts", confidence: "high" }] }], unexplained: [] } });
      return { value: await options.onResult({ text, harnessId: "codex", backendProfileId: "native:codex", model: null }, { assertActive: () => undefined }) };
    });
    const dependencies = { store: { conversation: () => ({ id: conversationId, projectId, providerId: "codex", model: null, modelSelection: nativeModelSelection({ providerId: "codex" }) }),
      conversationPath: () => "/fixture", reviewBrief: currentBrief, upsertReviewSummary: persist },
    turns: { isActive: () => false }, isolatedRuns: { has: () => false, run }, secureFiles: {}, enableProviders: true,
    providerInfo: () => [{ id: "codex", canRun: true, models: [] }], send: vi.fn() } as unknown as IsolatedReviewCommandDependencies;
    const pending = createIsolatedReviewCommandHandler(dependencies)({} as WebSocket, {
      type: "review.summary.generate", requestId: randomUUID(), payload: { conversationId,
        projectId: scenario === "wrong project" ? randomUUID() : projectId,
        fingerprint: parsed.fingerprint, briefRevision: scenario === "brief changed before" ? 0 : 1 },
    });
    if (scenario === "success") { await pending; expect(persist).toHaveBeenCalledOnce(); }
    else { await expect(pending).rejects.toThrow(/brief changed|stale summary|belong/); expect(persist).not.toHaveBeenCalled(); }
    if (scenario === "wrong project" || scenario === "brief changed before") expect(run).not.toHaveBeenCalled();
  });
});
