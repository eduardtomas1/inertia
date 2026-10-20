import { describe, expect, it } from "vitest";

import {
  groupWorkThreads,
  sidebarThreadViewMap,
  type SidebarInitiative,
  type SidebarThreadView,
} from "../../src/renderer/src/utils/sidebarModel";
import {
  groupWorkThreadsWithInitiatives,
  initiativeAggregate,
  initiativeWorkSectionId,
  isInitiativeWorkSectionId,
} from "../../src/renderer/src/utils/sidebarInitiatives";
import {
  expandedWorkSections,
  isCollapsibleWorkSection,
  parseWorkSectionPreferences,
  serializeWorkSectionPreferences,
  toggleWorkSectionPreference,
} from "../../src/renderer/src/utils/sidebarWorkSections";
import type { Conversation, WorkspaceRun } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

const NOW = new Date(2026, 9, 19, 12).getTime();
const TODAY = new Date(2026, 9, 19, 10).toISOString();
const EARLIER = new Date(2026, 9, 10, 10).toISOString();
const TOMORROW = new Date(2026, 9, 20, 9).toISOString();
const ALPHA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BETA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GAMMA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function conversation(overrides: Partial<Conversation> & Pick<Conversation, "id">): Conversation {
  return {
    projectId: "project",
    title: overrides.id,
    providerId: "codex",
    model: "",
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    status: "idle",
    attentionKind: null,
    branch: null,
    worktreePath: null,
    providerSessionId: null,
    archivedAt: null,
    settledAt: null,
    completedAt: null,
    lastViewedAt: TODAY,
    initiativeId: null,
    createdAt: TODAY,
    updatedAt: TODAY,
    ...overrides,
    modelSelection: providerNativeModelSelection({ providerId: "codex" }),
    continuationIdentity: null,
  };
}

function initiative(id: string, overrides: Partial<SidebarInitiative> = {}): SidebarInitiative {
  return { id, name: `Initiative ${id.slice(0, 4)}`, color: "teal", status: "active", createdAt: TODAY, ...overrides };
}

function views(conversations: Conversation[], runs: WorkspaceRun[] = []): SidebarThreadView[] {
  const map = sidebarThreadViewMap(conversations, null, runs);
  return conversations.map(({ id }) => map.get(id)!);
}

function ids(sections: ReturnType<typeof groupWorkThreads>) {
  return sections.filter(({ threads }) => threads.length > 0)
    .map(({ id, threads }) => [id, threads.map(({ conversation: { id: threadId } }) => threadId)]);
}

