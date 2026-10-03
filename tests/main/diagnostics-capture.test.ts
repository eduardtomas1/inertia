import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeDiagnostics, type RuntimeDiagnosticsOptions } from "../../src/main/runtime-diagnostics";
import type { DiagnosticIncident } from "../../src/shared/application-diagnostics";
import type { RuntimeSupervisorSnapshot } from "../../src/main/runtime-supervisor";

const roots: string[] = [];
const journals: RuntimeDiagnostics[] = [];
let clock = Date.parse("2026-09-09T10:00:00.000Z");
afterEach(() => {
  for (const journal of journals.splice(0)) journal.flushIncidents();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  clock = Date.parse("2026-09-09T10:00:00.000Z");
});

function fixture(options: RuntimeDiagnosticsOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "inertia-capture-"));
  roots.push(root);
  const directory = join(root, "runtime");
  const diagnostics = new RuntimeDiagnostics(directory, { now: () => clock, ...options });
  journals.push(diagnostics);
  return { root, directory, diagnostics };
}

function incident(update: Partial<DiagnosticIncident> = {}): DiagnosticIncident {
  const id = randomUUID();
  return { schemaVersion: 1, id, correlationId: id, code: "discord.delivery-unknown",
    at: new Date(clock).toISOString(), runtimeGeneration: null, outcome: "unknown", context: {}, metadata: {}, ...update };
}

function events(directory: string, file = "runtime.log"): string[] {
  const path = join(directory, file);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => (JSON.parse(line) as { event: string }).event);
}

function tick(): string {
  clock += 1_000;
  return new Date(clock).toISOString();
}

