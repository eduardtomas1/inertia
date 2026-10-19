import { describe, expect, it } from "vitest";

import {
  LINE_CUT_MARKER,
  TailTextBuffer,
  utf8ByteLength,
  utf8Prefix,
} from "../../src/server/tail-text-buffer";

type Stream = "stdout" | "stderr" | "inertia";

function buffer(overrides: Partial<{ maxBytes: number; maxLines: number; maxLineBytes: number }> = {}) {
  return new TailTextBuffer<Stream>({ maxBytes: 64 * 1024, maxLines: 2_000, maxLineBytes: 4 * 1024, ...overrides });
}

function texts(target: TailTextBuffer<Stream>): string[] {
  return target.read({ limit: 10_000, maxBytes: Number.MAX_SAFE_INTEGER }).lines.map(({ text }) => text);
}

describe("TailTextBuffer", () => {
  it("commits only complete lines per stream and tags each with its stream", () => {
    const logs = buffer();
    logs.append("stdout", "hello ");
    logs.append("stderr", "warn");
    logs.append("stdout", "world\nnext");
    expect(logs.read({ limit: 10, maxBytes: 4_096 }).lines).toEqual([
      { cursor: 1, stream: "stdout", text: "hello world" },
    ]);
    logs.append("stderr", "ing\n");
    logs.flush();
    expect(logs.read({ limit: 10, maxBytes: 4_096 }).lines).toEqual([
      { cursor: 1, stream: "stdout", text: "hello world" },
      { cursor: 2, stream: "stderr", text: "warning" },
      { cursor: 3, stream: "stdout", text: "next" },
    ]);
  });

  it("never splits a UTF-16 surrogate pair across chunks or cuts", () => {
    const logs = buffer();
    const emoji = "\u{1F600}";
    logs.append("stdout", `a${emoji[0]}`);
    logs.append("stdout", `${emoji[1]}b\n`);
    expect(texts(logs)).toEqual([`a${emoji}b`]);

    logs.append("stdout", "lone \ud800 high and \udc00 low\n");
    expect(texts(logs).at(-1)).toBe("lone � high and � low");

    const cut = buffer({ maxLineBytes: 64 });
    cut.append("stdout", `${emoji.repeat(40)}\n`);
    const [line] = texts(cut);
    expect(line!.endsWith(LINE_CUT_MARKER)).toBe(true);
    expect(utf8ByteLength(line!)).toBeLessThanOrEqual(64);
    expect(line!.slice(0, -LINE_CUT_MARKER.length)).toBe(emoji.repeat(13));
    expect(line!).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
    expect(utf8Prefix(`x${emoji}`, 4)).toBe("x");
  });

  it("cuts an over-long line once with a marker and drops its rest up to the newline", () => {
    const logs = buffer({ maxLineBytes: 4 * 1024 });
    logs.append("stdout", "x".repeat(3_000));
    logs.append("stdout", "y".repeat(3_000));
    logs.append("stdout", "z".repeat(3_000));
    logs.append("stdout", "\nafter\n");
    const lines = texts(logs);
    expect(lines).toHaveLength(2);
    expect(utf8ByteLength(lines[0]!)).toBe(4 * 1024);
    expect(lines[0]).toBe(`${"x".repeat(3_000)}${"y".repeat(4 * 1024 - 3_000 - LINE_CUT_MARKER.length)}${LINE_CUT_MARKER}`);
    expect(lines[1]).toBe("after");
  });

  it("bounds retained text by bytes and by lines, evicting the oldest first", () => {
    const byBytes = buffer({ maxBytes: 100, maxLineBytes: 50 });
    for (let index = 0; index < 20; index += 1) byBytes.append("stdout", `${String(index).padStart(9, "0")}\n`);
    expect(byBytes.byteLength).toBeLessThanOrEqual(100);
    expect(texts(byBytes)).toEqual(Array.from({ length: 11 }, (_, index) => String(index + 9).padStart(9, "0")));
    expect(byBytes.droppedLines).toBe(9);

    const byLines = buffer({ maxLines: 3 });
    for (let index = 1; index <= 5; index += 1) byLines.append("stderr", `line ${index}\n`);
    expect(texts(byLines)).toEqual(["line 3", "line 4", "line 5"]);
    expect(byLines.lineCount).toBe(3);
  });

  it("keeps cursors strictly increasing and never reuses one after eviction", () => {
    const logs = buffer({ maxLines: 2 });
    const seen: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      logs.append("stdout", `${index}\n`);
      seen.push(logs.latestCursor);
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const read = logs.read({ after: 3, limit: 10, maxBytes: 4_096 });
    expect(read.lines.map(({ cursor }) => cursor)).toEqual([9, 10]);
    expect(read.dropped).toBe(5);
    expect(read.nextCursor).toBe(10);
    expect(logs.read({ after: 10, limit: 10, maxBytes: 4_096 })).toEqual({ lines: [], nextCursor: 10, omitted: 0, dropped: 0 });
    expect(logs.read({ after: 99, limit: 10, maxBytes: 4_096 }).nextCursor).toBe(10);
  });

  it("pages forward by cursor within line and byte limits and filters literally ignoring case", () => {
    const logs = buffer();
    for (let index = 1; index <= 6; index += 1) logs.append("stdout", `${index % 2 ? "Error" : "ok"} ${index} (.*)\n`);
    const first = logs.read({ after: 0, limit: 2, maxBytes: 4_096 });
    expect(first.lines.map(({ cursor }) => cursor)).toEqual([1, 2]);
    expect(first).toMatchObject({ nextCursor: 2, omitted: 4 });
    const second = logs.read({ after: first.nextCursor, limit: 2, maxBytes: 4_096 });
    expect(second.lines.map(({ cursor }) => cursor)).toEqual([3, 4]);

    const grep = logs.read({ after: 0, limit: 10, maxBytes: 4_096, grep: "error" });
    expect(grep.lines.map(({ text }) => text)).toEqual(["Error 1 (.*)", "Error 3 (.*)", "Error 5 (.*)"]);
    expect(grep.nextCursor).toBe(6);
    expect(logs.read({ limit: 10, maxBytes: 4_096, grep: "(.*)" }).lines).toHaveLength(6);

    const tight = logs.read({ after: 0, limit: 10, maxBytes: 12 });
    expect(tight.lines).toHaveLength(1);
    expect(tight.nextCursor).toBe(1);
  });

  it("returns the newest lines in order when asked for the tail", () => {
    const logs = buffer();
    for (let index = 1; index <= 5; index += 1) logs.append("stdout", `line ${index}\n`);
    const tail = logs.read({ limit: 2, maxBytes: 4_096, prefer: "newest" });
    expect(tail.lines.map(({ text }) => text)).toEqual(["line 4", "line 5"]);
    expect(tail).toMatchObject({ nextCursor: 5, omitted: 3, dropped: 0 });
    expect(logs.tail(3).map(({ cursor }) => cursor)).toEqual([3, 4, 5]);
  });

  it("strips control characters and whole escape sequences but keeps tabs", () => {
    const logs = buffer();
    logs.append("stdout", "\u001b[31mred\u001b[0m\tcol\u0007\u0000\r\n");
    logs.append("stdout", "split \u001b[");
    logs.append("stdout", "1;32mgreen\u001b]0;title\u0007 done\n");
    logs.append("stdout", "c1\u0085\u009b ok\n");
    expect(texts(logs)).toEqual(["red\tcol", "split green done", "c1 ok"]);
    for (const text of texts(logs)) expect(text).not.toMatch(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/u);
  });

  it("commits Inertia's own whole lines without disturbing partial stream lines", () => {
    const logs = buffer();
    logs.append("stdout", "partial");
    logs.appendLine("inertia", "Exited\nwith code 1.");
    logs.flush("stdout");
    expect(logs.read({ limit: 10, maxBytes: 4_096 }).lines).toEqual([
      { cursor: 1, stream: "inertia", text: "Exited with code 1." },
      { cursor: 2, stream: "stdout", text: "partial" },
    ]);
  });

  it("skips blank and whitespace-only lines without spending a cursor on them", () => {
    const logs = buffer();
    logs.append("stderr", "\n");
    logs.append("stderr", "  \t \r\n\u001b[31m\u001b[0m\n");
    logs.append("stdout", "ready\n\n");
    logs.appendLine("inertia", "   ");
    logs.append("stderr", " ");
    logs.flush();
    expect(logs.read({ limit: 10, maxBytes: 4_096 }).lines).toEqual([{ cursor: 1, stream: "stdout", text: "ready" }]);
    expect(logs.latestCursor).toBe(1);
    // Leading indentation on a line with content is kept.
    logs.append("stdout", "  at main (index.js:1)\n");
    expect(logs.tail(1)).toEqual([{ cursor: 2, stream: "stdout", text: "  at main (index.js:1)" }]);
  });

  it("redacts each whole line once before committing it, and bounds the result again", () => {
    const seen: Array<[string, boolean]> = [];
    const ring = new TailTextBuffer<Stream>({
      maxBytes: 1_024,
      maxLines: 10,
      maxLineBytes: 40,
      redact: (text, cut) => {
        seen.push([text, cut]);
        return text.replaceAll("pw", "[a much longer replacement]");
      },
    });
    // A value split across chunks is seen whole.
    ring.append("stdout", "user p");
    ring.append("stdout", "w ok\n");
    ring.appendLine("inertia", "no secret here");
    ring.append("stderr", `pw ${"x".repeat(60)}\n`);
    expect(seen).toEqual([
      ["user pw ok", false],
      ["no secret here", false],
      [`pw ${"x".repeat(40 - LINE_CUT_MARKER.length - 3)}`, true],
    ]);
    const lines = ring.read({ limit: 10, maxBytes: 1_024 }).lines;
    const room = 40 - LINE_CUT_MARKER.length;
    expect(lines.map(({ text }) => text)).toEqual([
      `${"user [a much longer replacement] ok".slice(0, room)}${LINE_CUT_MARKER}`,
      "no secret here",
      `${`[a much longer replacement] ${"x".repeat(26)}`.slice(0, room)}${LINE_CUT_MARKER}`,
    ]);
    for (const line of lines) expect(utf8ByteLength(line.text)).toBeLessThanOrEqual(40);
    expect(lines[0]!.text.endsWith(LINE_CUT_MARKER)).toBe(true);
    expect(ring.byteLength).toBe(lines.reduce((total, { text }) => total + utf8ByteLength(text), 0));
  });

  it("rejects bounds that cannot hold one cut line", () => {
    expect(() => buffer({ maxLineBytes: 4 })).toThrow("invalid");
    expect(() => buffer({ maxBytes: 100, maxLineBytes: 200 })).toThrow("invalid");
  });
});
