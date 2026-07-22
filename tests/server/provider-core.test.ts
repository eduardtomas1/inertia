import { describe, expect, it } from "vitest";

import {
  buildProviderInvocation,
  normalizeProviderLine,
  validateProviderRunInput,
  type ProviderParserState,
} from "../../src/server/provider/adapters";
import type { ProviderId, ProviderRunInput } from "../../src/server/provider/contracts";

function input(providerId: ProviderId, overrides: Partial<ProviderRunInput> = {}): ProviderRunInput {
  return {
    providerId,
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

  it("validates the stable provider run contract before launching", () => {
    expect(validateProviderRunInput(input("claude"))).toBe("conversation-1");
    expect(() => validateProviderRunInput(input("claude", { prompt: "" }))).toThrow("A prompt is required.");
    expect(() => validateProviderRunInput(input("claude", { imagePaths: ["bad\0path"] }))).toThrow("An image path is invalid.");
  });
});
