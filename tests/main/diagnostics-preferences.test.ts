import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readDiagnosticsPreferences, writeDiagnosticsPreferences } from "../../src/main/diagnostics-preferences";
import { openRuntimeDiagnostics } from "../../src/main/diagnostics-main-ipc";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "inertia-diagnostics-preferences-"));
  directories.push(path);
  return path;
}
const file = "diagnostics-preferences.json";

it("persists the capture choice privately and replaces it without leaving temporary files", () => {
  const root = directory();
  expect(readDiagnosticsPreferences(root)).toBeNull();
  writeDiagnosticsPreferences(root, { enabled: false, since: "2026-09-09T10:00:00.000Z" });
  expect(readDiagnosticsPreferences(root)).toEqual({ enabled: false, since: "2026-09-09T10:00:00.000Z" });
  writeDiagnosticsPreferences(root, { enabled: true, since: "2026-09-09T11:00:00.000Z" });
  expect(readDiagnosticsPreferences(root)).toEqual({ enabled: true, since: "2026-09-09T11:00:00.000Z" });
  expect(readdirSync(root)).toEqual([file]);
  if (process.platform !== "win32") expect(lstatSync(join(root, file)).mode & 0o777).toBe(0o600);
});

it("reports malformed, non-strict and oversized preference files as unreadable", () => {
  const root = directory();
  for (const content of [
    "not json",
    JSON.stringify({ enabled: "no", since: null }),
    JSON.stringify({ enabled: false, since: "yesterday" }),
    JSON.stringify({ enabled: false, since: null, path: "/private" }),
    JSON.stringify({ enabled: false, since: null, padding: "x".repeat(600) }),
  ]) {
    writeFileSync(join(root, file), content);
    expect(readDiagnosticsPreferences(root)).toBe("unreadable");
  }
  expect(() => writeDiagnosticsPreferences(root, { enabled: "off" } as never)).toThrow("Invalid diagnostics settings.");
});

it("opens the journal with the saved capture choice, defaulting to on", () => {
  const root = directory();
  expect(openRuntimeDiagnostics(root).captureState()).toEqual({ enabled: true, since: null });
  writeDiagnosticsPreferences(root, { enabled: false, since: "2026-09-09T10:00:00.000Z" });
  const diagnostics = openRuntimeDiagnostics(root);
  expect(diagnostics.captureState()).toEqual({ enabled: false, since: "2026-09-09T10:00:00.000Z" });
  expect(diagnostics.directory).toBe(join(root, "logs", "runtime"));
});

it("removes a temporary preference file left by an interrupted write when the journal opens", () => {
  const root = directory();
  const leftover = join(root, ".diagnostics-preferences-3f1d2c4b-5a6e-4f70-8a9b-0c1d2e3f4a5b.json");
  writeFileSync(leftover, "{\"enabled\":");
  writeFileSync(join(root, "unrelated.json"), "keep");
  openRuntimeDiagnostics(root);
  expect(readdirSync(root).sort()).toEqual(["unrelated.json"]);
});

it.skipIf(process.platform === "win32")("does not follow a preferences symlink", () => {
  const root = directory();
  const outside = join(root, "outside.json");
  writeFileSync(outside, JSON.stringify({ enabled: false, since: null }));
  symlinkSync(outside, join(root, file));
  expect(readDiagnosticsPreferences(root)).toBe("unreadable");
  expect(() => writeDiagnosticsPreferences(root, { enabled: true, since: null })).toThrow("unavailable");
  expect(JSON.parse(readFileSync(outside, "utf8"))).toEqual({ enabled: false, since: null });
});

function journalEvents(path: string): string[] {
  const journal = join(path, "runtime.log");
  if (!existsSync(journal)) return [];
  return readFileSync(journal, "utf8").trim().split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { event: string }).event);
}

it("turns capture on with no marker when the preference file is missing", () => {
  const root = directory();
  const diagnostics = openRuntimeDiagnostics(root);
  expect(diagnostics.captureState()).toEqual({ enabled: true, since: null });
  expect(journalEvents(diagnostics.directory)).toEqual([]);
});

it.each([
  ["corrupt", "{\"enabled\":"],
  ["tampered", JSON.stringify({ enabled: "false", since: null })],
  ["oversized", JSON.stringify({ enabled: true, since: null, padding: "x".repeat(600) })],
])("keeps capture off and records why when the preference file is %s", (_name, content) => {
  const root = directory();
  writeFileSync(join(root, file), content);
  const diagnostics = openRuntimeDiagnostics(root);
  expect(diagnostics.captureState()).toEqual({ enabled: false, since: null });
  diagnostics.record("runtime.state", { phase: "ready", generation: 1 });
  expect(journalEvents(diagnostics.directory)).toEqual(["diagnostics.preferences-unreadable"]);
});

it.skipIf(process.platform === "win32")("keeps capture off when the preference file is a symlink or cannot be read", () => {
  const root = directory();
  writeFileSync(join(root, "outside.json"), JSON.stringify({ enabled: true, since: null }));
  symlinkSync(join(root, "outside.json"), join(root, file));
  expect(openRuntimeDiagnostics(root).captureState().enabled).toBe(false);
  rmSync(join(root, file));
  writeFileSync(join(root, file), JSON.stringify({ enabled: true, since: null }));
  chmodSync(join(root, file), 0o000);
  try {
    if (process.getuid?.() !== 0) expect(openRuntimeDiagnostics(root).captureState().enabled).toBe(false);
  } finally { chmodSync(join(root, file), 0o600); }
});

it("syncs the directory after the new preference file is in place", () => {
  const root = directory();
  const synced: unknown[] = [];
  writeDiagnosticsPreferences(root, { enabled: false, since: null }, (path) => {
    synced.push(path, readDiagnosticsPreferences(root));
  });
  expect(synced).toEqual([realpathSync(root), { enabled: false, since: null }]);
});
