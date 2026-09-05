import { describe, expect, it } from "vitest";

import type { AgentRunTerminalState, ProviderId } from "../../src/shared/contracts";
import { AuthoritativeRunStateEngine } from "../../src/server/runtime/run-state-engine";

const PROVIDERS: readonly ProviderId[] = [
  "codex",
  "claude",
  "cursor",
  "kimi",
  "opencode",
];

const ACTIONS = [
  "provider-progress",
  "approval-open",
  "descendant-open",
  "cancel",
  "request-failure",
  "settle-completed",
  "settle-failed",
] as const;

type Action = (typeof ACTIONS)[number];

function engine(providerId: ProviderId): AuthoritativeRunStateEngine {
  return new AuthoritativeRunStateEngine({
    providerId,
    conversationId: `conversation-${providerId}`,
    runId: `run-${providerId}`,
    turnId: `turn-${providerId}`,
  });
}

function sequences(length: number, prefix: readonly Action[] = []): Action[][] {
  if (length === 0) return [[...prefix]];
  return ACTIONS.flatMap((action) => sequences(length - 1, [...prefix, action]));
}

function apply(
  subject: AuthoritativeRunStateEngine,
  action: Action,
): AgentRunTerminalState | null | boolean {
  switch (action) {
    case "provider-progress":
      return subject.setTransport("running", "provider/running");
    case "approval-open":
      return subject.synchronizeInteractions(1, 0, "approval/open", "approval");
    case "descendant-open":
      return subject.observeDescendant("child-1", true, "child/running");
    case "cancel":
      return subject.requestCancellation("cancelled", "cancel/requested");
    case "request-failure":
      return subject.requestTerminal("failed", "failure/requested");
    case "settle-completed":
      return subject.settle("completed", "provider/completed");
    case "settle-failed":
      return subject.settle("failed", "provider/failed");
  }
}

describe("authoritative run-state adversarial interleavings", () => {
  it.each([
    {
      name: "terminal then cancel",
      actions: ["settle-completed", "cancel"] as const,
      terminal: "completed",
    },
    {
      name: "cancel then provider terminal",
      actions: ["cancel", "settle-completed"] as const,
      terminal: "cancelled",
    },
    {
      name: "failure intent wins a later completion",
      actions: ["request-failure", "settle-completed"] as const,
      terminal: "failed",
    },
    {
      name: "duplicate terminal cannot replace the first",
      actions: ["settle-completed", "settle-failed"] as const,
      terminal: "completed",
    },
    {
      name: "interaction and descendant cannot revive cancellation",
      actions: ["cancel", "approval-open", "descendant-open", "settle-completed"] as const,
      terminal: "cancelled",
    },
  ])("keeps one outcome for $name", ({ actions, terminal }) => {
    const subject = engine("codex");
    for (const action of actions) apply(subject, action);
    expect(subject.snapshot().state).toBe(terminal);
    expect(subject.isTerminal()).toBe(true);
    expect(subject.acceptsProviderEvents()).toBe(false);
  });

  it("preserves global monotonicity after every four-action sequence", () => {
    for (const providerId of PROVIDERS) {
      for (const scenario of sequences(4)) {
        const subject = engine(providerId);
        let priorRevision = subject.snapshot().revision;
        let admissionClosed = false;
        let selectedTerminal: AgentRunTerminalState | null = null;
        let terminalSelections = 0;

        for (const action of scenario) {
          const wasAccepting = subject.acceptsProviderEvents();
          const result = apply(subject, action);
          const snapshot = subject.snapshot();

          if (snapshot.revision < priorRevision) {
            throw new Error(`${providerId}: revision regressed for ${scenario.join(" -> ")}.`);
          }
          priorRevision = snapshot.revision;

          if (!subject.acceptsProviderEvents()) admissionClosed = true;
          if (admissionClosed && subject.acceptsProviderEvents()) {
            throw new Error(`${providerId}: admission reopened for ${scenario.join(" -> ")}.`);
          }

          if (action === "settle-completed" || action === "settle-failed") {
            if (result !== null) {
              terminalSelections += 1;
              selectedTerminal = result as AgentRunTerminalState;
            }
          }
          if (terminalSelections > 1) {
            throw new Error(`${providerId}: selected two outcomes for ${scenario.join(" -> ")}.`);
          }
          if (selectedTerminal) {
            if (
              subject.snapshot().state !== selectedTerminal
              || !subject.isTerminal()
            ) {
              throw new Error(`${providerId}: terminal outcome changed for ${scenario.join(" -> ")}.`);
            }
          }

          if (!wasAccepting && (
            action === "provider-progress"
            || action === "approval-open"
            || action === "descendant-open"
          ) && result !== false) {
            throw new Error(`${providerId}: accepted late provider work for ${scenario.join(" -> ")}.`);
          }
        }
      }
    }
    expect(PROVIDERS.length * (ACTIONS.length ** 4)).toBe(12_005);
  });
});
