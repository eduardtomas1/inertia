import { describe, expect, it } from "vitest";

import { buildAgentInputAnswers, inputRequestTitle } from "../../src/renderer/src/utils/agentInput";
import type { AgentInputRequest } from "../../src/shared/contracts";

describe("agent input answers", () => {
  const request = {
    id: "11111111-1111-4111-8111-111111111111",
    providerId: "claude",
    conversationId: "22222222-2222-4222-8222-222222222222",
    runId: "33333333-3333-4333-8333-333333333333",
    autoResolutionMs: null,
  } satisfies Omit<AgentInputRequest, "questions">;

  it("preserves exact secret and custom values while retaining multiple native option IDs", () => {
    const input: AgentInputRequest = {
      ...request,
      questions: [
        { id: "token", header: "Token", question: "Enter the token", isOther: false, isSecret: true, allowMultiple: false, options: [] },
        {
          id: "targets",
          header: "Targets",
          question: "Choose targets",
          isOther: true,
          isSecret: false,
          allowMultiple: true,
          options: [
            { id: "native-api", label: "API", description: "" },
            { id: "native-web", label: "Web", description: "" },
          ],
        },
      ],
    };

    expect(buildAgentInputAnswers(input, {
      token: "  secret value  ",
      targets: ["native-api", "native-web", "a custom target"],
    })).toEqual({
      token: ["  secret value  "],
      targets: ["native-api", "native-web", "a custom target"],
    });
  });

  it("uses the emitting provider captured on the request for branding", () => {
    expect(inputRequestTitle("claude")).toBe("Claude needs your input");
    expect(inputRequestTitle("cursor")).toBe("Cursor needs your input");
    expect(inputRequestTitle("opencode")).toBe("OpenCode needs your input");
    expect(inputRequestTitle("codex")).toBe("Codex needs your input");
    expect(inputRequestTitle("future-provider")).toBe("The agent needs your input");
  });
});
