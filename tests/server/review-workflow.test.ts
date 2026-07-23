import { describe, expect, it } from "vitest";

import { readOnlyReviewRunInput } from "../../src/server";

describe("diff review workflow", () => {
  it("forces Ask into a fresh read-only review turn even when the thread has Build mode and Full Access", () => {
    const input = readOnlyReviewRunInput({
      providerId: "codex",
      model: "gpt-test",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "full",
      providerSessionId: "normal-resumable-session",
    }, "temporary-review-id", "/tmp/isolated-review", "Explain the selected lines.");

    expect(input).toEqual({
      providerId: "codex",
      conversationId: "temporary-review-id",
      cwd: "/tmp/isolated-review",
      prompt: "Explain the selected lines.",
      model: "gpt-test",
      reasoningEffort: "high",
      interactionMode: "plan",
      access: "supervised",
    });
    expect(input).not.toHaveProperty("sessionId");
  });
});
