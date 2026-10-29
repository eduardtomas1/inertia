import { describe, expect, it } from "vitest";

import { CustomAgentTraceAttribution } from "../../src/server/runtime/turns/turn-custom-agent-traces";

const CALL = { agentId: "6f1c2a64-5d1e-4c55-9d43-1a2b3c4d5e6f", handle: "reviewer" };

function trace(overrides: Partial<Parameters<CustomAgentTraceAttribution["resolve"]>[0]> = {}) {
  return {
    providerTaskId: null,
    providerAgentId: null,
    providerToolUseId: null,
    parentProviderAgentId: null,
    parentProviderToolUseId: null,
    providerRole: null,
    providerName: null,
    ...overrides,
  };
}

describe("CustomAgentTraceAttribution", () => {
  it("attributes Claude traces only by the exact native subagent type", () => {
    const attribution = new CustomAgentTraceAttribution(CALL, "claude");
    expect(attribution.resolve(trace({ providerToolUseId: "tool-1", providerRole: "Explore" }))).toBeNull();
    expect(attribution.resolve(trace({ providerToolUseId: "tool-2", providerRole: "inertia-reviewer" }))).toBe(CALL.agentId);
    expect(attribution.resolve(trace({ providerToolUseId: "tool-3", providerRole: "inertia-reviewer-2" }))).toBeNull();
    expect(attribution.resolve(trace({ providerToolUseId: "tool-2", providerRole: null }))).toBe(CALL.agentId);
  });

  it("matches the native name in the provider name case-insensitively", () => {
    const attribution = new CustomAgentTraceAttribution(CALL, "opencode");
    expect(attribution.resolve(trace({ providerAgentId: "ses-1", providerName: " Inertia-Reviewer " }))).toBe(CALL.agentId);
  });

  it("falls back to the first top-level Codex trace when the task name is free text", () => {
    const attribution = new CustomAgentTraceAttribution(CALL, "codex");
    expect(attribution.resolve(trace({ providerAgentId: "thread-1", providerRole: "default", providerName: "Review the patch" }))).toBe(CALL.agentId);
    expect(attribution.resolve(trace({ providerAgentId: "thread-2", providerRole: "default", providerName: "Other work" }))).toBeNull();
    expect(attribution.resolve(trace({ providerAgentId: "thread-2", providerRole: "default", providerName: "Other work" }))).toBeNull();
  });

  it("falls back for a Cursor task that carries no role", () => {
    const attribution = new CustomAgentTraceAttribution(CALL, "cursor");
    expect(attribution.resolve(trace({ providerToolUseId: "task-1" }))).toBe(CALL.agentId);
  });

  it("does not fall back on Claude, whose subagent type is always reported", () => {
    const attribution = new CustomAgentTraceAttribution(CALL, "claude");
    expect(attribution.resolve(trace({ providerToolUseId: "tool-1", providerRole: "general-purpose" }))).toBeNull();
  });

  it("lets child traces inherit their parent's custom agent by agent or tool-use identity", () => {
    const attribution = new CustomAgentTraceAttribution(CALL, "claude");
    expect(attribution.resolve(trace({ providerAgentId: "agent-1", providerToolUseId: "tool-1", providerRole: "inertia-reviewer" }))).toBe(CALL.agentId);
    expect(attribution.resolve(trace({ providerAgentId: "agent-2", parentProviderAgentId: "agent-1", providerRole: "Explore" }))).toBe(CALL.agentId);
    expect(attribution.resolve(trace({ providerToolUseId: "tool-3", parentProviderToolUseId: "tool-1", providerRole: "Plan" }))).toBe(CALL.agentId);
    expect(attribution.resolve(trace({ providerAgentId: "agent-4", parentProviderAgentId: "agent-2" }))).toBe(CALL.agentId);
  });

  it("keeps children of an unattributed trace unattributed", () => {
    const attribution = new CustomAgentTraceAttribution(CALL, "codex");
    expect(attribution.resolve(trace({ providerAgentId: "thread-1", providerName: "inertia-reviewer" }))).toBe(CALL.agentId);
    expect(attribution.resolve(trace({ providerAgentId: "thread-2", providerName: "Explore" }))).toBeNull();
    expect(attribution.resolve(trace({ providerAgentId: "thread-3", parentProviderAgentId: "thread-2" }))).toBeNull();
  });
});
