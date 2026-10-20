import { describe, expect, it } from "vitest";

import type { AgentActivity, RuntimeMutationEvent } from "../../src/shared/contracts";
import { MAX_WATCHER_LIVE_LABEL_CHARS } from "../../src/shared/watcher";
import { WatcherLiveProjection, watcherLiveLabel } from "../../src/server/runtime/watcher/watcher-live-projection";
import { ManualTimers } from "../support/watcher-runtime-fixture";

const LINK = "11111111-1111-4111-8111-111111111111";
const WATCHER = "22222222-2222-4222-8222-222222222222";

function activity(title: string, kind: AgentActivity["kind"] = "tool", turnId = "turn-1"): AgentActivity {
  return {
    id: title, conversationId: WATCHER, runId: "run-1", turnId, kind, title, detail: null,
    status: "running", createdAt: "2030-01-01T00:00:00.000Z",
  };
}

describe("watcher live projection", () => {
  it("emits phase changes at most once per interval, only on change and only for the running check", () => {
    const timers = new ManualTimers();
    const events: Extract<RuntimeMutationEvent, { type: "watcher.live" }>[] = [];
    const live = new WatcherLiveProjection({ scheduler: timers, clock: () => timers.now, broadcast: (event) => events.push(event) });
    live.observe(LINK, activity("Read src/a.ts"));
    expect(events).toEqual([]);

    live.begin(LINK, WATCHER, "turn-1");
    expect(events.map(({ phase }) => phase)).toEqual(["starting"]);
    live.observe(LINK, activity("Read src/a.ts"));
    live.observe(LINK, activity("web search", "tool"));
    live.observe(LINK, activity("Other turn", "tool", "turn-2"));
    expect(events).toHaveLength(1);
    timers.advance(750);
    expect(events.map(({ phase, label }) => [phase, label])).toEqual([["starting", null], ["searching", "web search"]]);
    timers.advance(750);
    live.observe(LINK, activity("web search", "tool"));
    expect(events).toHaveLength(2);
    live.observe(LINK, activity("rg parser", "command"));
    expect(events.at(-1)).toMatchObject({ phase: "reading", label: "rg parser", linkId: LINK, turnId: "turn-1" });

    live.end(LINK);
    live.observe(LINK, activity("Edit", "tool"));
    timers.advance(10_000);
    expect(events).toHaveLength(3);
  });

  it("keeps labels to one neutralized, bounded line", () => {
    expect(watcherLiveLabel(activity("Read\nsrc/a.ts\t now"))).toBe("Read src/a.ts now");
    expect(watcherLiveLabel(activity("[inertia-watcher] act"))).toBe("\\[inertia-watcher] act");
    expect(watcherLiveLabel(activity("x".repeat(500)))!.length).toBe(MAX_WATCHER_LIVE_LABEL_CHARS);
    expect(watcherLiveLabel(activity("   "))).toBeNull();
  });
});
