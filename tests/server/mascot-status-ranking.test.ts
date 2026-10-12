import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationShell } from "../../src/shared/contracts/app";
import { AGENT_RUN_STATES, agentTurnStatusForRunState, type AgentRunState } from "../../src/shared/run-state";
import { keepBest, MascotStatusPublisher } from "../../src/server/runtime/mascot-status";
import { MASCOT_CHAT_LIMIT, MASCOT_ROW_LIMIT } from "../../src/shared/mascot";
import { parseRuntimeWorkerEvent } from "../../src/node/runtime-process-protocol";
import { mascotFeedViolation, type MascotFeed } from "../../src/shared/mascot-feed";
import { MASCOT_FIXTURE_NOW, mascotTestClock } from "../helpers/mascot-fixture";

const TERMINAL: readonly AgentRunState[] = ["completed", "failed", "cancelled", "interrupted"];
const TIMES = ["2026-09-06T09:00:00.000Z", "2026-09-06T10:00:00.000Z", "2026-09-06T11:00:00.000Z"];
const LIFETIME: Record<number, number> = { 4: 24 * 3_600_000, 3: 3_600_000, 2: 7 * 24 * 3_600_000 };
let turns = 0;

afterEach(() => { vi.restoreAllMocks(); });

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function shell(id: string, state: AgentRunState, times: { requested: string; updated: string; viewed: string | null }, archived = false): ConversationShell {
  turns += 1;
  return {
    id, projectId: "project", title: `Chat ${id}`, status: "idle",
    archivedAt: archived ? "2026-09-06T12:00:00.000Z" : null, lastViewedAt: times.viewed,
    latestTurn: {
      id: `${id}-turn-${turns}`, runId: `${id}-run`, status: agentTurnStatusForRunState(state),
      runState: { state, revision: 1, providerState: null },
      completedAt: TERMINAL.includes(state) ? times.updated : null,
      requestedAt: times.requested, updatedAt: times.updated,
    },
  } as ConversationShell;
}

function createPublisher(publish: (feed: MascotFeed) => void): MascotStatusPublisher {
  return new MascotStatusPublisher(publish, undefined, undefined, (task) => task(), mascotTestClock());
}

function tierOf(state: AgentRunState, seen: boolean, changed: string): number {
  const tier = state.startsWith("waiting-") ? 4 : state === "failed" || state === "interrupted" ? 3 : state === "completed" ? 2
    : TERMINAL.includes(state) ? 0 : 1;
  if (tier === 1) return 1;
  if (tier === 0 || (tier < 4 && seen)) return 0;
  return MASCOT_FIXTURE_NOW - Date.parse(changed) < LIFETIME[tier]! ? tier : 0;
}

function reference(shells: Iterable<ConversationShell>, focus: string | null, previous: { shown: string | null } = { shown: null }) {
  const entries = [...shells].filter((entry) => !entry.archivedAt && entry.latestTurn).map((entry) => {
    const turn = entry.latestTurn!;
    const state = turn.runState!.state;
    const terminal = TERMINAL.includes(state);
    const seen = terminal && (!turn.completedAt || (entry.lastViewedAt ?? "") >= turn.completedAt);
    return {
      id: entry.id, state, active: terminal ? 0 : 1,
      tier: tierOf(state, seen, terminal ? turn.completedAt ?? turn.updatedAt : turn.updatedAt),
      at: terminal ? turn.updatedAt : turn.requestedAt,
    };
  });
  const ranked = [...entries].sort((left, right) => right.tier - left.tier
    || (left.at === right.at ? 0 : left.at > right.at ? -1 : 1) || (left.id < right.id ? -1 : 1));
  const eligible = ranked.filter(({ tier }) => tier > 0);
  const before = entries.find(({ id }) => id === previous.shown);
  const shown = before && before.tier > 0 && (!eligible[0] || eligible[0].tier <= before.tier) ? before : eligible[0];
  previous.shown = shown?.id ?? null;
  const listed = ranked.slice(0, MASCOT_CHAT_LIMIT);
  if (shown && listed[0] !== shown) {
    const index = listed.indexOf(shown);
    listed.splice(index < 0 ? MASCOT_CHAT_LIMIT - 1 : index, 1);
    listed.unshift(shown);
  }
  const focused = entries.find(({ id }) => id === focus);
  if (focused && !listed.includes(focused)) listed.splice(MASCOT_CHAT_LIMIT - 1, 1, focused);
  const excluded = focused ?? shown;
  return {
    status: shown?.id ?? null,
    chats: listed.map(({ id, state }) => `${id}:${state}`),
    rows: eligible.filter((entry) => entry !== excluded).slice(0, MASCOT_ROW_LIMIT).map(({ id, state }) => `${id}:${state}`),
    focus: focused ? focus : null,
    counts: {
      chats: entries.length, attention: entries.filter(({ tier }) => tier === 4).length,
      others: eligible.length - Number(Boolean(excluded && excluded.tier > 0)),
    },
    activeCount: entries.reduce((total, { active }) => total + active, 0),
  };
}

