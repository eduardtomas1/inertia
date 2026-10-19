import { describe, expect, it } from "vitest";

import {
  appLaunchExitLabel,
  appLaunchStopDetail,
  appLogRows,
  appSessionReducer,
  emptyAppSession,
  filterLogLines,
  formatAppUptime,
  MAX_APP_SURFACE_LOG_LINES,
  mergeLogLines,
} from "../../src/renderer/src/utils/appUnderTestSession";
import type {
  AppUnderTestEvidenceWithThumbnail,
  AppUnderTestLaunch,
  AppUnderTestLogLine,
  AppUnderTestWindow,
} from "../../src/shared/app-under-test";
import { MAX_APP_LOG_LINES } from "../../src/shared/app-under-test";

const line = (cursor: number, text = `line ${cursor}`): AppUnderTestLogLine => ({ cursor, stream: "stdout", text });
const evidence = (id: string, at: string): AppUnderTestEvidenceWithThumbnail => ({
  evidenceId: id, launchId: "launch", kind: "action", label: "Clicked", at, width: null, height: null, hasThumbnail: false, thumbnail: null,
});

const appWindow = (windowId: string, launchId: string): AppUnderTestWindow => ({
  windowId, launchId, title: "Fixture", origin: "file://", active: true, loading: false,
});
const appLaunch = (launchId: string, windows: AppUnderTestWindow[], overrides: Partial<AppUnderTestLaunch> = {}): AppUnderTestLaunch => ({
  launchId, conversationId: "chat", kind: "electron", actionId: null, label: "Electron app", startedBy: "agent", state: "running",
  pid: 1, startedAt: "2026-10-19T10:00:00.000Z", readyAt: null, exitedAt: null, exitCode: null, signal: null, stopRequested: false, cdp: true, transport: "cdp",
  windowCount: windows.length, windows, cleanupConfirmed: null, failure: null, ...overrides,
});

