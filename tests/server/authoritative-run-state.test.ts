import { describe, expect, it } from "vitest";

import type { ProviderId } from "../../src/shared/contracts";
import { AuthoritativeRunStateEngine } from "../../src/server/runtime/run-state-engine";

const PROVIDERS: readonly ProviderId[] = [
  "codex",
  "claude",
  "cursor",
  "kimi",
  "opencode",
];

function engine(providerId: ProviderId = "codex"): AuthoritativeRunStateEngine {
  return new AuthoritativeRunStateEngine({
    providerId,
    conversationId: `conversation-${providerId}`,
    runId: `run-${providerId}`,
    turnId: `turn-${providerId}`,
  });
}

describe("AuthoritativeRunStateEngine", () => {
  it.each(PROVIDERS)("preserves %s identity through live and terminal states", (providerId) => {
    const state = engine(providerId);
    expect(state.identity).toEqual({
      providerId,
      conversationId: `conversation-${providerId}`,
      runId: `run-${providerId}`,
      turnId: `turn-${providerId}`,
    });
    expect(state.setTransport("starting", "native/starting")).toBe(true);
    expect(state.setTransport("running", "native/running")).toBe(true);
    expect(state.settle("completed", "native/completed")).toBe("completed");
    expect(state.snapshot()).toMatchObject({
      state: "completed",
      providerState: "native/completed",
    });
    expect(state.setTransport("running", "late/running")).toBe(false);
    expect(state.settle("failed", "late/failure")).toBeNull();
  });

  it("prioritizes the most recently requested live interaction without losing another", () => {
    const state = engine();
    state.setTransport("running");
    state.synchronizeInteractions(1, 0, "approval/open", "approval");
    expect(state.snapshot().state).toBe("waiting-for-approval");
    state.synchronizeInteractions(1, 1, "input/open", "input");
    expect(state.snapshot().state).toBe("waiting-for-input");
    state.synchronizeInteractions(1, 0, "input/resolved");
    expect(state.snapshot().state).toBe("waiting-for-approval");
    state.synchronizeInteractions(0, 0, "approval/resolved");
    expect(state.snapshot().state).toBe("running");
  });

  it("keeps root completion separate from delegated descendant lifecycle", () => {
    const state = engine("claude");
    state.setTransport("running");
    expect(state.observeDescendant("child-1", true, "delegate/running")).toBe(true);
    expect(state.snapshot().state).toBe("delegated");
    expect(state.observeDescendant("child-2", true, "delegate/pending")).toBe(true);
    expect(state.observeDescendant("child-1", false, "delegate/completed")).toBe(true);
    expect(state.snapshot().state).toBe("delegated");
    expect(state.observeDescendant("child-2", false, "delegate/completed")).toBe(true);
    expect(state.snapshot().state).toBe("running");
    expect(state.isTerminal()).toBe(false);
  });

  it("keeps retrying live and returns to provider work on explicit progress", () => {
    const state = engine("opencode");
    state.setTransport("running");
    state.setTransport("retrying", "session.status/retry attempt 2");
    expect(state.snapshot()).toMatchObject({
      state: "retrying",
      providerState: "session.status/retry attempt 2",
    });
    state.setTransport("running", "session.status/busy");
    expect(state.snapshot().state).toBe("running");
  });

  it("quarantines late events while cancellation waits for exact cleanup", () => {
    const state = engine("cursor");
    state.setTransport("running");
    expect(state.requestTerminal("cancelled", "cancel/requested")).toBe(true);
    expect(state.snapshot().state).toBe("cancelling");
    expect(state.isTerminal()).toBe(false);
    expect(state.acceptsProviderEvents()).toBe(false);
    expect(state.setTransport("running", "late/busy")).toBe(false);
    expect(state.settle("completed", "late/completed")).toBe("cancelled");
    expect(state.snapshot().state).toBe("cancelled");
  });

  it("bounds malformed provider-native state without inventing equivalence", () => {
    const state = engine("kimi");
    state.setTransport("retrying", `\0provider\n${"x".repeat(400)}`);
    expect(state.snapshot().providerState).toHaveLength(200);
    expect(state.snapshot().providerState).not.toMatch(/[\u0000-\u001f\u007f]/u);
    expect(state.snapshot().state).toBe("retrying");
  });
});
