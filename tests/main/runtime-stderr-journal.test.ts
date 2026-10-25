import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_STDERR_CODES } from "../../src/main/runtime-diagnostic-events";
import { RuntimeDiagnostics } from "../../src/main/runtime-diagnostics";
import { attachRuntimeStderr, classifyRuntimeStderrLine, RuntimeStderrJournal } from "../../src/main/runtime-stderr-journal";

afterEach(() => { vi.useRealTimers(); });

function journal(options: Partial<ConstructorParameters<typeof RuntimeStderrJournal>[0]> = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-09T10:00:00.000Z"));
  const record = vi.fn();
  return { record, journal: new RuntimeStderrJournal({ record, ...options }) };
}

describe("runtime stderr capture", () => {
  it("maps known runtime messages to fixed codes without keeping their text", () => {
    expect(classifyRuntimeStderrLine("The scheduled database backup failed.")).toBe("database-backup-failed");
    expect(classifyRuntimeStderrLine("Database migration failed and rolled back source=v1 schema=3 target=4 step=4 category=constraint"))
      .toBe("database-migration-failed");
    expect(classifyRuntimeStderrLine("Git scan cleanup failed after the scan timed out. [E_GIT] /Users/someone/secret-project"))
      .toBe("git-scan-cleanup-failed");
    expect(classifyRuntimeStderrLine("A turn update could not be published. Reconnect to load the saved state.")).toBe("turn-update-unpublished");
    expect(classifyRuntimeStderrLine("prompt=ship the secret roadmap")).toBeNull();
    expect(classifyRuntimeStderrLine("    at Object.<anonymous> (/Users/someone/project/file.ts:1:1)")).toBeNull();
    const h = journal();
    h.journal.write("Git scan cleanup failed after the scan timed out. /Users/someone/secret-project\n");
    expect(h.record).toHaveBeenCalledExactlyOnceWith("git-scan-cleanup-failed", 1);
    expect(JSON.stringify(h.record.mock.calls)).not.toContain("secret");
  });

  it("counts unclassified lines by shape after a short delay", () => {
    const h = journal();
    h.journal.write("Unable to record system suspend accounting. Error: EACCES: permission denied, open '/Users/someone/x'\n");
    h.journal.write("    at open (node:fs:1:1)\n    at write (/Users/someone/app.js:2:2)\n(node:123) Warning: something\n");
    expect(h.record).toHaveBeenCalledExactlyOnceWith("suspend-accounting-failed", 1);
    vi.advanceTimersByTime(5_000);
    expect(h.record.mock.calls).toEqual([
      ["suspend-accounting-failed", 1],
      ["stack-frame", 2],
      ["node-warning:Warning", 1],
    ]);
  });

  it("classifies a Node warning block, stack frames and Chromium logs without keeping any of their text", () => {
    const h = journal();
    const lines = [
      "(node:48213) MaxListenersExceededWarning: Possible EventTarget memory leak detected. 11 abort listeners added to [AbortSignal]. MaxListeners is 10. Use events.setMaxListeners() to increase limit",
      "(Use `Inertia --trace-warnings ...` to show where the warning was created)",
      "    at Query.start (/Users/someone/secret-project/node_modules/harness.js:212:7)",
      "[48213:48219:1025/104512.123456:ERROR:gpu_init.cc(523)] Passthrough is not supported, GL is disabled",
      "[1025/104512.654321:WARNING:sandbox_linux.cc(400)] InitializeSandbox() called with multiple threads",
      "(node:48213) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.",
      "(node:48213) SecretTokenWarning: sk-ant-abc123",
      "SDK debug logs: /Users/someone/.claude/debug/7c9e.txt",
      "Tool name validation warning for \"secret_tool.run\":",
      "{\"token\":\"sk-ant-abc123\",\"prompt\":\"ship the roadmap\"}",
      "prompt=ship the secret roadmap",
    ];
    h.journal.write(`${lines.join("\n")}\n`);
    expect(h.record).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5_000);
    expect(h.record.mock.calls).toEqual([
      ["node-warning:MaxListenersExceededWarning", 1],
      ["node-warning-hint", 1],
      ["stack-frame", 1],
      ["chromium-log:ERROR", 1],
      ["chromium-log:WARNING", 1],
      ["node-warning:DeprecationWarning", 1],
      ["node-warning:other", 1],
      ["sdk-warning", 2],
      ["json", 1],
      ["other", 1],
    ]);
    for (const [code, count] of h.record.mock.calls) {
      expect(RUNTIME_STDERR_CODES).toContain(code);
      expect(Number.isInteger(count)).toBe(true);
    }
    const recorded = JSON.stringify(h.record.mock.calls);
    for (const fragment of [
      "48213", "48219", "AbortSignal", "abort listeners", "setMaxListeners", "Inertia", "trace-warnings",
      "Query.start", "/Users", "someone", "secret", "harness", "gpu_init", "Passthrough", "sandbox_linux",
      "InitializeSandbox", "1025", "DEP0040", "punycode", "SecretToken", "sk-ant", "abc123", "7c9e",
      "debug", "Tool name", "token", "prompt", "roadmap",
    ]) expect(recorded).not.toContain(fragment);
  });

  it("joins lines split across chunks, including multi-byte characters and CRLF endings", () => {
    const h = journal();
    const bytes = Buffer.from("The scheduled database backup failed.\r\nüñ\n", "utf8");
    for (const byte of bytes) h.journal.write(Buffer.from([byte]));
    expect(h.record).toHaveBeenCalledExactlyOnceWith("database-backup-failed", 1);
    h.journal.end();
    expect(h.record).toHaveBeenLastCalledWith("other", 1);
  });

  it("bounds an unterminated line and counts it as one omitted line", () => {
    const h = journal({ maxLineLength: 64 });
    for (let index = 0; index < 1_000; index += 1) h.journal.write("x".repeat(1_024));
    expect(h.journal.bufferedLength()).toBeLessThanOrEqual(64);
    h.journal.write("\nThe scheduled database backup failed.\n");
    expect(h.record).toHaveBeenCalledExactlyOnceWith("database-backup-failed", 1);
    h.journal.end();
    expect(h.record).toHaveBeenLastCalledWith("omitted", 1);
  });

  it("caps records per minute and reports the excess as omitted in the next window", () => {
    const h = journal({ maxRecordsPerWindow: 5 });
    h.journal.write("The scheduled database backup failed.\n".repeat(12));
    expect(h.record).toHaveBeenCalledTimes(5);
    vi.advanceTimersByTime(5_000);
    expect(h.record).toHaveBeenCalledTimes(5);
    vi.advanceTimersByTime(55_000);
    expect(h.record).toHaveBeenLastCalledWith("omitted", 7);
    expect(h.record).toHaveBeenCalledTimes(6);
  });

  it("persists only allowlisted shape codes in the runtime diagnostics journal", () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-stderr-codes-"));
    try {
      const diagnostics = new RuntimeDiagnostics(join(root, "runtime"), {
        now: () => Date.parse("2026-09-09T10:00:00.000Z"),
      });
      diagnostics.record("runtime.stderr", { code: "node-warning:MaxListenersExceededWarning", count: 2 });
      diagnostics.record("runtime.stderr", { code: "chromium-log:ERROR", count: 1 });
      diagnostics.record("runtime.stderr", { code: "node-warning:SecretTokenWarning", count: 1 });
      diagnostics.flushIncidents();
      const records = readFileSync(join(root, "runtime", "runtime.log"), "utf8").trim().split("\n")
        .map((line) => JSON.parse(line) as { event: string; code?: string; count?: number })
        .filter((record) => record.event === "runtime.stderr");
      expect(records.map(({ code, count }) => [code, count])).toEqual([
        ["node-warning:MaxListenersExceededWarning", 2],
        ["chromium-log:ERROR", 1],
      ]);
      expect(diagnostics.query({ severity: "all" }).events.map((entry) => entry.title)).toEqual(expect.arrayContaining([
        "The runtime reported a possible listener leak",
        "The runtime process printed a Chromium error",
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("drains an attached stream and flushes what remains when it ends", async () => {
    const h = journal();
    const stream = new PassThrough();
    attachRuntimeStderr(stream, h.journal);
    const ended = once(stream, "end");
    stream.write("unclassified");
    stream.end();
    await ended;
    expect(h.record).toHaveBeenCalledExactlyOnceWith("other", 1);
  });
});
