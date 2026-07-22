import { describe, expect, it } from "vitest";

import { buildAgentInputAnswers } from "../../src/renderer/src/utils/agentInput";
import type { AgentInputRequest } from "../../src/shared/contracts";

describe("agent input answers", () => {
  it("preserves the exact entered secret after whitespace-only completeness checks", () => {
    const request: AgentInputRequest = {
      id: "11111111-1111-4111-8111-111111111111",
      conversationId: "22222222-2222-4222-8222-222222222222",
      runId: "33333333-3333-4333-8333-333333333333",
      autoResolutionMs: null,
      questions: [{ id: "token", header: "Token", question: "Enter the token", isOther: false, isSecret: true, options: [] }],
    };

    expect(buildAgentInputAnswers(request, { token: "  secret value  " })).toEqual({ token: ["  secret value  "] });
  });
});