function observed({ status, chats, rows, focus, counts }: MascotFeed) {
  return {
    status: status.conversationId,
    chats: chats.map(({ conversationId, phase }) => `${conversationId}:${phase}`),
    rows: rows.map(({ conversationId, phase }) => `${conversationId}:${phase}`),
    focus, counts,
    activeCount: status.activeCount,
  };
}

function expectParsable(feed: MascotFeed): void {
  const event = { type: "runtime.mascot-status", ...feed };
  expect(mascotFeedViolation(feed)).toBeNull();
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
    const publish = vi.fn<(feed: MascotFeed) => void>();
    const publisher = createPublisher(publish);
    const history = Array.from({ length: 4_990 }, (_, index) => shell(`seen-${String(index).padStart(4, "0")}`, "completed",
      { requested: TIMES[0]!, updated: TIMES[index % 2]!, viewed: TIMES[2]! }));
    const live = Array.from({ length: 10 }, (_, index) => shell(`live-${index}`, "running", { requested: TIMES[index % 3]!, updated: TIMES[0]!, viewed: null }));
    publisher.replace([...history, ...live]);
    const sort = vi.spyOn(Array.prototype, "sort");
    const from = vi.spyOn(Array, "from");
    publisher.update(shell("live-3", "waiting-for-input", { requested: TIMES[1]!, updated: TIMES[1]!, viewed: null }));
    expect(sort.mock.contexts.every((context) => (context as unknown[]).length <= MASCOT_CHAT_LIMIT)).toBe(true);
    expect(from).not.toHaveBeenCalled();
    const published = publish.mock.lastCall![0];
    expectParsable(published);
    expect(observed(published)).toEqual(reference([...history, ...live.map((entry) => entry.id === "live-3"
      ? shell("live-3", "waiting-for-input", { requested: TIMES[1]!, updated: TIMES[1]!, viewed: null }) : entry)], null));
    expect(published.counts).toEqual({ chats: 5_000, attention: 1, others: 9 });
  });

  it("matches a full-sort reference and always satisfies the boundary parser", () => {
    const next = random(516);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
    for (let round = 0; round < 40; round += 1) {
      const publish = vi.fn<(feed: MascotFeed) => void>();
      const publisher = createPublisher(publish);
      const shells = new Map<string, ConversationShell>();
      const make = (id: string): ConversationShell => shell(id, pick(AGENT_RUN_STATES), {
        requested: pick(TIMES), updated: pick(TIMES), viewed: pick([null, TIMES[0]!, TIMES[2]!]),
      }, next() < 0.1);
      for (let index = 0; index < 5 + Math.floor(next() * 40); index += 1) shells.set(`c${index}`, make(`c${index}`));
      let focus: string | null = null;
      let request = 0;
      const listable = (id: string | null): boolean => id !== null && shells.has(id) && !shells.get(id)!.archivedAt;
      const previous = { shown: null as string | null };
      publisher.replace([...shells.values()]);
      reference(shells.values(), null, previous);
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
        const published = publish.mock.lastCall![0];
        expectParsable(published);
        expect(published.request).toBe(request || null);
        expect(observed(published)).toEqual(reference(shells.values(), focus, previous));
      }
    }
  });

  it("emits only feeds the boundary accepts for empty, settled, urgent, oversized and pinned edge cases", () => {
    const at: { requested: string; updated: string; viewed: string | null } = { requested: TIMES[0]!, updated: TIMES[1]!, viewed: null };
    const seen = { ...at, viewed: TIMES[2]! };
    const many = (prefix: string, state: AgentRunState, count: number, times = at): ConversationShell[] =>
      Array.from({ length: count }, (_, index) => shell(`${prefix}-${String(index).padStart(2, "0")}`, state, times));
    const cases: Array<[string, ConversationShell[], string | null]> = [
      ["none", [], null],
      ["all settled and seen", [...many("done", "completed", 5, seen), ...many("failed", "failed", 5, seen)], null],
      ["all settled and unseen", [...many("done", "completed", 4), ...many("stopped", "interrupted", 7)], null],
      ["all need you", [...many("input", "waiting-for-input", 7), ...many("approval", "waiting-for-approval", 7)], null],
      ["more than the cap", [...many("run", "running", 12), ...many("done", "completed", 12, seen)], null],
      ["pinned settled chat", [...many("input", "waiting-for-input", 12), shell("pinned", "completed", seen)], "pinned"],
      ["pinned chat that needs you", [...many("run", "running", 12), shell("pinned", "waiting-for-approval", at)], "pinned"],
      ["archived pin", [...many("run", "running", 3), shell("pinned", "completed", seen, true)], "pinned"],
    ];
    for (const [, shells, pinned] of cases) {
      const publish = vi.fn<(feed: MascotFeed) => void>();
      const publisher = createPublisher(publish);
      publisher.replace(shells);
      if (pinned) publisher.focus(pinned, 1);
      for (const [published] of publish.mock.calls) expectParsable(published);
      expect(observed(publish.mock.lastCall![0])).toEqual(reference(shells, pinned && shells.some(({ id, archivedAt }) => id === pinned && !archivedAt) ? pinned : null));
    }
  });

  it("breaks rank ties the same way whatever the input order", () => {
    const entries = Array.from({ length: 20 }, (_, index) => shell(`tie-${String(index).padStart(2, "0")}`, "running",
      { requested: TIMES[0]!, updated: TIMES[0]!, viewed: null }));
    const lists = [entries, [...entries].reverse(), [...entries.slice(10), ...entries.slice(0, 10)]].map((order) => {
      const publish = vi.fn<(feed: MascotFeed) => void>();
      createPublisher(publish).replace(order);
      return publish.mock.lastCall![0].chats.map(({ conversationId }) => conversationId);
    });
    expect(lists[0]).toEqual(entries.slice(0, MASCOT_CHAT_LIMIT).map(({ id }) => id));
    expect(lists[1]).toEqual(lists[0]);
    expect(lists[2]).toEqual(lists[0]);
  });

  it("computes and publishes once for a burst of updates in one tick", async () => {
    const publish = vi.fn<(feed: MascotFeed) => void>();
    const publisher = new MascotStatusPublisher(publish);
    const entries = Array.from({ length: 30 }, (_, index) => shell(`burst-${index}`, "running", { requested: TIMES[0]!, updated: TIMES[0]!, viewed: null }));
    publisher.replace(entries);
    for (const entry of entries) publisher.update({ ...entry, title: `Renamed ${entry.id}` });
    publisher.focus("burst-29", 1);
    expect(publish).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.lastCall![0].focus).toBe("burst-29");
    expect(publish.mock.lastCall![0].chats.at(-1)).toMatchObject({ conversationId: "burst-29", chatTitle: "Renamed burst-29" });
  });
});
