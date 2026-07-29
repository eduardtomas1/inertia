import { describe, expect, it } from "vitest";

import {
  runtimeConversationReference,
} from "../../src/renderer/src/components/workspace-scene/createWorkspaceSceneModel";

describe("runtime conversation references", () => {
  it("omits renderer-only draft identities from runtime commands", () => {
    expect(runtimeConversationReference(null)).toEqual({});
  });

  it("includes identities that have been persisted by the runtime", () => {
    const conversation = {
      id: "22222222-2222-4222-8222-222222222222",
    };

    expect(runtimeConversationReference(conversation)).toEqual({
      conversationId: conversation.id,
    });
  });
});