describe("initiative Work sections", () => {
  it("leaves the date sections untouched when there are no initiatives", () => {
    const threads = views([
      conversation({ id: "today" }),
      conversation({ id: "earlier", updatedAt: EARLIER }),
      conversation({ id: "orphan", initiativeId: ALPHA }),
    ]);
    expect(groupWorkThreadsWithInitiatives(threads, [], NOW)).toEqual(groupWorkThreads(threads, NOW));
  });

  it("puts active initiatives above Recent, done ones after Earlier and archived members in date sections", () => {
    const threads = views([
      conversation({ id: "plain" }),
      conversation({ id: "old", updatedAt: EARLIER }),
      conversation({ id: "alpha-1", initiativeId: ALPHA, updatedAt: EARLIER }),
      conversation({ id: "alpha-2", initiativeId: ALPHA, status: "running" }),
      conversation({ id: "beta-1", initiativeId: BETA }),
      conversation({ id: "gamma-1", initiativeId: GAMMA }),
      conversation({ id: "settled", settledAt: TODAY }),
    ]);
    const sections = groupWorkThreadsWithInitiatives(threads, [
      initiative(GAMMA, { status: "archived" }),
      initiative(BETA, { status: "done", createdAt: EARLIER }),
      initiative(ALPHA),
    ], NOW);
    expect(ids(sections)).toEqual([
      [initiativeWorkSectionId(ALPHA), ["alpha-2", "alpha-1"]],
      ["recent", ["plain", "gamma-1"]],
      ["earlier", ["old"]],
      [initiativeWorkSectionId(BETA), ["beta-1"]],
      ["done", ["settled"]],
    ]);
    expect(sections.find(({ id }) => id === initiativeWorkSectionId(ALPHA))).toMatchObject({
      label: "Initiative aaaa",
      initiative: { id: ALPHA, status: "active" },
    });
  });

  it("orders active initiatives by creation and omits sections without visible members", () => {
    const threads = views([
      conversation({ id: "beta-1", initiativeId: BETA }),
      conversation({ id: "alpha-1", initiativeId: ALPHA }),
    ]);
    const sections = groupWorkThreadsWithInitiatives(threads, [
      initiative(ALPHA, { createdAt: TODAY }),
      initiative(BETA, { createdAt: EARLIER }),
      initiative(GAMMA),
    ], NOW);
    expect(sections.filter(({ initiative: owner }) => owner).map(({ id }) => id))
      .toEqual([initiativeWorkSectionId(BETA), initiativeWorkSectionId(ALPHA)]);
    // A project filter that hides every member hides the section too.
    expect(groupWorkThreadsWithInitiatives([], [initiative(ALPHA)], NOW).some(({ initiative: owner }) => owner))
      .toBe(false);
  });

  it("keeps member chats without a project inside their initiative", () => {
    const threads = views([
      conversation({ id: "free-member", projectId: "scratch", initiativeId: ALPHA }),
      conversation({ id: "free", projectId: "scratch" }),
      conversation({ id: "project" }),
    ]);
    const sections = groupWorkThreadsWithInitiatives(threads, [initiative(ALPHA)], NOW, new Set(["scratch"]));
    expect(ids(sections)).toEqual([
      [initiativeWorkSectionId(ALPHA), ["free-member"]],
      ["recent", ["project"]],
      ["no-project", ["free"]],
    ]);
  });

  it("lets a chat whose initiative is unknown fall through to the date sections", () => {
    const threads = views([
      conversation({ id: "alpha-1", initiativeId: ALPHA }),
      conversation({ id: "unknown", initiativeId: GAMMA }),
      conversation({ id: "unknown-old", initiativeId: GAMMA, updatedAt: EARLIER }),
    ]);
    expect(ids(groupWorkThreadsWithInitiatives(threads, [initiative(ALPHA)], NOW))).toEqual([
      [initiativeWorkSectionId(ALPHA), ["alpha-1"]],
      ["recent", ["unknown"]],
      ["earlier", ["unknown-old"]],
    ]);
  });

  it("sends snoozed and settled members of an active initiative to Snoozed and Done, as without one", () => {
    const threads = views([
      conversation({ id: "active-member", initiativeId: ALPHA }),
      conversation({ id: "snoozed-member", initiativeId: ALPHA, snoozedUntil: TOMORROW }),
      conversation({ id: "settled-member", initiativeId: ALPHA, settledAt: TODAY }),
      // A snoozed chat that needs the user is not ordinarily snoozed, with or without an initiative.
      conversation({ id: "snoozed-waiting", initiativeId: ALPHA, snoozedUntil: TOMORROW, status: "failed" }),
      conversation({ id: "plain-snoozed", snoozedUntil: TOMORROW }),
      conversation({ id: "plain-settled", settledAt: TODAY }),
      conversation({ id: "free-settled", projectId: "scratch", initiativeId: ALPHA, settledAt: TODAY }),
      conversation({ id: "free-snoozed", projectId: "scratch", initiativeId: ALPHA, snoozedUntil: TOMORROW }),
    ]);
    const sections = groupWorkThreadsWithInitiatives(threads, [initiative(ALPHA)], NOW, new Set(["scratch"]));
    expect(ids(sections)).toEqual([
      [initiativeWorkSectionId(ALPHA), ["snoozed-waiting", "active-member"]],
      ["done", ["settled-member", "plain-settled"]],
      ["snoozed", ["snoozed-member", "plain-snoozed"]],
      ["no-project-done", ["free-settled"]],
      ["no-project-snoozed", ["free-snoozed"]],
    ]);
    // Membership does not move a chat anywhere it would not go without one.
    const withoutMembership = views(threads.map(({ conversation: chat }) => ({ ...chat, initiativeId: null })));
    const ordinary = ids(groupWorkThreads(withoutMembership, NOW, new Set(["scratch"])));
    for (const [sectionId, members] of ids(sections).slice(1)) {
      expect(ordinary).toContainEqual([sectionId, members]);
    }
  });

  it("lists every non-hidden member, snoozed and settled ones included, in a done initiative's section", () => {
    const threads = views([
      conversation({ id: "active-member", initiativeId: BETA }),
      conversation({ id: "snoozed-member", initiativeId: BETA, snoozedUntil: TOMORROW }),
      conversation({ id: "settled-member", initiativeId: BETA, settledAt: TODAY }),
      conversation({ id: "plain" }),
    ]);
    const sections = groupWorkThreadsWithInitiatives(threads, [initiative(BETA, { status: "done" })], NOW);
    expect(ids(sections)).toEqual([
      ["recent", ["plain"]],
      [initiativeWorkSectionId(BETA), ["active-member", "snoozed-member", "settled-member"]],
    ]);
  });

  it("does not show dismissed member chats", () => {
    const member = conversation({ id: "dismissed", initiativeId: ALPHA, status: "failed" });
    const threads = views([member], [{
      id: "run", kind: "agent", projectId: "project", conversationId: member.id, actionId: null, label: "run",
      detail: null, status: "failed", attentionState: "dismissed", canStop: false, port: null,
      startedAt: TODAY, finishedAt: TODAY,
    }]);
    expect(groupWorkThreadsWithInitiatives(threads, [initiative(ALPHA)], NOW).some(({ threads: list }) => list.length > 0))
      .toBe(false);
  });

  it("aggregates member status with approval first and counts waiting and working chats", () => {
    const aggregate = (conversations: Conversation[]) => initiativeAggregate(views(conversations));
    expect(aggregate([])).toEqual({ status: "idle", attentionCount: 0, workingCount: 0 });
    expect(aggregate([
      conversation({ id: "idle" }),
      conversation({ id: "done", status: "completed" }),
    ])).toEqual({ status: "completed", attentionCount: 0, workingCount: 0 });
    expect(aggregate([
      conversation({ id: "working", status: "running" }),
      conversation({ id: "done", status: "completed" }),
    ])).toEqual({ status: "working", attentionCount: 0, workingCount: 1 });
    expect(aggregate([
      conversation({ id: "working", status: "running" }),
      conversation({ id: "failed", status: "failed" }),
    ])).toEqual({ status: "failed", attentionCount: 1, workingCount: 1 });
    expect(aggregate([
      conversation({ id: "failed", status: "failed" }),
      conversation({ id: "input", status: "needs-input", attentionKind: "input" }),
    ])).toMatchObject({ status: "input", attentionCount: 2 });
    expect(aggregate([
      conversation({ id: "input", status: "needs-input", attentionKind: "input" }),
      conversation({ id: "approval", status: "needs-input", attentionKind: "approval" }),
      conversation({ id: "working", status: "running" }),
    ])).toEqual({ status: "approval", attentionCount: 2, workingCount: 1 });
  });

  it("stops counting a failed member once the user settles it", () => {
    const aggregate = (conversations: Conversation[]) => initiativeAggregate(views(conversations));
    expect(aggregate([
      conversation({ id: "failed", status: "failed", settledAt: TODAY }),
      conversation({ id: "done", status: "completed" }),
    ])).toEqual({ status: "completed", attentionCount: 0, workingCount: 0 });
    expect(aggregate([
      conversation({ id: "settled-failed", status: "failed", settledAt: TODAY }),
      conversation({ id: "open-input", status: "needs-input", attentionKind: "input" }),
    ])).toEqual({ status: "input", attentionCount: 1, workingCount: 0 });
    expect(aggregate([conversation({ id: "settled-failed", status: "failed", settledAt: TODAY })]))
      .toEqual({ status: "idle", attentionCount: 0, workingCount: 0 });
  });
});

