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
  it("reasserts liveness for repeated busy state without replay progress credit", () => {
    const ownership = new OpenCodeSessionOwnership("root-session", 1_024);
    const busy = event({
      id: "child-busy",
      type: "session.status",
      properties: {
        sessionID: "child-session",
        status: { type: "busy" },
      },
    });

    ownership.observe(created("child-session", "root-session"));
    expect(ownership.observe(busy))
      .toEqual({ scope: "descendant", active: true });
    expect(ownership.observe(event({
      type: "session.idle",
      properties: { sessionID: "child-session" },
    }))).toEqual({
      scope: "descendant",
      active: false,
      lifecycleProgress: true,
    });
    expect(ownership.hasLiveDescendants()).toBe(false);

    expect(ownership.observe(event({ ...busy, id: "repeated-child-busy" })))
      .toEqual({ scope: "descendant", active: false });
    expect(ownership.hasLiveDescendants()).toBe(true);
  });

  it("tracks verified descendant liveness independently across the session graph", () => {
    const ownership = new OpenCodeSessionOwnership("root-session", 1_024);
    const childWork = (id: string, sessionID = "child-session"): Event => event({
      id,
      type: "message.updated",
      properties: {
        sessionID,
        info: {
          id: `${sessionID}-message-${id}`,
          sessionID,
          role: "assistant",
        },
      },
    });

    expect(ownership.hasLiveDescendants()).toBe(false);
    ownership.observe(created("child-session", "root-session"));
    ownership.observe(created("grandchild-session", "child-session"));
    expect(ownership.hasLiveDescendants()).toBe(true);

    const childIdle = event({
      id: "initial-child-idle",
      type: "session.idle",
      properties: { sessionID: "child-session" },
    });
    expect(ownership.observe(childIdle)).toEqual({
      scope: "descendant",
      active: false,
      lifecycleProgress: true,
    });
    expect(ownership.hasLiveDescendants()).toBe(true);
    expect(ownership.observe(event({
      type: "session.status",
      properties: {
        sessionID: "grandchild-session",
        status: { type: "idle" },
      },
    }))).toEqual({
      scope: "descendant",
      active: false,
      lifecycleProgress: true,
    });
    expect(ownership.hasLiveDescendants()).toBe(false);

    ownership.observe(childWork("fresh-after-idle"));
    expect(ownership.hasLiveDescendants()).toBe(true);
    expect(ownership.observe(event({ ...childIdle, id: "replayed-idle" })))
      .toEqual({ scope: "descendant", active: false });
    expect(ownership.hasLiveDescendants()).toBe(true);
    expect(ownership.observe(event({
      type: "session.error",
      properties: {
        sessionID: "child-session",
        error: { name: "UnknownError", data: { message: "failed" } },
      },
    }))).toEqual({
      scope: "descendant",
      active: false,
      lifecycleProgress: true,
    });
    expect(ownership.hasLiveDescendants()).toBe(false);
    ownership.observe(childWork("after-error"));
    expect(ownership.hasLiveDescendants()).toBe(true);
    ownership.observe(event({
      type: "session.status",
      properties: {
        sessionID: "child-session",
        status: { type: "idle" },
      },
    }));
    expect(ownership.hasLiveDescendants()).toBe(false);

    ownership.observe(created("deleted-child", "root-session"));
    expect(ownership.hasLiveDescendants()).toBe(true);
    ownership.observe(event({
      type: "session.deleted",
      properties: { info: { id: "deleted-child" } },
    }));
    ownership.observe(childWork("after-delete", "deleted-child"));
    expect(ownership.hasLiveDescendants()).toBe(false);

    ownership.observe(event({
      type: "session.status",
      properties: { sessionID: "root-session", status: { type: "busy" } },
    }));
    ownership.observe(childWork("foreign", "foreign-session"));
    expect(ownership.hasLiveDescendants()).toBe(false);
  });

  it("accepts only exact parent-linked descendants, including transitive ones", () => {
    const ownership = new OpenCodeSessionOwnership("root-session", 1_024);

    expect(ownership.observe(event({
      type: "session.status",
      properties: { sessionID: "root-session", status: { type: "busy" } },
    }))).toEqual({
      scope: "root",
      active: false,
      novelRootActivity: true,
    });
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
    const ownership = new OpenCodeSessionOwnership("root-session", 1_024);
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
    expect(ownership.observe(event({
      id: "replayed-with-a-new-envelope-id",
      properties: {
        info: {
          role: "assistant",
          sessionID: "child-session",
          id: "child-message",
        },
        sessionID: "child-session",
      },
      type: "message.updated",
    })))
      .toEqual({ scope: "descendant", active: false });
    expect(ownership.observe(event({
      id: "idle-event",
      type: "session.idle",
      properties: { sessionID: "child-session" },
    }))).toEqual({
      scope: "descendant",
      active: false,
      lifecycleProgress: true,
    });
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
    expect(ownership.observe(event({
      id: "malformed-known-event",
      type: "session.next.text.delta",
      properties: {
        sessionID: "child-session",
        timestamp: Date.now(),
      },
    }))).toEqual({ scope: "descendant", active: false });
    expect(ownership.observe(event({
      id: "valid-next-event",
      type: "session.next.text.delta",
      properties: {
        sessionID: "child-session",
        timestamp: Date.now(),
        assistantMessageID: "child-assistant",
        textID: "child-text",
        delta: "working",
      },
    }))).toEqual({ scope: "descendant", active: true });
    expect(ownership.observe(event({
      id: "invalid-step-model",
      type: "session.next.step.started",
      properties: {
        sessionID: "child-session",
        timestamp: Date.now(),
        assistantMessageID: "child-assistant",
        agent: "general",
        model: {},
      },
    }))).toEqual({ scope: "descendant", active: false });
    expect(ownership.observe(event({
      id: "invalid-prompt-payload",
      type: "session.next.prompted",
      properties: {
        sessionID: "child-session",
        timestamp: Date.now(),
        messageID: "child-message",
        prompt: {},
        delivery: "queue",
      },
    }))).toEqual({ scope: "descendant", active: false });
    expect(ownership.observe(event({
      id: "invalid-tool-provider",
      type: "session.next.tool.called",
      properties: {
        sessionID: "child-session",
        timestamp: Date.now(),
        assistantMessageID: "child-assistant",
        callID: "child-call",
        tool: "read",
        input: {},
        provider: {},
      },
    }))).toEqual({ scope: "descendant", active: false });
    expect(ownership.observe(event({
      id: "agent-switch",
      type: "session.next.agent.switched",
      properties: {
        sessionID: "child-session",
        timestamp: Date.now(),
        messageID: "child-message",
        agent: "general",
      },
    }))).toEqual({ scope: "descendant", active: true });
    expect(ownership.observe(event({
      id: "model-switch",
      type: "session.next.model.switched",
      properties: {
        sessionID: "child-session",
        timestamp: Date.now(),
        messageID: "child-message",
        model: { providerID: "opencode", modelID: "x-preview" },
      },
    }))).toEqual({ scope: "descendant", active: true });
  });

  it("rejects unsafe identities and bounds the verified session graph", () => {
    const ownership = new OpenCodeSessionOwnership("root-session", 1_024);
    expect(ownership.observe(created("unsafe\nchild", "root-session")))
      .toEqual({ scope: "unrelated", active: false });
    for (let index = 0; index < 255; index += 1) {
      expect(ownership.observe(created(`child-${index}`, "root-session")))
        .toEqual({ scope: "descendant", active: true });
    }
    expect(() => ownership.observe(created("child-overflow", "root-session")))
      .toThrow("bounded owned-session budget");
  });

  it("deduplicates replay payloads with canonically equivalent Unicode keys", () => {
    const ownership = new OpenCodeSessionOwnership("root-session", 1_024);
    expect(ownership.observe(created("child-session", "root-session")))
      .toEqual({ scope: "descendant", active: true });
    const toolEvent = (input: Record<string, unknown>, id: string): Event => event({
      id,
      type: "session.next.tool.called",
      properties: {
        sessionID: "child-session",
        timestamp: 1,
        assistantMessageID: "child-assistant",
        callID: "child-call",
        tool: "read",
        input,
        provider: { executed: false },
      },
    });

    expect(ownership.observe(toolEvent({ "é": 1, "e\u0301": 2 }, "first")))
      .toEqual({ scope: "descendant", active: true });
    expect(ownership.observe(toolEvent({ "e\u0301": 2, "é": 1 }, "replay")))
      .toEqual({ scope: "descendant", active: false });
  });

  it("retains replay evidence and fails closed at its cumulative capacity", () => {
    const ownership = new OpenCodeSessionOwnership("root-session", 2);
    expect(ownership.observe(created("child-session", "root-session")))
      .toEqual({ scope: "descendant", active: true });
    const messageEvent = (messageId: string, id: string): Event => event({
      id,
      type: "message.updated",
      properties: {
        sessionID: "child-session",
        info: {
          id: messageId,
          sessionID: "child-session",
          role: "assistant",
        },
      },
    });
    const first = messageEvent("child-message-1", "first");

    expect(ownership.observe(first))
      .toEqual({ scope: "descendant", active: true });
    expect(ownership.observe(messageEvent("child-message-2", "second")))
      .toEqual({ scope: "descendant", active: false });
    expect(ownership.hasLiveDescendants()).toBe(true);
    ownership.observe(event({
      type: "session.idle",
      properties: { sessionID: "child-session" },
    }));
    expect(ownership.hasLiveDescendants()).toBe(true);
    expect(ownership.observe(event({ ...first, id: "replayed-first" })))
      .toEqual({ scope: "descendant", active: false });
    expect(ownership.hasLiveDescendants()).toBe(true);
    expect(ownership.observe(messageEvent("child-message-3", "third")))
      .toEqual({ scope: "descendant", active: false });
    expect(ownership.hasLiveDescendants()).toBe(true);
    expect(() => new OpenCodeSessionOwnership("root-session", 0))
      .toThrow("activity-evidence budget is invalid");
  });

  it("fails closed when descendant activity cannot be canonicalized", () => {
    const ownership = new OpenCodeSessionOwnership("root-session", 1_024);
    expect(ownership.observe(created("child-session", "root-session")))
      .toEqual({ scope: "descendant", active: true });
    const recursiveInput: Record<string, unknown> = {};
    recursiveInput.self = recursiveInput;

    expect(ownership.observe(event({
      id: "uncanonicalizable-terminal",
      type: "session.error",
      properties: {
        sessionID: "child-session",
        error: recursiveInput,
      },
    }))).toEqual({ scope: "descendant", active: false });
    expect(ownership.hasLiveDescendants()).toBe(true);

    expect(ownership.observe(event({
      id: "uncanonicalizable-event",
      type: "session.next.tool.called",
      properties: {
        sessionID: "child-session",
        timestamp: Date.now(),
        assistantMessageID: "child-assistant",
        callID: "child-call",
        tool: "read",
        input: recursiveInput,
        provider: { executed: false },
      },
    }))).toEqual({ scope: "descendant", active: false });
  });
});
