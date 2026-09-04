import { describe, expect, it } from "vitest";

import {
  buildProviderInvocation,
  normalizeProviderLine,
  validateProviderRunInput,
  type ProviderParserState,
} from "../../src/server/provider/adapters";
import type { ProviderId, ProviderRunInput } from "../../src/server/provider/contracts";
import { nativeProviderRunFields } from "./model-route-fixture";
import {
  continuationIdentityForSelection,
  withModelSelectionFastMode,
} from "../../src/shared/model-routing";

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

  it("settles legacy initialization facts and reuses duration identities", () => {
    for (const providerId of ["claude", "cursor", "kimi"] as const) {
      const state: ProviderParserState = {
        sawText: false,
        sawStreamingDelta: false,
        hadErrorEvent: false,
      };
      const activities: Array<{
        phase: string;
        label: string;
        activityId?: string;
      }> = [];
      normalizeProviderLine(
        providerId,
        JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: providerId + "-session",
        }),
        state,
        () => undefined,
        (_kind, phase, label, detail) => {
          activities.push({ phase, label, ...detail });
        },
        () => undefined,
      );
      expect(activities).toEqual([{
        phase: "completed",
        label: "Session initialized",
      }]);
    }

    const fixtures = [
      {
        providerId: "codex" as const,
        lines: [
          { type: "turn.started", thread_id: "codex-session" },
          { type: "turn.started", thread_id: "codex-session" },
          { type: "turn.completed", thread_id: "codex-session" },
        ],
      },
      {
        providerId: "opencode" as const,
        lines: [
          { type: "step_start", part: { sessionID: "opencode-session" } },
          { type: "step_start", part: { sessionID: "opencode-session" } },
          {
            type: "step_finish",
            part: { sessionID: "opencode-session", reason: "stop" },
          },
        ],
      },
    ];
    for (const fixture of fixtures) {
      const state: ProviderParserState = {
        sawText: false,
        sawStreamingDelta: false,
        hadErrorEvent: false,
      };
      const activities: Array<{ phase: string; activityId?: string }> = [];
      for (const line of fixture.lines) {
        normalizeProviderLine(
          fixture.providerId,
          JSON.stringify(line),
          state,
          () => undefined,
          (_kind, phase, _label, detail) => {
            activities.push({ phase, activityId: detail?.activityId });
          },
          () => undefined,
        );
      }
      expect(activities.map(({ phase }) => phase)).toEqual([
        "started",
        "started",
        "completed",
      ]);
      expect(new Set(activities.map(({ activityId }) => activityId)).size)
        .toBe(1);
      expect(activities[0]?.activityId).toBeTruthy();
    }
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

  it("owns a provider control operation without inventing a durable turn", () => {
    expect(validateProviderRunInput(input("claude", {
      runId: "compact-operation-1",
      sessionId: "session-1",
      operation: { kind: "compact" },
    }))).toBe("conversation-1");
    expect(() => validateProviderRunInput(input("claude", {
      runId: "ordinary-run-1",
    }))).toThrow("Run and turn identities must be provided together.");
    expect(() => validateProviderRunInput(input("claude", {
      runId: "compact-operation-1",
      turnId: "invented-turn-1",
      sessionId: "session-1",
      operation: { kind: "compact" },
    }))).toThrow("provider compaction request is invalid");
    expect(() => validateProviderRunInput(input("claude", {
      runId: "compact-operation-1",
      sessionId: "session-1",
      supportedFastMode: "fast",
      performanceModeTransition: "to-standard",
      operation: { kind: "compact" },
    }))).toThrow("provider compaction request is invalid");
  });

  it("validates provider-native Fast mode and continuation transitions exactly", () => {
    const codex = input("codex");
    const fastSelection = withModelSelectionFastMode(
      codex.modelSelection,
      "priority",
    );
    const fastInput = {
      ...codex,
      supportedFastMode: "priority" as const,
      modelSelection: fastSelection,
      continuationIdentity: continuationIdentityForSelection(
        fastSelection,
        null,
        false,
      ),
    };
    expect(validateProviderRunInput(fastInput)).toBe("conversation-1");
    expect(() => validateProviderRunInput({
      ...fastInput,
      modelSelection: {
        ...fastSelection,
        providerOptions: { fastMode: "priority", temperature: 0 },
      },
    })).toThrow("Fast mode route is invalid");

    const cursor = input("cursor");
    expect(() => validateProviderRunInput({
      ...cursor,
      modelSelection: {
        ...cursor.modelSelection,
        providerOptions: { fastMode: "priority" },
      },
      continuationIdentity: {
        ...cursor.continuationIdentity,
        performanceModeIdentity: "fast:priority",
      },
    })).toThrow("Fast mode route is invalid");
    expect(() => validateProviderRunInput({
      ...fastInput,
      performanceModeTransition: "to-fast",
    })).toThrow("continuation transition is invalid");
    expect(validateProviderRunInput({
      ...codex,
      supportedFastMode: "priority",
      sessionId: "thread-fast",
      performanceModeTransition: "to-standard",
    })).toBe("conversation-1");
    expect(validateProviderRunInput({
      ...codex,
      supportedFastMode: "priority",
    })).toBe("conversation-1");
    expect(() => validateProviderRunInput({
      ...codex,
      supportedFastMode: "fast",
    })).toThrow("Fast mode route is invalid");
    expect(() => validateProviderRunInput({
      ...codex,
      harnessId: "codex-cli",
      sessionId: "thread-fast",
      performanceModeTransition: "to-standard",
    })).toThrow("continuation transition is invalid");
    expect(() => validateProviderRunInput({
      ...codex,
      backendProfile: {
        ...codex.backendProfile,
        id: "custom:openai",
      },
      sessionId: "thread-fast",
      performanceModeTransition: "to-standard",
    })).toThrow("continuation transition is invalid");
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
