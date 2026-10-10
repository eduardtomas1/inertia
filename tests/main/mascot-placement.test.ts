import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mascotBounds, mascotDisplay, mascotPosition, readMascotWindowState, rememberMascotPosition, supportsMascotPlacement, writeMascotWindowState,
} from "../../src/main/mascot-placement";
import { mascotChatChoices } from "../../src/shared/mascot-choices";
import { emptyMascotStatus, parseMascotChats, parseMascotPreferences, parseMascotStatus, type MascotStatus } from "../../src/shared/mascot";
import { parseRuntimeWorkerCommand, parseRuntimeWorkerEvent } from "../../src/node/runtime-process-protocol";

const primary = { workArea: { x: 0, y: 24, width: 1440, height: 876 } };
const secondary = { workArea: { x: -1920, y: -200, width: 1920, height: 1080 } };

describe("mascot placement and contracts", () => {
  it("leaves native Wayland placement to the compositor without changing app platform flags", () => {
    expect(supportsMascotPlacement("darwin", {}, "")).toBe(true);
    expect(supportsMascotPlacement("win32", {}, "")).toBe(true);
    expect(supportsMascotPlacement("linux", {}, "")).toBe(true);
    expect(supportsMascotPlacement("linux", { WAYLAND_DISPLAY: "wayland-0" }, "")).toBe(false);
    expect(supportsMascotPlacement("linux", {}, "wayland")).toBe(false);
    expect(supportsMascotPlacement("linux", { WAYLAND_DISPLAY: "wayland-0" }, "x11")).toBe(true);
  });
  it("clamps the entire overlay after drag, monitor removal, and scale changes", () => {
    expect(mascotBounds({ x: -2000, y: -300 }, [primary, secondary])).toEqual({ x: -1920, y: -200, width: 240, height: 316 });
    expect(mascotBounds({ x: -1800, y: -150 }, [primary])).toEqual({ x: 0, y: 24, width: 240, height: 316 });
    expect(mascotBounds({ x: 1439, y: 899 }, [primary])).toEqual({ x: 1200, y: 584, width: 240, height: 316 });
    expect(mascotBounds(null, [primary])).toEqual({ x: 1176, y: 560, width: 240, height: 316 });
  });

  it("remembers one position per display and restores it when that display returns", () => {
    const left = { id: 2, workArea: { x: -1920, y: -200, width: 1920, height: 1080 } };
    const main = { id: 1, ...primary };
    let positions = rememberMascotPosition([], { x: -1000, y: 100, width: 240, height: 316 }, [main, left]);
    positions = rememberMascotPosition(positions, { x: 400, y: 300, width: 240, height: 316 }, [main, left]);
    expect(positions).toEqual([{ display: "1", x: 400, y: 300 }, { display: "2", x: -1000, y: 100 }]);
    positions = rememberMascotPosition(positions, { x: -1500, y: 0, width: 240, height: 316 }, [main, left]);
    expect(positions).toEqual([{ display: "2", x: -1500, y: 0 }, { display: "1", x: 400, y: 300 }]);
    expect(mascotPosition(positions, [main])).toEqual({ x: 400, y: 300 });
    expect(mascotPosition(positions, [main, left])).toEqual({ x: -1500, y: 0 });
    expect(mascotPosition(positions, [{ id: 3, ...primary }])).toEqual({ x: -1500, y: 0 });
    expect(mascotBounds(mascotPosition(positions, [{ id: 3, ...primary }]), [{ id: 3, ...primary }])).toEqual({ x: 0, y: 24, width: 240, height: 316 });
    expect(mascotPosition([], [main])).toBeNull();
    expect(mascotDisplay({ x: 1300, y: 700, width: 240, height: 316 }, [main, left])).toBe("1");
    expect(mascotDisplay({ x: -300, y: 0, width: 240, height: 316 }, [main, left])).toBe("2");
    expect(mascotDisplay({ x: 0, y: 0, width: 240, height: 316 }, [primary])).toBeNull();
    const many = Array.from({ length: 10 }, (_, index) => ({ id: index + 10, workArea: { x: index * 2000, y: 0, width: 2000, height: 1000 } }));
    let all: ReturnType<typeof rememberMascotPosition> = [];
    for (const display of many) all = rememberMascotPosition(all, { x: display.workArea.x, y: 0, width: 240, height: 316 }, many);
    expect(all).toHaveLength(8);
    const edid = 0x4c2d * 2 ** 40 + 0x1234 * 2 ** 8 + 1;
    expect(Number.isSafeInteger(edid)).toBe(false);
    const linux = [{ id: edid, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
    const remembered = rememberMascotPosition([], { x: 300, y: 400, width: 240, height: 316 }, linux);
    const directory = mkdtempSync(join(tmpdir(), "mascot-edid-"));
    try {
      const path = join(directory, "state.json");
      writeMascotWindowState(path, { preferences: { enabled: true, motion: true }, positions: remembered });
      const restored = readMascotWindowState(path).positions;
      expect(restored).toEqual([{ display: String(edid), x: 300, y: 400 }]);
      expect(mascotPosition(restored, linux)).toEqual({ x: 300, y: 400 });
    } finally { rmSync(directory, { recursive: true, force: true }); }
    expect(all[0]!.display).toBe("19");
  });

  it("defaults off and atomically persists enablement, motion, and placement", () => {
    const directory = mkdtempSync(join(tmpdir(), "mascot-state-"));
    try {
      const path = join(directory, "state.json");
      expect(readMascotWindowState(path).preferences.enabled).toBe(false);
      const state = { preferences: { enabled: true, motion: false }, positions: [{ display: "7", x: -1800, y: 40 }, { display: null, x: 5, y: 6 }] };
      writeMascotWindowState(path, state);
      expect(readMascotWindowState(path)).toEqual(state);
      writeMascotWindowState(path, { ...state, positions: [] });
      expect(readMascotWindowState(path).positions).toEqual([]);
      writeFileSync(path, JSON.stringify({ preferences: { enabled: true, motion: true }, position: { x: 1200, y: 660 } }));
      expect(readMascotWindowState(path)).toEqual({ preferences: { enabled: true, motion: true }, positions: [{ display: null, x: 1200, y: 584 }] });
      writeFileSync(path, JSON.stringify({ preferences: { enabled: true, motion: true }, positions: [
        { display: 7, x: 1, y: 2 }, { display: "8", x: 3, y: 4 }, { display: "9", x: 1.5, y: 2 }, null, { display: "x".repeat(41), x: 1, y: 1 },
        { display: "1e3", x: 1, y: 1 }, { display: null, x: 5, y: 6 },
      ] }));
      expect(readMascotWindowState(path).positions).toEqual([{ display: "8", x: 3, y: 4 }, { display: null, x: 5, y: 6 }]);
      writeFileSync(path, "{");
      expect(readMascotWindowState(path).preferences.enabled).toBe(false);
      writeFileSync(path, " ".repeat(2048));
      expect(readMascotWindowState(path).preferences.enabled).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("uses the cursor's destination display in DIP across seams, gaps, and vertical arrangements", () => {
    const right = { workArea: { x: 1440, y: 100, width: 1280, height: 720 } };
    expect(mascotBounds({ x: 1321, y: 0 }, [primary, right], { x: 1441, y: 260 }))
      .toEqual({ x: 1440, y: 100, width: 240, height: 316 });
    const above = { workArea: { x: 0, y: -1080, width: 1920, height: 1040 } };
    expect(mascotBounds({ x: 0, y: -270 }, [primary, above], { x: 120, y: -10 }))
      .toEqual({ x: 0, y: -356, width: 240, height: 316 });
    expect(mascotBounds({ x: 0, y: 0 }, [{ workArea: { x: -500, y: 40, width: 160, height: 200 } }]))
      .toEqual({ x: -500, y: 40, width: 160, height: 200 });
    expect(mascotBounds(null, [])).toEqual({ x: 760, y: 428, width: 240, height: 316 });
  });

  it("rejects malformed preferences, unknown phases, extra payload, and broken identity", () => {
    expect(parseMascotPreferences({ enabled: "yes", motion: true })).toBeNull();
    expect(parseMascotPreferences({ enabled: true, motion: true, path: "/tmp" })).toBeNull();
    for (const value of [null, { ...emptyMascotStatus(), phase: "thinking" },
      { ...emptyMascotStatus(), conversationId: "chat" }, { ...emptyMascotStatus(), activeCount: Infinity },
      { ...emptyMascotStatus(), text: "secret" }, { ...emptyMascotStatus(), phase: "running" }]) {
      expect(parseMascotStatus(value)).toBeNull();
      expect(parseRuntimeWorkerEvent({ type: "runtime.mascot-status", status: value, chats: [], rows: [], focus: null })).toBeNull();
    }
    expect(parseRuntimeWorkerEvent({ type: "runtime.mascot-status", status: emptyMascotStatus(), chats: [], rows: [] })).toBeNull();
    expect(parseRuntimeWorkerEvent({ type: "runtime.mascot-status", status: emptyMascotStatus(), chats: [], rows: [], focus: 7 })).toBeNull();
    expect(parseRuntimeWorkerEvent({ type: "runtime.mascot-status", status: emptyMascotStatus(), chats: [], rows: [], focus: null }))
      .toEqual({ type: "runtime.mascot-status", status: emptyMascotStatus(), chats: [], rows: [], focus: null, counts: null });
    expect(parseRuntimeWorkerEvent({ type: "runtime.mascot-status", status: emptyMascotStatus(), chats: [], rows: [], focus: null, counts: { chats: 0, attention: 0, others: 0 } }))
      .toEqual({ type: "runtime.mascot-status", status: emptyMascotStatus(), chats: [], rows: [], focus: null, counts: { chats: 0, attention: 0, others: 0 } });
    for (const counts of [
      { chats: 3, attention: 4, others: 0 }, { chats: -1, attention: 0, others: 0 }, { chats: 2, attention: -1, others: 0 }, { chats: 1.5, attention: 1, others: 0 },
      { chats: 1_000_001, attention: 0, others: 0 }, { chats: Number.NaN, attention: 0, others: 0 }, { chats: Infinity, attention: 0, others: 0 },
      { chats: "3", attention: 1, others: 0 }, { chats: 3, attention: 0, others: -1 }, { chats: 3, attention: 0, others: 1 },
      { chats: 3 }, { chats: 3, attention: 1 }, { chats: 3, attention: 1, others: 0, extra: 1 }, [3, 1, 0], 3, null, undefined,
    ]) {
      expect(parseRuntimeWorkerEvent({ type: "runtime.mascot-status", status: emptyMascotStatus(), chats: [], rows: [], focus: null, counts })).toBeNull();
    }
    expect(parseRuntimeWorkerEvent({ type: "runtime.mascot-status", status: emptyMascotStatus(), chats: [], rows: [], focus: null, counts: { chats: 1, attention: 1, others: 0 }, extra: 1 })).toBeNull();
    expect(parseRuntimeWorkerCommand({ type: "runtime.mascot-focus", conversationId: "chat", request: 4 }))
      .toEqual({ type: "runtime.mascot-focus", conversationId: "chat", request: 4 });
    expect(parseRuntimeWorkerCommand({ type: "runtime.mascot-focus", conversationId: null, request: 0 }))
      .toEqual({ type: "runtime.mascot-focus", conversationId: null, request: 0 });
    for (const request of [-1, 1.5, 2_147_483_648, Number.NaN, "4", null, undefined]) {
      expect(parseRuntimeWorkerCommand({ type: "runtime.mascot-focus", conversationId: "chat", request })).toBeNull();
    }
    for (const conversationId of ["", "a\u0000b", "x".repeat(201), 3, undefined]) {
      expect(parseRuntimeWorkerCommand({ type: "runtime.mascot-focus", conversationId, request: 1 })).toBeNull();
    }
    expect(parseRuntimeWorkerCommand({ type: "runtime.mascot-focus", conversationId: null, request: 1, extra: true })).toBeNull();
  });

  it("bounds chat context, plan steps, timestamps, and the chat list", () => {
    const chat = (id: string, context: Partial<MascotStatus> = {}): MascotStatus => ({
      ...emptyMascotStatus(), phase: "running", conversationId: id, projectId: "project", runId: "run", turnId: "turn", activeCount: 1,
      projectName: "Inertia", steps: { completed: 1, total: 3 }, since: "2026-09-06T09:00:00.000Z", ...context,
    });
    expect(parseMascotStatus(chat("chat"))).toEqual(chat("chat"));
    for (const context of [
      { steps: { completed: 4, total: 3 } }, { steps: { completed: 0, total: 0 } }, { steps: { completed: 1, total: 3, label: "x" } },
      { since: "yesterday" }, { since: "2026-09-06 09:00" }, { projectName: "x".repeat(65) }, { projectName: "\u202einertia" },
    ] as Partial<MascotStatus>[]) expect(parseMascotStatus(chat("chat", context))).toBeNull();
    expect(parseMascotStatus({ ...emptyMascotStatus(), steps: { completed: 0, total: 1 } })).toBeNull();
    expect(parseMascotChats([chat("a"), chat("b")])).toHaveLength(2);
    expect(parseMascotChats([chat("a"), chat("a")])).toBeNull();
    expect(parseMascotChats([emptyMascotStatus()])).toBeNull();
    expect(parseMascotChats(Array.from({ length: 9 }, (_, index) => chat(`chat-${index}`)))).toBeNull();
    expect(parseRuntimeWorkerEvent({ type: "runtime.mascot-status", status: chat("a"), chats: [chat("a"), chat("a")], rows: [], focus: null })).toBeNull();
  });

  it("gives every chat choice a distinct title and project, even when a title already carries an ordinal", () => {
    const chat = (id: string, chatTitle: string | null, projectName: string | null, since: string | null = null): MascotStatus => ({
      ...emptyMascotStatus(), phase: "running", conversationId: id, projectId: "project", runId: "run", turnId: "turn",
      activeCount: 1, chatTitle, projectName, since,
    });
    const choices = mascotChatChoices([
      chat("b", "Fix", "Alpha", "2026-09-06T10:00:00.000Z"), chat("a", "Fix", "Alpha", "2026-09-06T10:00:00.000Z"),
      chat("c", "Fix (1)", "Alpha"), chat("d", null, null), chat("e", "", ""),
    ]);
    expect(choices).toEqual([
      { title: "Fix (2)", project: "Alpha" }, { title: "Fix (1) (2)", project: "Alpha" }, { title: "Fix (1) (1)", project: "Alpha" },
      { title: "Untitled chat (1)", project: null }, { title: "Untitled chat (2)", project: null },
    ]);
    expect(new Set(choices.map((choice) => JSON.stringify(choice))).size).toBe(choices.length);
  });
});
