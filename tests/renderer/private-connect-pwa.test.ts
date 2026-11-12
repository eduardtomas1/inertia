import { describe, expect, it } from "vitest";

import {
  privateConnectConversationIdFromFragment,
} from "../../src/renderer/private-connect/src/pwa";

const conversationId = "33333333-3333-4333-8333-333333333333";

describe("Private Connect PWA navigation", () => {
  it("uses a credential-free fragment for conversation notification targets", () => {
    expect(privateConnectConversationIdFromFragment(`#conversation=${conversationId}`)).toBe(
      conversationId,
    );
  });

  it("rejects malformed or non-conversation fragments", () => {
    expect(privateConnectConversationIdFromFragment("#pair=secret")).toBeNull();
    expect(privateConnectConversationIdFromFragment("#conversation=../../api/request")).toBeNull();
  });
});
