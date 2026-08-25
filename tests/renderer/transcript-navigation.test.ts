import { describe, expect, it } from "vitest";

import type { MessageSendAcceptance } from "../../src/shared/contracts";
import {
  initialTranscriptNavigation,
  transcriptNavigationFollowsContent,
  transcriptNavigationReducer,
} from "../../src/renderer/src/utils/transcriptNavigation";

const newTurn: MessageSendAcceptance = {
  kind: "message.accepted",
  conversationId: "conversation-1",
  turnId: "turn-2",
  userMessageId: "message-2",
  disposition: "new-turn",
};

describe("transcript new-turn navigation", () => {
  it("anchors an accepted new turn and follows its live response", () => {
    const reading = transcriptNavigationReducer(
      initialTranscriptNavigation("conversation-1"),
      {
        type: "reader.scrolled",
        conversationId: "conversation-1",
        followsLatest: false,
        intentional: true,
      },
    );

    const awaiting = transcriptNavigationReducer(reading, {
      type: "message.accepted",
      acceptance: newTurn,
      sourceConversationId: "conversation-1",
    });
    expect(awaiting).toEqual({
      mode: "await-turn",
      conversationId: "conversation-1",
      turnId: "turn-2",
    });
    expect(transcriptNavigationFollowsContent(awaiting)).toBe(false);

    const anchored = transcriptNavigationReducer(awaiting, {
      type: "turn.anchored",
      conversationId: "conversation-1",
      turnId: "turn-2",
    });
    expect(anchored).toEqual({
      mode: "follow-turn",
      conversationId: "conversation-1",
      turnId: "turn-2",
    });
    expect(transcriptNavigationFollowsContent(anchored)).toBe(true);

    expect(transcriptNavigationReducer(anchored, {
      type: "reader.scrolled",
      conversationId: "conversation-1",
      followsLatest: false,
      intentional: false,
    })).toBe(anchored);
  });

  it("carries a draft acceptance onto its materialized conversation", () => {
    const readingDraft = {
      mode: "reading-history" as const,
      conversationId: "draft-conversation",
    };
    const accepted = transcriptNavigationReducer(readingDraft, {
      type: "message.accepted",
      acceptance: {
        ...newTurn,
        materializedFromConversationId: "draft-conversation",
      },
      sourceConversationId: "draft-conversation",
    });

    expect(accepted).toEqual({
      mode: "await-turn",
      conversationId: "conversation-1",
      turnId: "turn-2",
    });
    expect(transcriptNavigationReducer(accepted, {
      type: "conversation.changed",
      conversationId: "conversation-1",
    })).toBe(accepted);
  });

  it("releases turn following only for deliberate reader navigation", () => {
    const anchored = {
      mode: "follow-turn" as const,
      conversationId: "conversation-1",
      turnId: "turn-2",
    };

    expect(transcriptNavigationReducer(anchored, {
      type: "reader.scrolled",
      conversationId: "conversation-1",
      followsLatest: false,
      intentional: true,
    })).toEqual({
      mode: "reading-history",
      conversationId: "conversation-1",
    });
  });

  it("does not let programmatic scroll events override reader-owned history", () => {
    const reading = {
      mode: "reading-history" as const,
      conversationId: "conversation-1",
    };

    expect(transcriptNavigationReducer(reading, {
      type: "reader.scrolled",
      conversationId: "conversation-1",
      followsLatest: true,
      intentional: false,
    })).toBe(reading);
  });

  it("does not anchor active-turn follow-ups or another conversation", () => {
    const reading = {
      mode: "reading-history" as const,
      conversationId: "conversation-1",
    };
    const followUp: MessageSendAcceptance = {
      ...newTurn,
      disposition: "follow-up",
    };

    expect(transcriptNavigationReducer(reading, {
      type: "message.accepted",
      acceptance: followUp,
      sourceConversationId: "conversation-1",
    })).toBe(reading);
    expect(transcriptNavigationReducer(reading, {
      type: "message.accepted",
      acceptance: { ...newTurn, conversationId: "conversation-2" },
      sourceConversationId: "conversation-2",
    })).toBe(reading);
  });

  it("cancels a pending anchor and treats duplicate acceptance as exactly once", () => {
    const awaiting = transcriptNavigationReducer(
      initialTranscriptNavigation("conversation-1"),
      {
        type: "message.accepted",
        acceptance: newTurn,
        sourceConversationId: "conversation-1",
      },
    );
    expect(transcriptNavigationReducer(awaiting, {
      type: "message.accepted",
      acceptance: newTurn,
      sourceConversationId: "conversation-1",
    })).toBe(awaiting);
    expect(transcriptNavigationReducer(awaiting, {
      type: "turn.anchor-cancelled",
      conversationId: "conversation-1",
      turnId: "turn-2",
    })).toEqual({
      mode: "reading-history",
      conversationId: "conversation-1",
    });
  });
});
