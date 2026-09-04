import { describe, expect, it } from "vitest";

import { openCodeQuestionPayload } from "../../src/server/provider/opencode-boundary";
import { openCodeExternalApprovalDecision } from "../../src/server/provider/opencode-sdk-events";

function question(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    header: "Scope",
    question: "Which scope?",
    options: [{ label: "Focused", description: "Only this package" }],
    custom: true,
    ...overrides,
  };
}

describe("OpenCode interaction boundaries", () => {
  it("only treats current exact affirmative permission replies as approval", () => {
    expect([
      "once",
      "always",
      "reject",
      "cancel",
      "approve",
      "Once",
      "always ",
      "future-affirmative-reply",
      null,
      { reply: "once" },
    ].map(openCodeExternalApprovalDecision)).toEqual([
      "approve",
      "approve",
      "deny",
      "cancelled",
      "cancelled",
      "cancelled",
      "cancelled",
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
  });

  it("accepts bounded visible question copy and preserves safe line breaks", () => {
    expect(openCodeQuestionPayload([question({
      question: "Which scope\nshould OpenCode use?",
      options: [{
        label: "Focused",
        description: "Only this package\nand its tests",
      }],
    })])).toEqual([expect.objectContaining({
      header: "Scope",
      question: "Which scope\nshould OpenCode use?",
      options: [{
        label: "Focused",
        description: "Only this package\nand its tests",
      }],
    })]);
  });

  it("rejects unsafe, blank, and oversized question display copy", () => {
    const unsafeQuestions = [
      question({ header: "Scope\nspoofed" }),
      question({ question: "Choose\u202Etxt.exe" }),
      question({ options: [{ label: "Safe\u0000hidden", description: "Details" }] }),
      question({ options: [{ label: "Safe", description: "Details\u2066hidden" }] }),
      question({ header: "   " }),
      question({ question: "x".repeat(16_385) }),
      question({ header: "x".repeat(257) }),
      question({ options: [{ label: "x".repeat(513), description: "Details" }] }),
      question({ options: [{ label: "Safe", description: "x".repeat(4_097) }] }),
    ];

    for (const unsafe of unsafeQuestions) {
      expect(() => openCodeQuestionPayload([unsafe])).toThrow(/OpenCode sent invalid/u);
    }
  });

  it("rejects normalized duplicate prompts and option labels", () => {
    expect(() => openCodeQuestionPayload([
      question({ question: "  CAFÉ? " }),
      question({ header: "Next", question: "cafe\u0301?" }),
    ])).toThrow("duplicate question prompts");

    expect(() => openCodeQuestionPayload([question({
      options: [
        { label: " CAFÉ ", description: "First" },
        { label: "cafe\u0301", description: "Second" },
      ],
    })])).toThrow("duplicate option label");
  });
});
