import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationShell } from "../../src/shared/contracts/app";
import { AGENT_RUN_STATES, agentTurnStatusForRunState, type AgentRunState } from "../../src/shared/run-state";
import { keepBest, MascotStatusPublisher } from "../../src/server/runtime/mascot-status";
import { MASCOT_CHAT_LIMIT, type MascotCounts, type MascotStatus } from "../../src/shared/mascot";
import { parseRuntimeWorkerEvent } from "../../src/node/runtime-process-protocol";

type Published = [MascotStatus, MascotStatus[], string | null, MascotCounts, number | null];

const TERMINAL: readonly AgentRunState[] = ["completed", "failed", "cancelled", "interrupted"];
const TIMES = ["2026-09-06T09:00:00.000Z", "2026-09-06T10:00:00.000Z", "2026-09-06T11:00:00.000Z"];

afterEach(() => { vi.restoreAllMocks(); });

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function shell(id: string, state: AgentRunState, times: { requested: string; updated: string; viewed: string | null }, archived = false): ConversationShell {
  return {
    id, projectId: "project", title: `Chat ${id}`, status: "idle",
    archivedAt: archived ? "2026-09-06T12:00:00.000Z" : null, lastViewedAt: times.viewed,
    latestTurn: {
      id: `${id}-turn`, runId: `${id}-run`, status: agentTurnStatusForRunState(state),
      runState: { state, revision: 1, providerState: null },
      completedAt: TERMINAL.includes(state) ? times.updated : null,
      requestedAt: times.requested, updatedAt: times.updated,
    },
  } as ConversationShell;
}

function reference(shells: Iterable<ConversationShell>, focus: string | null) {
  const entries = [...shells].filter((entry) => !entry.archivedAt && entry.latestTurn).map((entry) => {
    const turn = entry.latestTurn!;
    const state = turn.runState!.state;
    const terminal = TERMINAL.includes(state);
    const priority = state.startsWith("waiting-") ? 4 : !terminal ? 3 : state === "failed" || state === "interrupted" ? 2 : 1;
    return {
      id: entry.id, state, priority, active: terminal ? 0 : 1,
      seen: terminal && (!turn.completedAt || (entry.lastViewedAt ?? "") >= turn.completedAt),
      at: terminal ? turn.updatedAt : turn.requestedAt,
    };
  });
  const ranked = [...entries].sort((left, right) => (left.seen === right.seen ? 0 : left.seen ? 1 : -1)
    || right.priority - left.priority || (left.at === right.at ? 0 : left.at > right.at ? -1 : 1) || (left.id < right.id ? -1 : 1));
  const listed = ranked.slice(0, MASCOT_CHAT_LIMIT);
  const focused = entries.find(({ id }) => id === focus);
  if (focused && !listed.includes(focused)) listed.splice(MASCOT_CHAT_LIMIT - 1, 1, focused);
  return {
    status: ranked[0] && !ranked[0].seen ? ranked[0].id : null,
    chats: listed.map(({ id, state }) => `${id}:${state}`),
    focus: focused ? focus : null,
    counts: { chats: entries.length, attention: entries.filter(({ priority }) => priority === 4).length },
    activeCount: entries.reduce((total, { active }) => total + active, 0),
  };
}

function observed([status, chats, focus, counts]: Published) {
  return {
    status: status.conversationId,
    chats: chats.map(({ conversationId, phase }) => `${conversationId}:${phase}`),
    focus, counts,
    activeCount: status.activeCount,
  };
}

function expectParsable([status, chats, focus, counts, request]: Published): void {
  const event = { type: "runtime.mascot-status", status, chats, focus, counts, request };
  expect(parseRuntimeWorkerEvent(event)).toEqual(event);
}

