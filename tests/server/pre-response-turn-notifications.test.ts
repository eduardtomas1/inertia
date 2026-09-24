import { describe, expect, it } from "vitest";

import {
  MAX_PRE_RESPONSE_TURN_NOTIFICATIONS,
  PreResponseTurnNotifications,
} from "../../src/server/codex/pre-response-turn-notifications";

describe("pre-response turn notifications", () => {
  it("replays only the returned turn's notifications, in order, once", () => {
    const held = new PreResponseTurnNotifications();
    expect(held.hold("turn/started", "turn-1", { turn: { id: "turn-1" } })).toBe(true);
    expect(held.hold("turn/started", "turn-2", { turn: { id: "turn-2" } })).toBe(true);
    expect(held.hold("turn/completed", "turn-1", { turn: { id: "turn-1" } })).toBe(true);

    expect(held.take("turn-1").map(({ method }) => method)).toEqual([
      "turn/started",
      "turn/completed",
    ]);
    expect(held.take("turn-1")).toEqual([]);
    expect(held.take("turn-2")).toEqual([]);
  });

  it("refuses to hold past the bound instead of evicting turn/started", () => {
    const held = new PreResponseTurnNotifications();
    expect(held.hold("turn/started", "turn-1", {})).toBe(true);
    for (let index = 1; index < MAX_PRE_RESPONSE_TURN_NOTIFICATIONS; index += 1) {
      expect(held.hold("item/agentMessage/delta", "turn-1", { delta: `${index}` })).toBe(true);
    }
    expect(held.hold("turn/completed", "turn-1", {})).toBe(false);

    const replayed = held.take("turn-1");
    expect(replayed).toHaveLength(MAX_PRE_RESPONSE_TURN_NOTIFICATIONS);
    expect(replayed[0]?.method).toBe("turn/started");
  });
});