describe("App session projection", () => {
  it("takes each live launch's windows from its record, then follows window deltas", () => {
    const running = appLaunch("running", [appWindow("w1", "running")]);
    const exited = appLaunch("exited", [], { state: "exited", startedAt: "2026-10-19T09:00:00.000Z" });
    let state = appSessionReducer(emptyAppSession(), { type: "windows", launchId: "stale", windows: [appWindow("w0", "stale")] });
    state = appSessionReducer(state, { type: "launches", launches: [running, exited] });
    expect(state.windows).toEqual({ running: running.windows });
    const two = [appWindow("w1", "running"), appWindow("w2", "running")];
    state = appSessionReducer(state, { type: "windows", launchId: "running", windows: two });
    expect(state.windows.running).toEqual(two);
    state = appSessionReducer(state, { type: "launch", launch: appLaunch("running", [two[1]!]) });
    expect(state.windows.running).toEqual([two[1]]);
    state = appSessionReducer(state, { type: "launch", launch: appLaunch("running", [], { state: "exited" }) });
    expect(state.windows).toEqual({});
  });

  it("drops the logs and windows of a launch pushed out of the bounded list", () => {
    const launches = Array.from({ length: 8 }, (_, index) => appLaunch(`l${index}`, [appWindow(`w${index}`, `l${index}`)], {
      startedAt: `2026-10-19T10:00:0${index}.000Z`,
    }));
    let state = appSessionReducer(emptyAppSession(), { type: "launches", launches });
    for (const launch of launches) state = appSessionReducer(state, { type: "logs", launchId: launch.launchId, lines: [line(1)] });
    state = appSessionReducer(state, { type: "launch", launch: appLaunch("new", [], { startedAt: "2026-10-19T10:00:09.000Z" }) });
    expect(state.launches.map(({ launchId }) => launchId)).toEqual(["l1", "l2", "l3", "l4", "l5", "l6", "l7", "new"]);
    expect(Object.keys(state.logs).sort()).toEqual(["l1", "l2", "l3", "l4", "l5", "l6", "l7"]);
    expect(state.windows).not.toHaveProperty("l0");
    expect(state.windows.new).toEqual([]);
  });

  it("keeps only the newest 2,000 lines, merged by cursor without duplicates", () => {
    expect(MAX_APP_SURFACE_LOG_LINES).toBe(MAX_APP_LOG_LINES);
    const first = mergeLogLines([], Array.from({ length: 1_500 }, (_, index) => line(index + 1)));
    const merged = mergeLogLines(first, Array.from({ length: 1_500 }, (_, index) => line(index + 1_001)));
    expect(merged).toHaveLength(MAX_APP_SURFACE_LOG_LINES);
    expect(merged[0]!.cursor).toBe(501);
    expect(merged.at(-1)!.cursor).toBe(2_500);
    expect(new Set(merged.map(({ cursor }) => cursor)).size).toBe(merged.length);
    const older = mergeLogLines([line(5), line(6)], [line(2), line(5)]);
    expect(older.map(({ cursor }) => cursor)).toEqual([2, 5, 6]);
  });

  it("derives skipped and earlier markers from cursor gaps", () => {
    expect(appLogRows([line(1), line(2)]).map(({ kind }) => kind)).toEqual(["line", "line"]);
    expect(appLogRows([line(3), line(4), line(9)])).toEqual([
      { kind: "earlier", key: "earlier" },
      { kind: "line", key: "3", line: line(3) },
      { kind: "line", key: "4", line: line(4) },
      { kind: "skipped", key: "skipped-9", count: 4 },
      { kind: "line", key: "9", line: line(9) },
    ]);
  });

  it("filters case-insensitively by text or exact stream", () => {
    const lines = [line(1, "Ready"), { cursor: 2, stream: "stderr" as const, text: "boom" }];
    expect(filterLogLines(lines, "  READY ")).toEqual([lines[0]]);
    expect(filterLogLines(lines, "stderr")).toEqual([lines[1]]);
    expect(filterLogLines(lines, "")).toBe(lines);
  });

  it("drops evidence the runtime evicted but keeps entries that arrived after the list", () => {
    let state = appSessionReducer(emptyAppSession(), { type: "evidence.appended", evidence: evidence("old", "2026-10-19T10:00:00.000Z") });
    state = appSessionReducer(state, { type: "evidence.appended", evidence: evidence("late", "2026-10-19T10:00:09.000Z") });
    state = appSessionReducer(state, { type: "evidence", evidence: [evidence("kept", "2026-10-19T10:00:05.000Z")] });
    expect(state.evidence.map(({ evidenceId }) => evidenceId)).toEqual(["kept", "late"]);
  });

  it("labels a requested stop as Stopped and only an unrequested exit by its code or signal", () => {
    const exited = (overrides: Partial<AppUnderTestLaunch>) => appLaunchExitLabel(appLaunch("x", [], { state: "exited", ...overrides }));
    expect(exited({ stopRequested: true, exitCode: 143 })).toBe("Stopped");
    expect(appLaunchStopDetail(appLaunch("x", [], { state: "exited", stopRequested: true, exitCode: 143 }))).toBe("exit code 143");
    expect(appLaunchStopDetail(appLaunch("x", [], { state: "exited", stopRequested: true, signal: "SIGTERM" }))).toBe("signal SIGTERM");
    expect(exited({ exitCode: 1 })).toBe("Exit code 1");
    expect(exited({ signal: "SIGSEGV" })).toBe("Signal SIGSEGV");
    expect(exited({})).toBe("Ended");
    expect(appLaunchExitLabel(appLaunch("x", [], { stopRequested: true }))).toBeNull();
    expect(appLaunchStopDetail(appLaunch("x", [], { state: "exited", exitCode: 1 }))).toBeNull();
  });

  it("formats uptime compactly", () => {
    expect(formatAppUptime(-5)).toBe("0s");
    expect(formatAppUptime(59_999)).toBe("59s");
    expect(formatAppUptime(65_000)).toBe("1m 05s");
    expect(formatAppUptime(3_726_000)).toBe("1h 02m");
  });
});
