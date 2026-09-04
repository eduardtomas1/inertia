import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SelectionReviewAnswerCard } from "../../src/renderer/src/components/SelectionReviewAnswerCard";
import type { DiffSelectionReviewAnswer } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

function answer(): DiffSelectionReviewAnswer {
  return {
    conversationId: crypto.randomUUID(),
    fingerprint: "a".repeat(64),
    filePath: "src/review.ts",
    hunkId: "hunk-1",
    selectedLineCount: 2,
    question: "Why does this change matter?",
    answer: "It preserves the exact selection. <script>unsafe()</script>",
    providerId: "codex",
    modelSelection: providerNativeModelSelection({
      providerId: "codex",
      modelId: "gpt-5.4",
      alias: "GPT 5.4",
      reasoningEffort: "high",
    }),
    generatedAt: "2026-07-25T12:00:00.000Z",
  };
}

describe("selection review answer", () => {
  it("renders the isolated answer and exact backend/model attribution as escaped contextual UI", () => {
    const html = renderToStaticMarkup(createElement(
      SelectionReviewAnswerCard,
      { answer: answer(), onDismiss: () => undefined },
    ));

    expect(html).toContain("Agent answer");
    expect(html).toContain("Why does this change matter?");
    expect(html).toContain("OpenAI · GPT 5.4 · 2 selected lines");
    expect(html).toContain("&lt;script&gt;unsafe()&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain('aria-label="Dismiss selection answer"');
  });
});