describe("bounded mascot ranking", () => {
  it("keeps the best entries in one pass with at most limit + 1 comparisons per entry", () => {
    const next = random(7);
    const values = Array.from({ length: 5_000 }, () => Math.floor(next() * 1_000));
    let comparisons = 0;
    const best: number[] = [];
    for (const value of values) keepBest(best, value, MASCOT_CHAT_LIMIT, (left, right) => { comparisons += 1; return left - right; });
    expect(best).toEqual([...values].sort((left, right) => left - right).slice(0, MASCOT_CHAT_LIMIT));
    expect(comparisons).toBeLessThanOrEqual(values.length * (MASCOT_CHAT_LIMIT + 1));
    expect(comparisons).toBeLessThan(values.length * 2);
  });

  it("updates a 5,000-chat history without sorting or copying the full set", () => {
    const publish = vi.fn<(...args: Published) => void>();
    const publisher = new MascotStatusPublisher(publish, undefined, undefined, (task) => task());
    const history = Array.from({ length: 4_990 }, (_, index) => shell(`seen-${String(index).padStart(4, "0")}`, "completed",
      { requested: TIMES[0]!, updated: TIMES[index % 2]!, viewed: TIMES[2]! }));
    const live = Array.from({ length: 10 }, (_, index) => shell(`live-${index}`, "running", { requested: TIMES[index % 3]!, updated: TIMES[0]!, viewed: null }));
    publisher.replace([...history, ...live]);
    const sort = vi.spyOn(Array.prototype, "sort");
    const from = vi.spyOn(Array, "from");
    publisher.update(shell("live-3", "waiting-for-input", { requested: TIMES[1]!, updated: TIMES[1]!, viewed: null }));
    expect(sort.mock.contexts.every((context) => (context as unknown[]).length <= MASCOT_CHAT_LIMIT)).toBe(true);
    expect(from).not.toHaveBeenCalled();
    const published = publish.mock.lastCall!;
    expectParsable(published);
    expect(observed(published)).toEqual(reference([...history, ...live.map((entry) => entry.id === "live-3"
      ? shell("live-3", "waiting-for-input", { requested: TIMES[1]!, updated: TIMES[1]!, viewed: null }) : entry)], null));
    expect(published[3]).toEqual({ chats: 5_000, attention: 1 });
  });

  it("matches a full-sort reference and always satisfies the boundary parser", () => {
    const next = random(516);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
    for (let round = 0; round < 40; round += 1) {
      const publish = vi.fn<(...args: Published) => void>();
      const publisher = new MascotStatusPublisher(publish, undefined, undefined, (task) => task());
      const shells = new Map<string, ConversationShell>();
      const make = (id: string): ConversationShell => shell(id, pick(AGENT_RUN_STATES), {
        requested: pick(TIMES), updated: pick(TIMES), viewed: pick([null, TIMES[0]!, TIMES[2]!]),
      }, next() < 0.1);
      for (let index = 0; index < 5 + Math.floor(next() * 40); index += 1) shells.set(`c${index}`, make(`c${index}`));
      let focus: string | null = null;
      let request = 0;
      const listable = (id: string | null): boolean => id !== null && shells.has(id) && !shells.get(id)!.archivedAt;
      publisher.replace([...shells.values()]);
      for (let step = 0; step < 12; step += 1) {
        const action = next();
        if (action < 0.3) {
          const chosen = pick([null, "missing", ...shells.keys()]);
          request += 1;
          publisher.focus(chosen, request);
          focus = listable(chosen) ? chosen : null;
        } else if (action < 0.8) {
          const id = pick([...shells.keys(), `c${shells.size + step}`]);
          shells.set(id, make(id));
          publisher.update(shells.get(id)!);
        } else {
          const id = pick([...shells.keys()]);
          shells.delete(id);
          publisher.replace([...shells.values()]);
        }
        if (!listable(focus)) focus = null;
        const published = publish.mock.lastCall!;
        expectParsable(published);
        expect(published[4]).toBe(request || null);
        expect(observed(published)).toEqual(reference(shells.values(), focus));
      }
    }
  });

  it("breaks rank ties the same way whatever the input order", () => {
    const entries = Array.from({ length: 20 }, (_, index) => shell(`tie-${String(index).padStart(2, "0")}`, "running",
      { requested: TIMES[0]!, updated: TIMES[0]!, viewed: null }));
    const lists = [entries, [...entries].reverse(), [...entries.slice(10), ...entries.slice(0, 10)]].map((order) => {
      const publish = vi.fn<(...args: Published) => void>();
      new MascotStatusPublisher(publish, undefined, undefined, (task) => task()).replace(order);
      return publish.mock.lastCall![1].map(({ conversationId }) => conversationId);
    });
    expect(lists[0]).toEqual(entries.slice(0, MASCOT_CHAT_LIMIT).map(({ id }) => id));
    expect(lists[1]).toEqual(lists[0]);
    expect(lists[2]).toEqual(lists[0]);
  });

  it("computes and publishes once for a burst of updates in one tick", async () => {
    const publish = vi.fn<(...args: Published) => void>();
    const publisher = new MascotStatusPublisher(publish);
    const entries = Array.from({ length: 30 }, (_, index) => shell(`burst-${index}`, "running", { requested: TIMES[0]!, updated: TIMES[0]!, viewed: null }));
    publisher.replace(entries);
    for (const entry of entries) publisher.update({ ...entry, title: `Renamed ${entry.id}` });
    publisher.focus("burst-29", 1);
    expect(publish).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.lastCall![2]).toBe("burst-29");
    expect(publish.mock.lastCall![1].at(-1)).toMatchObject({ conversationId: "burst-29", chatTitle: "Renamed burst-29" });
  });
});
