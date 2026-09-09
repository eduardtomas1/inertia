import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeDiagnostics } from "../../src/main/runtime-diagnostics";
import {
  diagnosticDefinition,
  parseDiagnosticIncident,
  type DiagnosticIncident,
} from "../../src/shared/application-diagnostics";

const roots: string[] = [];
const journals: RuntimeDiagnostics[] = [];
const now = Date.parse("2026-09-09T10:00:00.000Z");
function incident(update: Partial<DiagnosticIncident> = {}): DiagnosticIncident {
  const id = randomUUID();
  return {
    schemaVersion: 1, id, correlationId: id,
    code: "discord.delivery-unknown", at: new Date(now).toISOString(),
    runtimeGeneration: null, outcome: "unknown", context: {}, metadata: {}, ...update,
  };
}
function fixture(options: ConstructorParameters<typeof RuntimeDiagnostics>[1] = {}) {
  const root = mkdtempSync(join(tmpdir(), "inertia-incidents-"));
  roots.push(root);
  const directory = join(root, "runtime");
  const diagnostics = new RuntimeDiagnostics(directory, { now: () => now, ...options });
  journals.push(diagnostics);
  return { root, directory, diagnostics };
}
afterEach(() => {
  for (const journal of journals.splice(0)) journal.flushIncidents();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("application diagnostic contract", () => {
  it("rejects secret-bearing fields instead of attempting to redact unrestricted prose", () => {
    const secret = "https://discord.com/api/webhooks/fixture/DO_NOT_STORE_THIS";
    const base = incident();
    for (const value of [
      { ...base, message: secret },
      { ...base, metadata: { error: secret } },
      { ...base, context: { projectId: secret } },
      { ...base, code: secret },
      { ...base, runtimeGeneration: secret },
      { ...base, schemaVersion: 99 },
      { ...base, metadata: { httpStatus: 1000 } },
    ]) expect(parseDiagnosticIncident(value)).toBeNull();
    expect(diagnosticDefinition(base.code).causeKnown).toBe(false);
    expect(diagnosticDefinition(base.code).nextStep).toContain("will not resend automatically");
  });
});

describe("main-owned diagnostics journal", () => {
  it("survives restart and reads offline without a runtime or database", () => {
    const { directory, diagnostics } = fixture();
    const event = incident();
    diagnostics.recordIncident(event);
    diagnostics.flushIncidents();
    const reopened = new RuntimeDiagnostics(directory, { now: () => now });
    expect(reopened.queryIncidents({})).toMatchObject({
      persistence: "available", runtime: "unavailable", total: 1,
      records: [{ id: event.id, severity: "warning", subsystem: "discord", operation: "release-info" }],
    });
    expect(reopened.exportIncidents({})).toContain("Discord delivery could not be confirmed");
  });

  it("deduplicates propagation and retains first/last time and count", () => {
    let clock = now;
    const { diagnostics, directory } = fixture({ now: () => clock });
    const event = incident();
    diagnostics.recordIncident(event);
    clock += 1000;
    diagnostics.recordIncident({ ...event, at: new Date(clock).toISOString() });
    diagnostics.flushIncidents();
    expect(diagnostics.queryIncidents({}).records).toMatchObject([{
      firstAt: event.at, at: new Date(clock).toISOString(), occurrences: 2,
    }]);
    expect(new RuntimeDiagnostics(directory, { now: () => clock }).queryIncidents({}).total).toBe(1);
    expect(diagnostics.recordIncident({ ...event, context: { projectId: randomUUID() } })).toBeNull();
  });

  it("does not revive a recovered inactivity episode from late propagation", () => {
    const { diagnostics } = fixture();
    const event = incident({ code: "turn.inactivity", outcome: "observing" });
    diagnostics.recordIncident(event);
    diagnostics.recordIncident({ ...event, outcome: "recovered" });
    expect(diagnostics.recordIncident(event)).toBeNull();
    expect(diagnostics.queryIncidents({}).records[0]).toMatchObject({ outcome: "recovered", occurrences: 1 });
  });

  it("defaults to attention events and filters/paginates the original context newest first", () => {
    const { diagnostics } = fixture();
    const projectId = randomUUID();
    for (let index = 0; index < 5; index += 1) diagnostics.recordIncident(incident({
      code: "turn.failed", outcome: "failed",
      at: new Date(now - index * 1000).toISOString(),
      context: { projectId, providerId: "claude" },
    }));
    diagnostics.recordIncident(incident({ code: "runtime.reconnected", outcome: "recovered" }));
    const first = diagnostics.queryIncidents({ providerId: "claude", projectId, search: "turn", limit: 2 });
    expect(first).toMatchObject({ total: 5, nextOffset: 2 });
    expect(first.records.map((row) => row.at)).toEqual([new Date(now).toISOString(), new Date(now - 1000).toISOString()]);
    const next = diagnostics.queryIncidents({ providerId: "claude", projectId, offset: 2, limit: 2 });
    expect(next.records[0]?.id).not.toBe(first.records[0]?.id);
    expect(diagnostics.queryIncidents({}).total).toBe(5);
    expect(diagnostics.queryIncidents({ severity: "all" }).total).toBe(6);
    expect(diagnostics.queryIncidents({ projectId: randomUUID() }).total).toBe(0);
  });

  it("exports no contextual identifiers or runtime identities while retaining local correlations", () => {
    const { diagnostics } = fixture();
    const event = incident({
      runtimeGeneration: `${randomUUID()}:1`,
      context: { projectId: randomUUID(), conversationId: randomUUID(), turnId: randomUUID(), requestId: randomUUID(), providerId: "codex" },
    });
    diagnostics.recordIncident(event);
    const report = diagnostics.exportIncidents({});
    for (const id of [event.id, event.correlationId, event.runtimeGeneration!, ...Object.values(event.context).filter((value) => value !== "codex")]) {
      expect(report).not.toContain(id);
    }
    expect(report).toContain('"correlation": "incident-1"');
    expect(report).toContain('"provider": "codex"');
  });

  it("keeps bounded memory evidence on disk failure and reports unavailable persistence", () => {
    const { diagnostics } = fixture({ write: () => { throw new Error("SECRET exception text"); } });
    diagnostics.recordIncident(incident());
    expect(() => diagnostics.flushIncidents()).not.toThrow();
    expect(diagnostics.queryIncidents({})).toMatchObject({ total: 1, persistence: "unavailable" });
    expect(diagnostics.exportIncidents({})).not.toContain("SECRET");
  });

  it("enforces bounded retention, queues and rotation", () => {
    let clock = now;
    const { diagnostics, directory } = fixture({ now: () => clock, maxFileBytes: 2048, maxFiles: 2, retentionMs: 1000 });
    for (let index = 0; index < 520; index += 1) diagnostics.recordIncident(incident());
    expect(diagnostics.queryIncidents({}).total).toBe(500);
    expect(diagnostics.queryIncidents({}).dropped).toBeGreaterThan(0);
    diagnostics.flushIncidents();
    expect(readdirSync(directory).filter((name) => name.endsWith(".log")).length).toBeLessThanOrEqual(2);
    clock += 1001;
    expect(diagnostics.queryIncidents({}).total).toBe(0);
    expect(new RuntimeDiagnostics(directory, { now: () => clock, retentionMs: 1000 }).queryIncidents({}).total).toBe(0);
  });

  it("ignores malformed or tampered records and does not follow a diagnostics directory symlink", () => {
    const { diagnostics, directory, root } = fixture();
    diagnostics.recordIncident(incident());
    diagnostics.flushIncidents();
    const original = readFileSync(join(directory, "runtime.log"), "utf8");
    writeFileSync(join(directory, "runtime.log"), `${original.replace("delivery-unknown", "delivery-rejected")}\n{invalid}\n`);
    const tampered = readFileSync(join(directory, "runtime.log"), "utf8");
    expect(new RuntimeDiagnostics(directory, { now: () => now }).queryIncidents({}).total).toBe(0);
    const link = join(root, "redirected");
    symlinkSync(directory, link, "junction");
    const redirected = new RuntimeDiagnostics(link, { now: () => now });
    redirected.recordIncident(incident());
    redirected.flushIncidents();
    expect(redirected.queryIncidents({}).persistence).toBe("unavailable");
    expect(readFileSync(join(directory, "runtime.log"), "utf8")).toBe(tampered);
  });

  it("keeps old lifecycle records readable in support summaries without inventing duplicate incidents", () => {
    const { diagnostics } = fixture();
    diagnostics.record("runtime.failure", { phase: "starting", message: "Runtime startup timed out." });
    expect(diagnostics.queryIncidents({}).total).toBe(0);
    expect(diagnostics.supportReport({ version: "test", platform: "linux", architecture: "x64", runtime: null }).eventCount).toBe(1);
  });
});
