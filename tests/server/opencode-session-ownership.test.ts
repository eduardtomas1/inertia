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
    }))).toEqual({ scope: "root", active: false });
    expect(ownership.observe(created(
      "mismatched-child",
      "root-session",
      "different-session",
    ))).toEqual({ scope: "unrelated", active: false });
    expect(ownership.observe(created(
      "foreign-child",
      "foreign-parent",
    ))).toEqual({ scope: "unrelated", active: false });
    expect(ownership.observe(created("child-session", "root-session")))
      .toEqual({ scope: "descendant", active: true });
    expect(ownership.observe(created(
      "grandchild-session",
      "child-session",
      null,
    ))).toEqual({ scope: "descendant", active: true });
    expect(ownership.observe(event({
      type: "message.part.updated",
      properties: {
        part: {
          id: "private-part",
          messageID: "private-message",
          sessionID: "grandchild-session",
          type: "text",
          text: "private",
        },
      },
    }))).toEqual({ scope: "descendant", active: true });
  });

  it("refreshes only validated, non-duplicate descendant work", () => {
    const ownership = new OpenCodeSessionOwnership("root-session");
    const childCreated = created("child-session", "root-session");
    const activeMessage = event({
      type: "message.updated",
      properties: {
        sessionID: "child-session",
        info: {
          id: "child-message",
          sessionID: "child-session",
          role: "assistant",
        },
      },
    });

    expect(ownership.observe(childCreated))
      .toEqual({ scope: "descendant", active: true });
    expect(ownership.observe(childCreated))
      .toEqual({ scope: "descendant", active: false });
    expect(ownership.observe(activeMessage))
      .toEqual({ scope: "descendant", active: true });
    expect(ownership.observe(activeMessage))
      .toEqual({ scope: "descendant", active: false });
    expect(ownership.observe(event({
      id: "idle-event",
      type: "session.idle",
      properties: { sessionID: "child-session" },
    }))).toEqual({ scope: "descendant", active: false });
    expect(ownership.observe(event({
      id: "metadata-event",
      type: "session.updated",
      properties: {
        info: { id: "child-session", parentID: "root-session" },
      },
    }))).toEqual({ scope: "descendant", active: false });
    expect(ownership.observe(event({
      id: "unknown-event",
      type: "session.telemetry",
      properties: { sessionID: "child-session" },
    }))).toEqual({ scope: "descendant", active: false });
  });

  it("rejects unsafe identities and bounds the verified session graph", () => {
    const ownership = new OpenCodeSessionOwnership("root-session");
    expect(ownership.observe(created("unsafe\nchild", "root-session")))
      .toEqual({ scope: "unrelated", active: false });
    for (let index = 0; index < 255; index += 1) {
      expect(ownership.observe(created(`child-${index}`, "root-session")))
        .toEqual({ scope: "descendant", active: true });
    }
    expect(() => ownership.observe(created("child-overflow", "root-session")))
      .toThrow("bounded owned-session budget");
  });
});
