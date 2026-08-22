import type { Event } from "@opencode-ai/sdk/v2";
import { describe, expect, it } from "vitest";

import {
  OpenCodeSessionOwnership,
} from "../../src/server/provider/opencode-session-ownership";

function event(value: unknown): Event {
  return value as Event;
}

function created(
  id: string,
  parentID: string,
  sessionID: string | null = id,
): Event {
  return event({
    type: "session.created",
    properties: {
      ...(sessionID ? { sessionID } : {}),
      info: { id, parentID },
    },
  });
}

describe("OpenCode descendant session ownership", () => {
  it("accepts only exact parent-linked descendants, including transitive ones", () => {
    const ownership = new OpenCodeSessionOwnership("root-session");

    expect(ownership.observe(event({
      type: "session.status",
      properties: { sessionID: "root-session", status: { type: "busy" } },
    }))).toBe("root");
    expect(ownership.observe(created(
      "mismatched-child",
      "root-session",
      "different-session",
    ))).toBe("unrelated");
    expect(ownership.observe(created(
      "foreign-child",
      "foreign-parent",
    ))).toBe("unrelated");
    expect(ownership.observe(created("child-session", "root-session")))
      .toBe("descendant");
    expect(ownership.observe(created(
      "grandchild-session",
      "child-session",
      null,
    ))).toBe("descendant");
    expect(ownership.observe(event({
      type: "message.part.updated",
      properties: {
        sessionID: "grandchild-session",
        part: { type: "text", text: "private" },
      },
    }))).toBe("descendant");
  });

  it("rejects unsafe identities and bounds the verified session graph", () => {
    const ownership = new OpenCodeSessionOwnership("root-session");
    expect(ownership.observe(created("unsafe\nchild", "root-session")))
      .toBe("unrelated");
    for (let index = 0; index < 255; index += 1) {
      expect(ownership.observe(created(`child-${index}`, "root-session")))
        .toBe("descendant");
    }
    expect(() => ownership.observe(created("child-overflow", "root-session")))
      .toThrow("bounded owned-session budget");
  });
});
