import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentTurn, SubagentTrace } from "../../src/shared/contracts";
import {
  COMPOSER_PREFILL_EVENT,
  registerComposerPrefillTarget,
  type ComposerPrefillDetail,
} from "../../src/renderer/src/utils/composerPrefill";
import { requestSubagentFollowUp } from "../../src/renderer/src/utils/subagentFollowUp";

const liveTurn = {
  id: "turn-1",
  harnessId: "claude-agent-sdk",
  status: "running",
} as AgentTurn;

function trace(update: Partial<SubagentTrace> = {}): SubagentTrace {
  return {
    turnId: "turn-1",
    isLive: true,
    description: "Inspect the repository.",
    providerRole: "researcher",
    ...update,
  } as SubagentTrace;
}

const details: ComposerPrefillDetail[] = [];
const capture = (event: Event): void => {
  details.push((event as CustomEvent<ComposerPrefillDetail>).detail);
};

beforeEach(() => {
  details.length = 0;
  window.addEventListener(COMPOSER_PREFILL_EVENT, capture);
});

afterEach(() => {
  window.removeEventListener(COMPOSER_PREFILL_EVENT, capture);
});

describe("subagent follow-up", () => {
  it("prefills the owning composer with the delegated task", () => {
    requestSubagentFollowUp("conversation-1", trace(), [liveTurn]);
    requestSubagentFollowUp("conversation-1", trace({ description: null }), [liveTurn]);
    requestSubagentFollowUp("conversation-1", trace({ description: null, providerRole: null }), [liveTurn]);

    expect(details).toEqual([
      {
        conversationId: "conversation-1",
        text: "Please follow up on the delegated task “Inspect the repository.” and incorporate its latest result.",
      },
      {
        conversationId: "conversation-1",
        text: "Please follow up on the delegated task “researcher” and incorporate its latest result.",
      },
      {
        conversationId: "conversation-1",
        text: "Please follow up on the delegated task “delegated task” and incorporate its latest result.",
      },
    ]);
  });

  it("ignores traces that cannot take a follow-up", () => {
    expect(requestSubagentFollowUp("conversation-1", trace({ isLive: false }), [liveTurn])).toBe("not-applicable");
    expect(requestSubagentFollowUp("conversation-1", trace(), [{ ...liveTurn, status: "completed" }])).toBe("not-applicable");
    expect(requestSubagentFollowUp("conversation-1", trace({ turnId: "turn-2" }), [liveTurn])).toBe("not-applicable");

    expect(details).toEqual([]);
  });

  it("reports whether the chat's message box received the follow-up", () => {
    expect(requestSubagentFollowUp("conversation-1", trace(), [liveTurn])).toBe("unavailable");
    const received: string[] = [];
    const unregister = registerComposerPrefillTarget({
      conversationId: () => "conversation-1",
      receive: (text) => received.push(text),
    });
    try {
      expect(requestSubagentFollowUp("conversation-1", trace(), [liveTurn])).toBe("delivered");
    } finally {
      unregister();
    }
    expect(received).toEqual([
      "Please follow up on the delegated task “Inspect the repository.” and incorporate its latest result.",
    ]);
  });
});
