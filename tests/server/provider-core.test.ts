import { describe, expect, it } from "vitest";

import {
  buildProviderInvocation,
  normalizeProviderLine,
  validateProviderRunInput,
  type ProviderParserState,
} from "../../src/server/provider/adapters";
import type { ProviderId, ProviderRunInput } from "../../src/server/provider/contracts";
import { nativeProviderRunFields } from "./model-route-fixture";

function input(providerId: ProviderId, overrides: Partial<ProviderRunInput> = {}): ProviderRunInput {
  return {
    ...nativeProviderRunFields(providerId),
    conversationId: "conversation-1",
    cwd: "/workspace",
    prompt: "Inspect this project",
    interactionMode: "build",
    access: "supervised",
    ...overrides,
  } as ProviderRunInput;
}

describe("provider adapter seams", () => {
  it("keeps each provider invocation isolated", () => {
    expect(buildProviderInvocation(input("codex", { sessionId: "thread-1" }), "codex")).toMatchObject({
      command: "codex",
      args: ["exec", "resume", "--json", "--skip-git-repo-check", "--config", 'sandbox_mode="workspace-write"', "--config", 'approval_policy="on-request"', "thread-1", "-"],
      stdin: "Inspect this project",
    });
    expect(buildProviderInvocation(input("claude", { interactionMode: "plan" }), "claude").args).toContain("plan");
    expect(buildProviderInvocation(input("cursor", { access: "full" }), "cursor-agent").args).toContain("--force");
    expect(buildProviderInvocation(input("opencode", { interactionMode: "plan" }), "opencode").args).toEqual([
      "run", "--format", "json", "--agent", "plan", "--", "Inspect this project",
    ]);
  });

  it("normalizes provider-native events through the adapter contract", () => {
    const state: ProviderParserState = {
      sawText: false,
      sawStreamingDelta: false,
      hadErrorEvent: false,
    };
    const text: string[] = [];
    const sessions: string[] = [];
    const activities: Array<[string, string, string]> = [];
    normalizeProviderLine(
      "cursor",
      JSON.stringify({ type: "result", session_id: "session-1", result: "Done", is_error: false }),
      state,
      (value) => text.push(value),
      (kind, phase, label) => activities.push([kind, phase, label]),
      (sessionId) => sessions.push(sessionId),
    );
    expect(text).toEqual(["Done"]);
    expect(sessions).toEqual(["session-1"]);
    expect(activities).toEqual([["turn", "completed", "Turn completed"]]);
  });

  it("keeps every CLI provider's structured tool output in activity detail", () => {
    const fixtures: Array<{
      providerId: ProviderId;
      lines: unknown[];
      expectedId: string;
      expectedDetail: string;
    }> = [
      {
        providerId: "codex",
        lines: [{
          type: "item.completed",
          item: {
            id: "codex-call",
            type: "command_execution",
            command: "npm test",
            aggregated_output: "passed",
          },
        }],
        expectedId: "codex-call",
        expectedDetail: "Command:\nnpm test\n\nOutput:\npassed",
      },
      {
        providerId: "claude",
        lines: [
          {
            type: "assistant",
            message: {
              content: [{
                type: "tool_use",
                id: "claude-call",
                name: "Bash",
                input: { command: "npm test" },
              }],
            },
          },
          {
            type: "user",
            message: {
              content: [{
                type: "tool_result",
                tool_use_id: "claude-call",
                content: [{ type: "text", text: "passed" }],
              }],
            },
          },
        ],
        expectedId: "claude-call",
        expectedDetail: "Output:\npassed",
      },
      {
        providerId: "cursor",
        lines: [{
          type: "tool_call",
          subtype: "completed",
          tool_call: {
            toolCallId: "cursor-call",
            kind: "execute",
            name: "Shell",
            rawInput: { command: "npm test" },
            rawOutput: "passed",
          },
        }],
        expectedId: "cursor-call",
        expectedDetail: "Command:\nnpm test\n\nOutput:\npassed",
      },
      {
        providerId: "opencode",
        lines: [{
          type: "tool_use",
          part: {
            id: "part-1",
            callID: "opencode-call",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "npm test" },
              output: "passed",
            },
          },
        }],
        expectedId: "opencode-call",
        expectedDetail: "Command:\nnpm test\n\nOutput:\npassed",
      },
    ];

    for (const fixture of fixtures) {
      const state: ProviderParserState = {
        sawText: false,
        sawStreamingDelta: false,
        hadErrorEvent: false,
      };
      const activities: Array<{
        activityId?: string;
        detail?: string;
      }> = [];
      for (const line of fixture.lines) {
        normalizeProviderLine(
          fixture.providerId,
          JSON.stringify(line),
          state,
          () => undefined,
          (_kind, _phase, _label, detail) => activities.push(detail ?? {}),
          () => undefined,
        );
      }
      expect(activities.at(-1)).toMatchObject({
        activityId: fixture.expectedId,
        detail: fixture.expectedDetail,
      });
    }
  });

  it("validates the stable provider run contract before launching", () => {
    expect(validateProviderRunInput(input("claude"))).toBe("conversation-1");
    expect(() => validateProviderRunInput(input("claude", { prompt: "" }))).toThrow("A prompt is required.");
    expect(() => validateProviderRunInput(input("claude", { imagePaths: ["bad\0path"] }))).toThrow("An image path is invalid.");
  });

  it("accepts bounded Codex goal starts with or without an established session", () => {
    expect(validateProviderRunInput(input("codex", {
      sessionId: "thread-1",
      goalStart: { objective: "Ship the goal", tokenBudget: 12_000 },
      goalContinuationExpected: true,
    }))).toBe("conversation-1");
    expect(validateProviderRunInput(input("codex", {
      sessionId: "thread-1",
      goalStart: { objective: "Ship without a budget", tokenBudget: null },
    }))).toBe("conversation-1");
    expect(validateProviderRunInput(input("codex", {
      goalStart: { objective: "Create the first session" },
      goalContinuationExpected: true,
    }))).toBe("conversation-1");
    expect(() => validateProviderRunInput(input("claude", {
      sessionId: "session-1",
      goalStart: { objective: "Wrong provider" },
    }))).toThrow("native goal start request is invalid");
    for (const tokenBudget of [0, 1_000_000_001, 1.5]) {
      expect(() => validateProviderRunInput(input("codex", {
        sessionId: "thread-1",
        goalStart: { objective: "Invalid budget", tokenBudget },
      }))).toThrow("native goal start request is invalid");
    }
    expect(() => validateProviderRunInput(input("codex", {
      sessionId: "thread-1",
      goalStart: { objective: "  " },
    }))).toThrow("native goal start request is invalid");
    expect(() => validateProviderRunInput(input("codex", {
      goalContinuationExpected: "yes" as unknown as boolean,
    }))).toThrow("goal continuation hint is invalid");
    expect(() => validateProviderRunInput(input("claude", {
      sessionId: "session-1",
      goalContinuationExpected: true,
    }))).toThrow("goal continuation hint is invalid");
  });
});
