import { describe, expect, it } from "vitest";

import {
  createLivePhaseRegistry,
  LIVE_PHASE_PROTOCOL,
  LIVE_PHASE_REMOTE_TTL_MS,
  parseLivePhaseMessage,
  type LivePhaseEnvironment,
  type LivePhaseMessage,
  type LivePhaseRegistry,
} from "../../src/renderer/src/components/working-indicator/liveAgentPhases";
import { activeAgentPhase } from "../../src/renderer/src/utils/response-timeline/active-state";
import { orbMotionForPhase } from "../../src/renderer/src/components/working-indicator/orbMotion";

function network() {
  let now = 10_000;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const members = new Map<string, { listener: ((data: unknown) => void) | null; unload: (() => void) | null; closed: boolean }>();
  const delivered: LivePhaseMessage[] = [];
  const join = (windowId: string): { registry: LivePhaseRegistry; unload: () => void; crash: () => void } => {
    const member = { listener: null as ((data: unknown) => void) | null, unload: null as (() => void) | null, closed: false };
    members.set(windowId, member);
    const environment: LivePhaseEnvironment = {
      now: () => now,
      windowId,
      transport: {
        post: (message) => {
          if (member.closed) return;
          delivered.push(message);
          for (const [id, other] of members) {
            if (id !== windowId && !other.closed) other.listener?.(structuredClone(message));
          }
        },
        listen: (listener) => {
          member.listener = listener;
          return () => { member.listener = null; };
        },
        close: () => { member.closed = true; },
      },
      setTimer: (callback, delayMs) => {
        const handle = nextHandle++;
        timers.set(handle, { at: now + delayMs, callback });
        return handle;
      },
      clearTimer: (handle) => { timers.delete(handle); },
      onUnload: (listener) => {
        member.unload = listener;
        return () => { member.unload = null; };
      },
    };
    const registry = createLivePhaseRegistry(environment);
    return {
      registry,
      unload: () => member.unload?.(),
      crash: () => {
        member.closed = true;
      },
    };
  };
  return {
    join,
    delivered,
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].callback();
      }
      now = target;
    },
  };
}

