import { describe, expect, it } from "vitest";
import { emptyMascotStatus, MASCOT_CHAT_LIMIT, MASCOT_ROW_LIMIT, type MascotStatus } from "../../src/shared/mascot";
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
const valid: MascotFeed = { status: a, chats: [a, b, c], rows: [a, b], focus: "c", counts: { chats: 3, attention: 1, others: 2 }, request: 4 };

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
    const idle = { status: emptyMascotStatus(), chats: settled, rows: [], focus: null, counts: { chats: 2, attention: 0, others: 0 }, request: null };
    expect(parseRuntimeWorkerEvent(event(idle))).toEqual(event(idle));
    const empty = { status: emptyMascotStatus(), chats: [], rows: [], focus: null, counts: { chats: 0, attention: 0, others: 0 }, request: null };
    expect(parseRuntimeWorkerEvent(event(empty))).toEqual(event(empty));
  });

  it("accepts a failure shown above running chats, a quiet working chat, and five rows with a remainder", () => {
    const failed = row("f", "failed", 6);
    const running = Array.from({ length: 6 }, (_, index) => row(`r${index}`, "running", 6, index === 0 ? { quietSince: "2026-09-06T10:00:00.000Z" } : {}));
    const feed: MascotFeed = {
      status: failed, chats: [failed, ...running], rows: running.slice(0, MASCOT_ROW_LIMIT), focus: null,
      counts: { chats: 7, attention: 0, others: 6 }, request: null,
    };
    expect(mascotFeedViolation(feed)).toBeNull();
    expect(parseRuntimeWorkerEvent(event(feed))).toEqual(event(feed));
  });

  const nine = Array.from({ length: MASCOT_CHAT_LIMIT + 1 }, (_, index) => row(`r${index}`, "running", 9));
  const six = Array.from({ length: MASCOT_ROW_LIMIT + 1 }, (_, index) => row(`s${index}`, "running", 7));
  const broken: Array<[MascotFeedInvariant, MascotFeed]> = [
    ["list within cap", { status: nine[0]!, chats: nine, rows: [], focus: null, counts: { chats: 9, attention: 0, others: 0 } }],
    ["unique chat ids", { ...valid, chats: [a, b, a], focus: null }],
    ["rows share the active count", { ...valid, rows: [{ ...b, activeCount: 3 }] }],
    ["status is never unavailable", { status: emptyMascotStatus("unavailable"), chats: [], rows: [], focus: null, counts: null }],
    ["status leads the list", { ...valid, status: b, rows: [], focus: null, counts: null }],
    ["idle status means nothing to show", { status: emptyMascotStatus(), chats: [row("done", "completed", 0)], rows: [], focus: null, counts: { chats: 2, attention: 0, others: 1 } }],
    ["active count covers active rows",
      { status: row("a", "waiting-for-input", 1), chats: [row("a", "waiting-for-input", 1), row("b", "running", 1)], rows: [], focus: null, counts: null }],
    ["focus is listed", { ...valid, focus: "missing" }],
    ["focus answers a request", { ...valid, request: null }],
    ["row list within cap", { status: row("q", "waiting-for-input", 7), chats: [row("q", "waiting-for-input", 7)], rows: six, focus: null, counts: null }],
    ["unique row ids", { ...valid, rows: [b, b], counts: null }],
    ["rows leave out the shown chat", { ...valid, rows: [a, b], focus: null, counts: null }],
    ["rows hold only chats to show", { ...valid, rows: [row("x", "cancelled", 2)], counts: null }],
    ["rows are ranked by urgency", { ...valid, rows: [b, row("d", "completed", 2)], focus: null, counts: null }],
    ["status outranks the rows", { status: b, chats: [b, a], rows: [a], focus: null, counts: null }],
    ["attention within active", { ...valid, counts: { chats: 3, attention: 3, others: 2 } }],
    ["active within chats", { ...valid, counts: { chats: 1, attention: 1, others: 1 } }],
    ["others within chats", { ...valid, counts: { chats: 3, attention: 1, others: 4 } }],
    ["list length matches the total", { ...valid, counts: { chats: 12, attention: 1, others: 2 } }],
    ["row count matches the others", { ...valid, counts: { chats: 3, attention: 1, others: 3 } }],
    ["attention covers the rows that need you", {
      status: row("a", "waiting-for-input", 3), chats: [row("a", "waiting-for-input", 3), row("d", "waiting-for-approval", 3), row("b", "running", 3)],
      rows: [row("d", "waiting-for-approval", 3), row("b", "running", 3)], focus: null, counts: { chats: 3, attention: 1, others: 2 },
    }],
    ["top rows hold the chats that need you", {
      status: row("a", "waiting-for-input", 3), chats: [row("a", "waiting-for-input", 3), row("b", "running", 3), row("d", "waiting-for-approval", 3)],
      rows: [row("b", "running", 3)], focus: null, counts: { chats: 3, attention: 2, others: 1 },
    }],
    ["status needs you exactly when a chat does", {
      status: row("b", "running", 2), chats: [row("b", "running", 2), row("c", "completed", 2)], rows: [],
      focus: "c", counts: { chats: 2, attention: 1, others: 0 }, request: 1,
    }],
  ];

  it.each(broken)("rejects a feed that breaks \"%s\"", (invariant, feed) => {
    expect(mascotFeedViolation(feed)).toBe(invariant);
    expect(parseRuntimeWorkerEvent(event(feed))).toBeNull();
  });

  it("covers every declared invariant with a rejection case", () => {
    expect(new Set(broken.map(([invariant]) => invariant)).size).toBe(broken.length);
    expect(broken).toHaveLength(23);
  });

  it("rejects unbounded strings, integers, tokens and extra fields before checking relations", () => {
    for (const change of [
      { chats: [a, { ...b, chatTitle: "x".repeat(97) }, c] },
      { chats: [a, { ...b, projectName: "‮project" }, c] },
      { rows: [a, { ...b, message: "x".repeat(281) }] },
      { rows: [a, { ...b, quietSince: "yesterday" }] },
      { rows: [a, { ...c, quietSince: "2026-09-06T10:00:00.000Z" }] },
      { status: { ...a, quietSince: "2026-09-06T10:00:00.000Z" } },
      { rows: "b" }, { rows: null },
      { focus: "x".repeat(201) },
      { focus: 7 },
      { status: { ...a, activeCount: 1_000_001 } },
      { status: { ...a, activeCount: -1 } },
      { counts: { chats: 1_000_001, attention: 0, others: 0 } },
      { counts: { chats: 3, attention: -1, others: 1 } },
      { counts: { chats: 3.5, attention: 1, others: 1 } },
      { counts: { chats: 3, attention: 1 } },
      { counts: { chats: 3, attention: 1, others: 1, extra: 1 } },
      { counts: null },
      { request: -1 }, { request: 1.5 }, { request: 2_147_483_648 }, { request: "4" }, { request: undefined },
      { extra: true },
    ]) expect(parseRuntimeWorkerEvent(event({ ...valid, ...change }))).toBeNull();
    const { rows: _rows, ...withoutRows } = valid;
    expect(parseRuntimeWorkerEvent(event(withoutRows))).toBeNull();
  });
});
