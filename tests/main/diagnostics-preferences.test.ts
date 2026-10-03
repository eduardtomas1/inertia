import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

it("rejects malformed, non-strict and oversized preference files", () => {
  const root = directory();
  for (const content of [
    "not json",
    JSON.stringify({ enabled: "no", since: null }),
    JSON.stringify({ enabled: false, since: "yesterday" }),
    JSON.stringify({ enabled: false, since: null, path: "/private" }),
    JSON.stringify({ enabled: false, since: null, padding: "x".repeat(600) }),
  ]) {
    writeFileSync(join(root, file), content);
    expect(readDiagnosticsPreferences(root)).toBeNull();
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
  expect(readDiagnosticsPreferences(root)).toBeNull();
  expect(() => writeDiagnosticsPreferences(root, { enabled: true, since: null })).toThrow("unavailable");
  expect(JSON.parse(readFileSync(outside, "utf8"))).toEqual({ enabled: false, since: null });
});