describe("live agent phase registry", () => {
  it("resolves a local timeline phase for the matching turn only", () => {
    const { join } = network();
    const { registry } = join("main");
    const token = Symbol("timeline");
    registry.publish(token, { conversationId: "c1", turnId: "t1", phase: "searching" });
    expect(registry.resolve("c1", "t1")).toBe("searching");
    expect(registry.resolve("c1", "t0")).toBeNull();
    expect(registry.resolve("c2", "t1")).toBeNull();
    expect(registry.resolve("c1", null)).toBeNull();
  });

  it("moves an unopened chat to its exact phase when opened and back when closed", () => {
    const { join } = network();
    const { registry } = join("main");
    const latestTurn = { status: "running" as const };
    const sidebarPhase = () => registry.resolve("c1", "t1")
      ?? activeAgentPhase({ turn: { agentTurn: latestTurn, activities: [] }, streamingChannel: null });
    expect(sidebarPhase()).toBe("working");
    const token = Symbol("timeline");
    registry.publish(token, { conversationId: "c1", turnId: "t1", phase: "coding" });
    expect(sidebarPhase()).toBe("coding");
    registry.withdraw(token);
    expect(sidebarPhase()).toBe("working");
  });

  it("clears the entry when the turn ends and notifies subscribers", () => {
    const { join } = network();
    const { registry } = join("main");
    let notifications = 0;
    const stop = registry.subscribe(() => { notifications += 1; });
    const token = Symbol("timeline");
    registry.publish(token, { conversationId: "c1", turnId: "t1", phase: "tool" });
    registry.publish(token, { conversationId: "c1", turnId: "t1", phase: "tool" });
    registry.withdraw(token);
    registry.withdraw(token);
    expect(notifications).toBe(2);
    expect(registry.resolve("c1", "t1")).toBeNull();
    stop();
  });

  it("shares phases across windows and clears them when the publisher unloads", () => {
    const net = network();
    const detached = net.join("detached");
    const main = net.join("main");
    const token = Symbol("detached-timeline");
    detached.registry.publish(token, { conversationId: "c1", turnId: "t1", phase: "responding" });
    expect(main.registry.resolve("c1", "t1")).toBe("responding");
    detached.unload();
    expect(main.registry.resolve("c1", "t1")).toBeNull();
    expect(net.delivered.at(-1)?.kind).toBe("bye");
  });

  it("answers a newly opened window with the current phases", () => {
    const net = network();
    const detached = net.join("detached");
    detached.registry.publish(Symbol("timeline"), { conversationId: "c1", turnId: "t1", phase: "delegated" });
    const main = net.join("main");
    expect(main.registry.resolve("c1", "t1")).toBe("delegated");
  });

  it("expires a crashed publisher within about two seconds", () => {
    const net = network();
    const detached = net.join("detached");
    const main = net.join("main");
    detached.registry.publish(Symbol("timeline"), { conversationId: "c1", turnId: "t1", phase: "tool" });
    net.advance(1_500);
    expect(main.registry.resolve("c1", "t1")).toBe("tool");
    detached.crash();
    net.advance(LIVE_PHASE_REMOTE_TTL_MS + 100);
    expect(main.registry.resolve("c1", "t1")).toBeNull();
  });

  it("lets the most recent publish win when two windows show the same chat", () => {
    const net = network();
    const split = net.join("split");
    const detached = net.join("detached");
    const main = net.join("main");
    split.registry.publish(Symbol("split"), { conversationId: "c1", turnId: "t1", phase: "searching" });
    net.advance(10);
    detached.registry.publish(Symbol("detached"), { conversationId: "c1", turnId: "t1", phase: "coding" });
    for (const registry of [split.registry, detached.registry, main.registry]) {
      expect(registry.resolve("c1", "t1")).toBe("coding");
    }
    net.advance(10);
    split.registry.publish(Symbol("split-2"), { conversationId: "c1", turnId: "t1", phase: "tool" });
    for (const registry of [split.registry, detached.registry, main.registry]) {
      expect(registry.resolve("c1", "t1")).toBe("tool");
    }
  });

  it("validates every broadcast message and drops unknown phases safely", () => {
    const valid = {
      protocol: LIVE_PHASE_PROTOCOL,
      version: 1,
      kind: "state",
      windowId: "w1",
      entries: [
        { conversationId: "c1", turnId: "t1", phase: "tool", at: 1 },
        { conversationId: "c2", turnId: "t2", phase: "sparkling", at: 1 },
        { conversationId: "c3", turnId: "t3", phase: "toString", at: 1 },
        { conversationId: "../c4", turnId: "t4", phase: "tool", at: 1 },
        { conversationId: "c5", turnId: "t5", phase: "tool", at: Number.NaN },
      ],
    };
    expect(parseLivePhaseMessage(valid)?.entries).toEqual([
      { conversationId: "c1", turnId: "t1", phase: "tool", at: 1 },
    ]);
    for (const invalid of [
      null,
      "state",
      { ...valid, protocol: "other" },
      { ...valid, version: 2 },
      { ...valid, kind: "shout" },
      { ...valid, windowId: "" },
      { ...valid, entries: "nope" },
      { ...valid, entries: Array.from({ length: 300 }, () => valid.entries[0]) },
    ]) {
      expect(parseLivePhaseMessage(invalid)).toBeNull();
    }
    const { join } = network();
    const { registry } = join("main");
    registry.receive({ ...valid, entries: [{ conversationId: "c2", turnId: "t2", phase: "sparkling", at: 1 }] });
    expect(registry.resolve("c2", "t2")).toBeNull();
    registry.receive({ ...valid, windowId: "main" });
    expect(registry.resolve("c1", "t1")).toBeNull();
  });

  it("gives the sidebar cue and the timeline row the same design and pace for every phase", () => {
    const { join } = network();
    const { registry } = join("main");
    const token = Symbol("timeline");
    for (const phase of [
      "compacting", "queued", "starting", "thinking", "searching", "coding", "command", "tool",
      "responding", "working", "delegated", "retrying", "cancelling",
      "waiting-for-approval", "waiting-for-input",
    ] as const) {
      registry.publish(token, { conversationId: "c1", turnId: "t1", phase });
      const sidebar = orbMotionForPhase(registry.resolve("c1", "t1"));
      expect(sidebar).toEqual(orbMotionForPhase(phase));
    }
  });
});
