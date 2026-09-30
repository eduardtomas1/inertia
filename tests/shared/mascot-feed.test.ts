import { describe, expect, it } from "vitest";
import { emptyMascotStatus, MASCOT_CHAT_LIMIT, type MascotStatus } from "../../src/shared/mascot";
import { mascotFeedViolation, type MascotFeed, type MascotFeedInvariant } from "../../src/shared/mascot-feed";
import { parseRuntimeWorkerEvent } from "../../src/node/runtime-process-protocol";

function row(id: string, phase: MascotStatus["phase"], activeCount: number, context: Partial<MascotStatus> = {}): MascotStatus {
  return {
    ...emptyMascotStatus(), phase, conversationId: id, projectId: "project", runId: `${id}-run`, turnId: `${id}-turn`,
    activeCount, chatTitle: `Chat ${id}`, ...context,
  };
}

const a = row("a", "waiting-for-input", 2);
const b = row("b", "running", 2);
const c = row("c", "completed", 2);
const valid: MascotFeed = { status: a, chats: [a, b, c], focus: "c", counts: { chats: 3, attention: 1 }, request: 4 };

function event(feed: MascotFeed | Record<string, unknown>): Record<string, unknown> {
  return { type: "runtime.mascot-status", ...feed };
}

describe("mascot feed boundary", () => {
  it("accepts a consistent feed, an older feed without counts or request, and an idle list of settled chats", () => {
    expect(mascotFeedViolation(valid)).toBeNull();
    expect(parseRuntimeWorkerEvent(event(valid))).toEqual(event(valid));
    const { counts: _counts, request: _request, ...older } = valid;
    expect(parseRuntimeWorkerEvent(event(older))).toEqual(event({ ...older, counts: null }));
    const settled = [row("x", "completed", 0), row("y", "failed", 0)];
    const idle = { status: emptyMascotStatus(), chats: settled, focus: null, counts: { chats: 2, attention: 0 }, request: null };
    expect(parseRuntimeWorkerEvent(event(idle))).toEqual(event(idle));
    const empty = { status: emptyMascotStatus(), chats: [], focus: null, counts: { chats: 0, attention: 0 }, request: null };
    expect(parseRuntimeWorkerEvent(event(empty))).toEqual(event(empty));
  });

  const nine = Array.from({ length: MASCOT_CHAT_LIMIT + 1 }, (_, index) => row(`r${index}`, "running", 9));
  const broken: Array<[MascotFeedInvariant, MascotFeed]> = [
    ["list within cap", { status: nine[0]!, chats: nine, focus: null, counts: { chats: 9, attention: 0 } }],
    ["unique chat ids", { ...valid, chats: [a, b, a], focus: null }],
    ["rows share the active count", { ...valid, chats: [a, { ...b, activeCount: 3 }, c] }],
    ["status is never unavailable", { status: emptyMascotStatus("unavailable"), chats: [], focus: null, counts: { chats: 0, attention: 0 } }],
    ["status leads the list", { ...valid, status: b }],
    ["idle status means nothing is active",
      { status: emptyMascotStatus(), chats: [row("done", "completed", 0)], focus: null, counts: { chats: 2, attention: 1 } }],
    ["active chats put an active status first",
      { status: row("c", "completed", 1), chats: [row("c", "completed", 1), row("b", "running", 1)], focus: null, counts: null }],
    ["listed chats that need you put such a status first", { ...valid, status: b, chats: [b, a], focus: null, counts: null }],
    ["active count covers active rows",
      { status: row("a", "waiting-for-input", 1), chats: [row("a", "waiting-for-input", 1), row("b", "running", 1)], focus: null, counts: null }],
    ["rows are ranked by urgency", { ...valid, chats: [a, c, b], focus: null }],
    ["top rows hold the active chats",
      { status: row("a", "waiting-for-input", 3), chats: [row("a", "waiting-for-input", 3), row("c", "completed", 3)], focus: null, counts: null }],
    ["focus is listed", { ...valid, focus: "missing" }],
    ["focus answers a request", { ...valid, request: null }],
    ["attention within active", { ...valid, counts: { chats: 3, attention: 3 } }],
    ["active within chats", { ...valid, counts: { chats: 1, attention: 1 } }],
    ["list length matches the total", { ...valid, counts: { chats: 12, attention: 1 } }],
    ["attention covers attention rows", {
      status: row("a", "waiting-for-input", 3),
      chats: [row("a", "waiting-for-input", 3), row("d", "waiting-for-approval", 3), row("b", "running", 3)],
      focus: null, counts: { chats: 3, attention: 1 },
    }],
    ["top rows hold the chats that need you", { ...valid, focus: null, counts: { chats: 3, attention: 2 } }],
    ["status needs you exactly when a chat does", {
      status: row("b", "running", 2), chats: [row("b", "running", 2), row("c", "completed", 2)],
      focus: "c", counts: { chats: 2, attention: 1 }, request: 1,
    }],
  ];

  it.each(broken)("rejects a feed that breaks \"%s\"", (invariant, feed) => {
    expect(mascotFeedViolation(feed)).toBe(invariant);
    expect(parseRuntimeWorkerEvent(event(feed))).toBeNull();
  });

  it("covers every declared invariant with a rejection case", () => {
    expect(new Set(broken.map(([invariant]) => invariant)).size).toBe(broken.length);
    expect(broken).toHaveLength(19);
  });

  it("rejects unbounded strings, integers, tokens and extra fields before checking relations", () => {
    for (const change of [
      { chats: [a, { ...b, chatTitle: "x".repeat(97) }, c] },
      { chats: [a, { ...b, projectName: "‮project" }, c] },
      { focus: "x".repeat(201) },
      { focus: 7 },
      { status: { ...a, activeCount: 1_000_001 } },
      { status: { ...a, activeCount: -1 } },
      { counts: { chats: 1_000_001, attention: 0 } },
      { counts: { chats: 3, attention: -1 } },
      { counts: { chats: 3.5, attention: 1 } },
      { counts: { chats: 3 } },
      { counts: { chats: 3, attention: 1, extra: 1 } },
      { counts: null },
      { request: -1 }, { request: 1.5 }, { request: 2_147_483_648 }, { request: "4" }, { request: undefined },
      { extra: true },
    ]) expect(parseRuntimeWorkerEvent(event({ ...valid, ...change }))).toBeNull();
  });
});
