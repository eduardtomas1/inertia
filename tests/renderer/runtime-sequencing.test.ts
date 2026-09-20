import { describe, expect, it } from "vitest";

import {
  RuntimeDetailSubscriptions,
  runtimeResumeUrl,
  RuntimeProjectionSequence,
} from "../../src/renderer/src/utils/runtimeSequencing";

const GENERATION_A = "11111111-1111-4111-8111-111111111111";
const GENERATION_B = "22222222-2222-4222-8222-222222222222";
const CONVERSATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONVERSATION_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("RuntimeProjectionSequence", () => {
  it("retains all four pane subscriptions through reconnect and individual closure", () => {
    const subscriptions = new RuntimeDetailSubscriptions();
    const ids = [CONVERSATION, CONVERSATION_B, CONVERSATION_C,
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd"];
    for (const [index, owner] of (["primary", "secondary", "tertiary", "quaternary"] as const).entries()) {
      subscriptions.set(owner, ids[index]);
    }
    expect(subscriptions.mountedPanes()).toEqual([
      { owner: "primary", conversationId: ids[0] },
      { owner: "secondary", conversationId: ids[1] },
      { owner: "tertiary", conversationId: ids[2] },
      { owner: "quaternary", conversationId: ids[3] },
    ]);
    const url = new URL(runtimeResumeUrl(
      "ws://127.0.0.1:4312/runtime/token",
      { runtimeGeneration: GENERATION_A, latestSequence: 23 },
      subscriptions.mountedPanes(),
    ));
    expect(url.searchParams.getAll("conversationId")).toEqual(ids);
    expect(url.searchParams.getAll("conversationOwner"))
      .toEqual(["primary", "secondary", "tertiary", "quaternary"]);
    subscriptions.set("secondary", null);
    expect(subscriptions.mountedPanes()).toEqual([
      { owner: "primary", conversationId: ids[0] },
      { owner: "tertiary", conversationId: ids[2] },
      { owner: "quaternary", conversationId: ids[3] },
    ]);
  });

  it("ignores duplicates and requires a refresh for a live gap", () => {
    const projection = new RuntimeProjectionSequence();
    projection.replaceFromSnapshot({ runtimeGeneration: GENERATION_A, latestSequence: 5 });

    expect(projection.classifyFrame({ runtimeGeneration: GENERATION_A, latestSequence: 5 })).toBe("ignore");
    expect(projection.classifyFrame({ runtimeGeneration: GENERATION_A, latestSequence: 6 })).toBe("apply");
    expect(projection.classifyFrame({ runtimeGeneration: GENERATION_A, latestSequence: 8 })).toBe("gap");
    expect(projection.current()?.latestSequence).toBe(6);
  });

  it("deduplicates snapshot overlap during replay and completes only at the advertised head", () => {
    const projection = new RuntimeProjectionSequence();
    projection.replaceFromSnapshot({ runtimeGeneration: GENERATION_A, latestSequence: 3 });
    expect(projection.beginResume({ runtimeGeneration: GENERATION_A, latestSequence: 5 })).toBe("resume");
    expect(projection.classifyFrame({ runtimeGeneration: GENERATION_A, latestSequence: 3 })).toBe("ignore");
    expect(projection.classifyFrame({ runtimeGeneration: GENERATION_A, latestSequence: 4 })).toBe("apply");
    expect(projection.complete({ runtimeGeneration: GENERATION_A, latestSequence: 4 })).toBe("gap");
    expect(projection.complete({ runtimeGeneration: GENERATION_A, latestSequence: 5 })).toBe("gap");
    expect(projection.classifyFrame({ runtimeGeneration: GENERATION_A, latestSequence: 5 })).toBe("apply");
    expect(projection.complete({ runtimeGeneration: GENERATION_A, latestSequence: 5 })).toBe("completed");
    expect(projection.current()?.synchronized).toBe(true);
  });

  it("never combines incompatible runtime generations", () => {
    const projection = new RuntimeProjectionSequence();
    projection.replaceFromSnapshot({ runtimeGeneration: GENERATION_A, latestSequence: 10 });
    expect(projection.beginResume({ runtimeGeneration: GENERATION_B, latestSequence: 0 }))
      .toBe("generation-mismatch");
    expect(projection.classifyFrame({ runtimeGeneration: GENERATION_B, latestSequence: 11 }))
      .toBe("generation-mismatch");

    projection.replaceFromSnapshot({ runtimeGeneration: GENERATION_B, latestSequence: 0 });
    expect(projection.current()).toMatchObject({
      runtimeGeneration: GENERATION_B,
      latestSequence: 0,
      synchronized: false,
    });
  });

  it("builds a reconnect URL from the last accepted cursor and active detail subscription", () => {
    const result = new URL(runtimeResumeUrl(
      "ws://127.0.0.1:4312/runtime/token",
      { runtimeGeneration: GENERATION_A, latestSequence: 19 },
      [{ owner: "primary", conversationId: CONVERSATION }],
    ));
    expect(result.searchParams.get("runtimeGeneration")).toBe(GENERATION_A);
    expect(result.searchParams.get("afterSequence")).toBe("19");
    expect(result.searchParams.get("conversationId")).toBe(CONVERSATION);
    expect(result.searchParams.get("conversationOwner")).toBe("primary");
    expect(runtimeResumeUrl(
      "ws://127.0.0.1:4312/runtime/token",
      null,
      [{ owner: "primary", conversationId: CONVERSATION }],
    ))
      .toBe("ws://127.0.0.1:4312/runtime/token");
  });

  it("builds reconnect ownership from mounted panes rather than recent loads", () => {
    const subscriptions = new RuntimeDetailSubscriptions();
    subscriptions.set("primary", CONVERSATION);
    subscriptions.set("secondary", CONVERSATION_B);
    subscriptions.set("secondary", null);
    subscriptions.set("secondary", CONVERSATION_C);

    expect(subscriptions.mountedPanes()).toEqual([
      { owner: "primary", conversationId: CONVERSATION },
      { owner: "secondary", conversationId: CONVERSATION_C },
    ]);
    const resumed = new URL(runtimeResumeUrl(
      "ws://127.0.0.1:4312/runtime/token",
      { runtimeGeneration: GENERATION_A, latestSequence: 23 },
      subscriptions.mountedPanes(),
    ));
    expect(resumed.searchParams.getAll("conversationId")).toEqual([
      CONVERSATION,
      CONVERSATION_C,
    ]);

    subscriptions.set("secondary", CONVERSATION);
    expect(subscriptions.mountedPanes()).toEqual([
      { owner: "primary", conversationId: CONVERSATION },
      { owner: "secondary", conversationId: CONVERSATION },
    ]);
  });
});