describe("Work section disclosure preferences", () => {
  const active = { id: initiativeWorkSectionId(ALPHA), initiative: initiative(ALPHA) };
  const done = { id: initiativeWorkSectionId(BETA), initiative: initiative(BETA, { status: "done" }) };

  it("recognises dynamic initiative sections as collapsible", () => {
    expect(isInitiativeWorkSectionId(initiativeWorkSectionId(ALPHA))).toBe(true);
    expect(isInitiativeWorkSectionId("initiative:")).toBe(false);
    expect(isInitiativeWorkSectionId("recent")).toBe(false);
    expect(isCollapsibleWorkSection(initiativeWorkSectionId(ALPHA))).toBe(true);
    expect(isCollapsibleWorkSection("done")).toBe(true);
    expect(isCollapsibleWorkSection("recent")).toBe(false);
  });

  it("expands active initiatives and collapses done ones by default, then remembers explicit choices", () => {
    let preferences = parseWorkSectionPreferences("earlier");
    expect([...expandedWorkSections(preferences, [active, done])].sort())
      .toEqual(["earlier", active.id].sort());
    preferences = toggleWorkSectionPreference(preferences, active);
    preferences = toggleWorkSectionPreference(preferences, done);
    expect([...expandedWorkSections(preferences, [active, done])].sort()).toEqual(["earlier", done.id].sort());
    const stored = serializeWorkSectionPreferences(preferences);
    expect(stored.split(",").sort()).toEqual(["earlier", `initiative-collapsed:${ALPHA}`, `initiative:${BETA}`].sort());
    const reloaded = parseWorkSectionPreferences(stored);
    expect([...expandedWorkSections(reloaded, [active, done])].sort()).toEqual(["earlier", done.id].sort());
    expect([...expandedWorkSections(toggleWorkSectionPreference(reloaded, active), [active, done])])
      .toContain(active.id);
  });

  it("ignores corrupt tokens and prunes initiatives that no longer exist", () => {
    const preferences = parseWorkSectionPreferences(
      `recent,unknown,earlier,initiative:not-a-uuid,initiative:${ALPHA},initiative-collapsed:${BETA},${"x".repeat(40)}`,
    );
    expect([...preferences]).toEqual(["earlier", `initiative:${ALPHA}`, `initiative-collapsed:${BETA}`]);
    expect(serializeWorkSectionPreferences(preferences, new Set([BETA])))
      .toBe(`earlier,initiative-collapsed:${BETA}`);
    expect(parseWorkSectionPreferences(null).size).toBe(0);
  });
});
