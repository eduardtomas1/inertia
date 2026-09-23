import { describe, expect, it } from "vitest";

import { claudeQuestions } from "../../src/server/provider/claude-questions";
import { clientCommandSchema } from "../../src/shared/contracts/client-command";

describe("Claude question answers", () => {
  it("accepts answers to every question in a full Claude question request", () => {
    const questions = Array.from({ length: 4 }, (_, questionIndex) => ({
      header: `Question ${questionIndex + 1}`,
      question: `Prompt ${questionIndex + 1}`,
      options: [
        { label: "Yes", description: "Accept" },
        { label: "No", description: "Decline" },
      ],
    }));
    const request = claudeQuestions("request-full", "tool-full", { questions });
    const respond = (answers: Record<string, string[]>) => clientCommandSchema.safeParse({
      type: "agent.input.respond",
      requestId: "11111111-1111-4111-8111-111111111111",
      payload: {
        conversationId: "22222222-2222-4222-8222-222222222222",
        requestId: "33333333-3333-4333-8333-333333333333",
        answers,
      },
    });
    const answers = Object.fromEntries(
      request.questions.map((question) => [question.id, [question.options[0]!.id]]),
    );

    expect(respond(answers).success).toBe(true);
    expect(respond({ ...answers, "tool-full:question:5": ["option-1"] }).success).toBe(false);
  });
});
