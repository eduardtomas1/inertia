import { describe, expect, it } from "vitest";

import {
  privateConnectConversationDeepLink,
  privateConnectConversationIdFromFragment,
} from "../../src/renderer/private-connect/src/pwa";

const conversationId = "33333333-3333-4333-8333-333333333333";

describe("Private Connect PWA navigation", () => {
  it("uses a credential-free fragment for conversation notification targets", () => {
    const target = privateConnectConversationDeepLink(conversationId);
    expect(target).toBe(`/#conversation=${conversationId}`);
    expect(privateConnectConversationIdFromFragment(target.slice(1))).toBe(
      conversationId,
    );
  });

  it("rejects malformed or non-conversation fragments", () => {
    expect(privateConnectConversationIdFromFragment("#pair=secret")).toBeNull();
    expect(privateConnectConversationIdFromFragment("#conversation=../../api/request")).toBeNull();
    expect(privateConnectConversationDeepLink("not-a-conversation")).toBe("/");
  });
});
