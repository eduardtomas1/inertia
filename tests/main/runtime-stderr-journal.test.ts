import { once } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("counts unclassified lines and stack frames as one omitted entry after a short delay", () => {
    const h = journal();
    h.journal.write("Unable to record system suspend accounting. Error: EACCES: permission denied, open '/Users/someone/x'\n");
    h.journal.write("    at open (node:fs:1:1)\n    at write (/Users/someone/app.js:2:2)\n(node:123) Warning: something\n");
    expect(h.record).toHaveBeenCalledExactlyOnceWith("suspend-accounting-failed", 1);
    vi.advanceTimersByTime(5_000);
    expect(h.record).toHaveBeenLastCalledWith("omitted", 3);
    expect(h.record).toHaveBeenCalledTimes(2);
  });

  it("joins lines split across chunks, including multi-byte characters and CRLF endings", () => {
    const h = journal();
    const bytes = Buffer.from("The scheduled database backup failed.\r\nüñ\n", "utf8");
    for (const byte of bytes) h.journal.write(Buffer.from([byte]));
    expect(h.record).toHaveBeenCalledExactlyOnceWith("database-backup-failed", 1);
    h.journal.end();
    expect(h.record).toHaveBeenLastCalledWith("omitted", 1);
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

  it("drains an attached stream and flushes what remains when it ends", async () => {
    const h = journal();
    const stream = new PassThrough();
    attachRuntimeStderr(stream, h.journal);
    const ended = once(stream, "end");
    stream.write("unclassified");
    stream.end();
    await ended;
    expect(h.record).toHaveBeenCalledExactlyOnceWith("omitted", 1);
  });
});
