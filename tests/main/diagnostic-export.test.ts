import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportDiagnosticReport, exportDiagnosticsForReport, setDiagnosticsReportSource } from "../../src/main/diagnostic-export";
import { RuntimeDiagnostics } from "../../src/main/runtime-diagnostics";
import { DIAGNOSTIC_LIMITS, type DiagnosticIncident } from "../../src/shared/application-diagnostics";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "inertia-diagnostic-export-")); roots.push(root); return root; }

it("writes main-generated JSON atomically to the selected file, with private permissions and no staging leftovers", async () => {
  const root = await fixture(); const path = join(root, "report.json");
  await writeFile(path, "previous report");
  await expect(exportDiagnosticReport('{"records":[]}', async () => path)).resolves.toEqual({ status: "exported" });
  expect(await readFile(path, "utf8")).toBe('{"records":[]}');
  expect(await readdir(root)).toEqual(["report.json"]);
  if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it("treats picker cancellation as cancellation, bounds content before opening the picker, and preserves an unwritable target", async () => {
  const choosePath = vi.fn(async () => null);
  await expect(exportDiagnosticReport("{}", choosePath)).resolves.toEqual({ status: "cancelled" });
  await expect(exportDiagnosticReport("x".repeat(DIAGNOSTIC_LIMITS.exportBytes + 1), choosePath)).rejects.toThrow("size limit");
  expect(choosePath).toHaveBeenCalledOnce();
  const root = await fixture();
  await expect(exportDiagnosticReport("{}", async () => root)).rejects.toThrow("regular file");
  expect(await readdir(root)).toEqual([]);
});

it.skipIf(process.platform === "win32")("refuses a symbolic-link destination without touching its target", async () => {
  const root = await fixture(); const target = join(root, "keep.json"); const link = join(root, "link.json");
  await writeFile(target, "keep unchanged"); await symlink(target, link);
  await expect(exportDiagnosticReport("{}", async () => link)).rejects.toThrow("not a link");
  expect(await readFile(target, "utf8")).toBe("keep unchanged");
});

describe("diagnostics export for an issue report", () => {
  const now = Date.parse("2026-09-09T10:00:00.000Z");
  const projectId = "00000000-0000-4000-8000-000000000100";
  const conversationId = "00000000-0000-4000-8000-000000000101";
  afterEach(() => setDiagnosticsReportSource(null));
  function incident(minutesAgo: number): DiagnosticIncident {
    const id = randomUUID();
    return { schemaVersion: 1, id, correlationId: id, code: "discord.delivery-unknown",
      at: new Date(now - minutesAgo * 60_000).toISOString(), runtimeGeneration: null, outcome: "unknown",
      context: { projectId, conversationId, providerId: "claude" }, metadata: {} };
  }
  async function journal(): Promise<RuntimeDiagnostics> {
    const diagnostics = new RuntimeDiagnostics(join(await fixture(), "runtime"), { now: () => now });
    setDiagnosticsReportSource(() => diagnostics);
    return diagnostics;
  }

  it("returns an empty string when no journal is available or nothing was captured since the cutoff", async () => {
    await expect(exportDiagnosticsForReport({ sinceMs: now - 60_000, maxBytes: 64 * 1_024 })).resolves.toBe("");
    const diagnostics = await journal();
    diagnostics.recordIncident(incident(120));
    await expect(exportDiagnosticsForReport({ sinceMs: now - 60 * 60_000, maxBytes: 64 * 1_024 })).resolves.toBe("");
  });

  it("pseudonymises incidents at or after the sinceMs epoch time like the user-facing export", async () => {
    const diagnostics = await journal();
    const old = incident(120);
    const recent = incident(5);
    diagnostics.recordIncident(old);
    diagnostics.recordIncident(recent);
    const text = await exportDiagnosticsForReport({ sinceMs: now - 60 * 60_000, maxBytes: 64 * 1_024 });
    const report = JSON.parse(text) as { records: { code: string; id: string; provider?: string }[] };
    expect(report.records).toHaveLength(1);
    expect(report.records[0]).toMatchObject({ code: "discord.delivery-unknown", id: "incident-1", provider: "claude" });
    for (const value of [old.id, recent.id, projectId, conversationId]) expect(text).not.toContain(value);
  });

  it("keeps the newest incidents within maxBytes and returns nothing when even one does not fit", async () => {
    const diagnostics = await journal();
    const incidents = Array.from({ length: 12 }, (_, index) => incident(index));
    for (const value of incidents) diagnostics.recordIncident(value);
    const full = await exportDiagnosticsForReport({ sinceMs: now - 60 * 60_000, maxBytes: 512 * 1_024 });
    const limit = Math.floor(Buffer.byteLength(full) / 2);
    const bounded = await exportDiagnosticsForReport({ sinceMs: now - 60 * 60_000, maxBytes: limit });
    expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(limit);
    const records = (JSON.parse(bounded) as { records: { at: string }[] }).records;
    expect(records.length).toBeGreaterThan(0);
    expect(records.length).toBeLessThan(12);
    expect(records[0]!.at).toBe(incidents[0]!.at);
    await expect(exportDiagnosticsForReport({ sinceMs: now - 60 * 60_000, maxBytes: 200 })).resolves.toBe("");
  });

  it("rejects an invalid cutoff or size bound", async () => {
    await journal();
    await expect(exportDiagnosticsForReport({ sinceMs: Number.NaN, maxBytes: 1_024 })).rejects.toThrow();
    await expect(exportDiagnosticsForReport({ sinceMs: now, maxBytes: 0 })).rejects.toThrow();
  });
});