describe("diagnostics capture switch", () => {
  it("keeps nothing in memory or on disk for incidents while capture is off and does not count them as dropped", () => {
    const { directory, diagnostics } = fixture({ capture: { enabled: false, since: "2026-09-09T09:00:00.000Z" } });
    expect(diagnostics.recordIncident(incident())).toBeNull();
    diagnostics.flushIncidents();
    const page = diagnostics.query({ severity: "all" });
    expect(page).toMatchObject({ total: 0, dropped: 0, capture: false, since: "2026-09-09T09:00:00.000Z" });
    expect(existsSync(join(directory, "incidents.log"))).toBe(false);
  });

  it("records only the always-on lifecycle set while capture is off", () => {
    const { directory, diagnostics } = fixture({ capture: { enabled: false, since: null } });
    diagnostics.record("app.start");
    diagnostics.record("runtime.state", { phase: "ready", generation: 1 });
    diagnostics.record("logs.reveal");
    diagnostics.record("report.copy");
    diagnostics.record("snapshot.failure", { category: "permission-denied" });
    diagnostics.record("runtime.failure", { phase: "restarting", message: "Runtime startup timed out." });
    diagnostics.recordRestartRequested({ reason: "owned-process-cleanup-unconfirmed" } as never, 2);
    diagnostics.record("renderer.crash", { reason: "crashed", exitCode: 11 });
    diagnostics.record("runtime.stderr", { code: "database-backup-failed", count: 1 });
    diagnostics.record("main.failure", { code: "app-update-preparation-failed" });
    diagnostics.record("app.stop");
    expect(events(directory)).toEqual([
      "app.start", "runtime.failure", "runtime.restart-requested", "renderer.crash", "app.stop",
    ]);
  });

  it("marks where capture stopped and started, persisting the choice before applying it", () => {
    const { directory, diagnostics } = fixture();
    diagnostics.recordIncident(incident());
    const persist = vi.fn();
    tick();
    expect(diagnostics.setCapture(false, persist)).toEqual({ enabled: false, since: new Date(clock).toISOString() });
    expect(persist).toHaveBeenCalledExactlyOnceWith({ enabled: false, since: new Date(clock).toISOString() });
    expect(readFileSync(join(directory, "incidents.log"), "utf8")).toContain("discord.delivery-unknown");
    diagnostics.record("runtime.state", { phase: "ready" });
    tick();
    diagnostics.setCapture(true, persist);
    diagnostics.record("runtime.state", { phase: "ready" });
    expect(events(directory)).toEqual(["diagnostics.capture-stopped", "diagnostics.capture-started", "runtime.state"]);
    expect(diagnostics.setCapture(true, persist)).toMatchObject({ enabled: true });
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("leaves capture unchanged and writes no marker when the choice cannot be saved", () => {
    const { directory, diagnostics } = fixture();
    expect(() => diagnostics.setCapture(false, () => { throw new Error("read-only"); })).toThrow("read-only");
    expect(diagnostics.captureState()).toEqual({ enabled: true, since: null });
    expect(events(directory)).toEqual([]);
  });
});

describe("diagnostics history", () => {
  it("clears both journals, stale prune files and counters, then starts with a history-cleared marker", () => {
    const { directory, diagnostics } = fixture();
    diagnostics.record("app.start");
    diagnostics.recordIncident(incident());
    diagnostics.flushIncidents();
    writeFileSync(join(directory, "runtime.1.log"), "{}\n");
    writeFileSync(join(directory, `.runtime-diagnostics-${randomUUID()}.prune.tmp`), "partial");
    writeFileSync(join(directory, "unrelated.txt"), "keep");
    diagnostics.clearHistory();
    expect(readdirSync(directory).sort()).toEqual(["runtime.log", "unrelated.txt"]);
    expect(events(directory)).toEqual(["diagnostics.history-cleared"]);
    expect(diagnostics.queryIncidents({ severity: "all" })).toMatchObject({ total: 0, dropped: 0 });
    expect(diagnostics.query({ severity: "all" }).events.map(({ event }) => event)).toEqual(["diagnostics.history-cleared"]);
  });

  it("writes the history-cleared marker even while capture is off", () => {
    const { directory, diagnostics } = fixture({ capture: { enabled: false, since: null } });
    diagnostics.record("app.start");
    diagnostics.clearHistory();
    diagnostics.record("runtime.state", { phase: "ready" });
    expect(events(directory)).toEqual(["diagnostics.history-cleared"]);
  });

  it.skipIf(process.platform === "win32")("refuses to clear through a linked diagnostics directory", () => {
    const { root, directory, diagnostics } = fixture();
    diagnostics.record("app.start");
    const link = join(root, "linked");
    symlinkSync(directory, link);
    const linked = new RuntimeDiagnostics(link, { now: () => clock });
    expect(() => linked.clearHistory()).toThrow("not a local directory");
    expect(events(directory)).toEqual(["app.start"]);
  });

  it("removes a leftover prune file when the journal is first opened", () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-capture-"));
    roots.push(root);
    const directory = join(root, "runtime");
    mkdirSync(directory, { recursive: true });
    const leftover = join(directory, `.runtime-diagnostics-${randomUUID()}.prune.tmp`);
    writeFileSync(leftover, "partial");
    new RuntimeDiagnostics(directory, { now: () => clock }).record("app.start");
    expect(existsSync(leftover)).toBe(false);
  });

  it("keeps lifecycle events when incidents fill their own budget", () => {
    const { directory, diagnostics } = fixture({ maxFileBytes: 4_096, maxFiles: 2 });
    diagnostics.record("app.start");
    for (let index = 0; index < 60; index += 1) {
      tick();
      diagnostics.recordIncident(incident());
      diagnostics.flushIncidents();
    }
    expect(events(directory)).toEqual(["app.start"]);
    expect(readdirSync(directory).filter((name) => name.startsWith("incidents")).length).toBe(2);
  });
});

describe("recent events", () => {
  it("merges lifecycle events with incidents newest first and filters them like incidents", () => {
    const { diagnostics } = fixture();
    diagnostics.record("app.start");
    tick();
    diagnostics.recordIncident(incident({ at: new Date(clock).toISOString() }));
    tick();
    diagnostics.record("runtime.failure", { phase: "restarting", message: "Runtime startup timed out." });
    const page = diagnostics.query({ severity: "all" });
    expect(page.total).toBe(3);
    expect(page.events.map(({ title }) => title)).toEqual(["The local runtime reported a failure", "Inertia started"]);
    expect(page.events[0]).toMatchObject({ severity: "error", subsystem: "runtime", detail: expect.arrayContaining(["Runtime startup timed out."]) });
    expect(page.records).toHaveLength(1);
    expect(diagnostics.query({ severity: "error" }).total).toBe(1);
    expect(diagnostics.query({ severity: "all", subsystem: "discord" }).events).toEqual([]);
    expect(diagnostics.query({ severity: "all", search: "started" }).events.map(({ event }) => event)).toEqual(["app.start"]);
    expect(diagnostics.query({ severity: "all", incidentId: randomUUID() }).total).toBe(0);
    expect(diagnostics.query({ severity: "all", limit: 1, offset: 1 }).records).toHaveLength(1);
  });

  it("journals a database restore once without the backup name", () => {
    const { directory, diagnostics } = fixture();
    const snapshot = {
      phase: "ready", generation: 1, pid: 42, restartAttempt: 0, restartScheduled: false,
      lastError: null, startupBlockerCode: null,
      databaseRecovery: { checkedAt: "2026-09-09T09:59:00.000Z", outcome: "restored", trigger: "primary-corrupt",
        restoredBackup: "/Users/someone/private/inertia.sqlite.bak", preservedCorruptPrimary: true,
        preservedDatabaseFamilyMembers: 2, invalidBackupsSkipped: 1, unsupportedBackupsSkipped: 0 },
    } as unknown as RuntimeSupervisorSnapshot;
    diagnostics.recordState(snapshot);
    diagnostics.recordState(snapshot);
    expect(events(directory)).toEqual(["runtime.state", "runtime.database-recovery", "runtime.state"]);
    const content = readFileSync(join(directory, "runtime.log"), "utf8");
    expect(content).not.toContain("private");
    const entry = diagnostics.query({ severity: "all" }).events.find(({ event }) => event === "runtime.database-recovery");
    expect(entry).toMatchObject({ title: "The database was restored from a backup", detail: expect.arrayContaining(["outcome=restored", "trigger=primary-corrupt"]) });
  });

  it("records a renderer crash with an allowlisted reason and ignores a clean exit", () => {
    const { directory, diagnostics } = fixture();
    diagnostics.record("renderer.crash", { reason: "clean-exit", exitCode: 0 });
    diagnostics.record("renderer.crash", { reason: "oom", exitCode: 3_221_225_477, extra: "/private/path" });
    expect(events(directory)).toEqual(["renderer.crash"]);
    expect(readFileSync(join(directory, "runtime.log"), "utf8")).not.toContain("private");
    expect(diagnostics.query({ severity: "error" }).events[0]).toMatchObject({
      title: "The app window stopped unexpectedly", detail: ["reason=oom", "exit-code=3221225477"],
    });
  });

  it("exports lifecycle events with incidents for the user-facing export and the issue report", () => {
    const { diagnostics } = fixture();
    diagnostics.record("app.start");
    diagnostics.recordIncident(incident());
    const exported = JSON.parse(diagnostics.exportDiagnostics({ severity: "all" })) as { records: unknown[]; events: { event: string; id?: string }[] };
    expect(exported.records).toHaveLength(1);
    expect(exported.events).toMatchObject([{ event: "app.start", title: "Inertia started" }]);
    expect(exported.events[0]).not.toHaveProperty("id");
  });

  it("reads an incident written into runtime.log by an older version and keeps it out of the event list", () => {
    const { directory, diagnostics } = fixture();
    diagnostics.recordIncident(incident());
    diagnostics.flushIncidents();
    renameSync(join(directory, "incidents.log"), join(directory, "runtime.log"));
    const reopened = new RuntimeDiagnostics(directory, { now: () => clock });
    const page = reopened.query({ severity: "all" });
    expect(page.records.map((record) => record.code)).toEqual(["discord.delivery-unknown"]);
    expect(page.events).toEqual([]);
    expect((JSON.parse(reopened.exportForReport(clock - 3_600_000, 6_000)) as { records: unknown[] }).records).toHaveLength(1);
  });
});

describe("diagnostics exports", () => {
  it("keeps incidents, warnings, errors and capture markers in an issue report ahead of routine events", () => {
    const { diagnostics } = fixture();
    diagnostics.recordIncident(incident());
    diagnostics.flushIncidents();
    tick();
    diagnostics.record("runtime.failure", { phase: "restarting", message: "Runtime startup timed out." });
    tick();
    diagnostics.setCapture(false);
    tick();
    diagnostics.setCapture(true);
    for (let generation = 0; generation < 30; generation += 1) {
      tick();
      diagnostics.record("runtime.state", { phase: "ready", generation });
    }
    const report = JSON.parse(diagnostics.exportForReport(clock - 3_600_000, 6_000)) as {
      records: unknown[]; events: { event: string }[];
    };
    expect(report.records).toHaveLength(1);
    expect(report.events.map(({ event }) => event)).toEqual([
      "diagnostics.capture-started", "diagnostics.capture-stopped", "runtime.failure",
    ]);
  });

  it("truncates a full user export newest first at a record boundary and says so in the file", () => {
    const { diagnostics } = fixture({ maxFileBytes: 4 * 1_024 * 1_024 });
    for (let index = 0; index < 4_000; index += 1) {
      clock += 100;
      diagnostics.record("runtime.state", { phase: "ready", generation: index, processId: 4_242, restartAttempt: 0, restartScheduled: false });
    }
    const text = diagnostics.exportDiagnostics({ severity: "all" });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(512 * 1_024);
    const exported = JSON.parse(text) as { truncated?: boolean; events: { at: string }[] };
    expect(exported.truncated).toBe(true);
    expect(exported.events.length).toBeGreaterThan(0);
    expect(exported.events.length).toBeLessThan(4_000);
    expect(exported.events[0]!.at).toBe(new Date(clock).toISOString());
    const small = JSON.parse(fixture().diagnostics.exportDiagnostics({ severity: "all" })) as { truncated?: boolean };
    expect(small).not.toHaveProperty("truncated");
  });
});

describe("bounded report search", () => {
  it("starts the size search from what can fit instead of half of a long history", () => {
    const { diagnostics } = fixture({ maxFileBytes: 4 * 1_024 * 1_024 });
    for (let index = 0; index < 400; index += 1) {
      clock += 100;
      diagnostics.record("runtime.failure", { phase: "restarting", generation: index, message: "Runtime startup timed out." });
    }
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const report = diagnostics.exportForReport(clock - 3_600_000, 1_500);
      expect((JSON.parse(report) as { events: unknown[] }).events.length).toBeGreaterThan(0);
      expect(stringify.mock.calls.filter((call) => call[2] === 2).length).toBeLessThanOrEqual(6);
    } finally {
      stringify.mockRestore();
    }
  });
});

describe("diagnostics directory safety", () => {
  it.skipIf(process.platform === "win32")("refuses to clear when the logs folder above the journal is a link", () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-capture-"));
    roots.push(root);
    const real = join(root, "elsewhere");
    mkdirSync(join(real, "runtime"), { recursive: true });
    symlinkSync(real, join(root, "logs"));
    const linked = new RuntimeDiagnostics(join(root, "logs", "runtime"), { now: () => clock });
    writeFileSync(join(real, "runtime", "runtime.log"), "{}\n");
    expect(() => linked.clearHistory()).toThrow("not a local directory");
    expect(readdirSync(join(real, "runtime"))).toEqual(["runtime.log"]);
  });
});
