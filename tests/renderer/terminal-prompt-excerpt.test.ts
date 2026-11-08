import { describe, expect, it, vi } from "vitest";

import {
  MAX_TERMINAL_PROMPT_BYTES,
  MAX_TERMINAL_PROMPT_LINES,
  terminalPromptExcerpt,
} from "../../src/renderer/src/utils/terminalPromptExcerpt";

const bodyOf = (text: string): string => text.split("\n").slice(2, -1).join("\n");

describe("terminalPromptExcerpt", () => {
  it("adds a one-line header and a fenced block", () => {
    expect(terminalPromptExcerpt("$ npm test\r\nFAIL src/app.test.ts  \r\n\n", "Terminal 2")).toEqual({
      text: "Terminal output (Terminal 2):\n```text\n$ npm test\nFAIL src/app.test.ts\n```",
      includedLines: 2,
      totalLines: 2,
      trimmed: false,
    });
  });

  it("returns nothing for an empty or whitespace selection", () => {
    expect(terminalPromptExcerpt("", "Terminal 1")).toBeNull();
    expect(terminalPromptExcerpt(" \n\t\n", "Terminal 1")).toBeNull();
  });

  it("strips escape sequences and control characters", () => {
    const excerpt = terminalPromptExcerpt(
      "\u001b[31mred\u001b[0m \u001b]0;title\u0007ok\u0008\u009b1mbold\u0000",
      "Terminal 1",
    )!;
    expect(bodyOf(excerpt.text)).toBe("red okbold");
  });

  it("uses a fence longer than any backtick run in the output", () => {
    const excerpt = terminalPromptExcerpt("```js\nalert(1)\n```\n````", "Terminal 1")!;
    expect(excerpt.text.split("\n")[1]).toBe("`````text");
    expect(excerpt.text.endsWith("\n`````")).toBe(true);
  });

  it("keeps the last 200 lines and says so", () => {
    const lines = Array.from({ length: 350 }, (_, index) => `line ${index + 1}`);
    const excerpt = terminalPromptExcerpt(lines.join("\n"), "Terminal 3")!;
    expect(excerpt.text.split("\n")[0]).toBe(
      `Terminal output (Terminal 3, last ${MAX_TERMINAL_PROMPT_LINES} of 350 lines):`,
    );
    expect(bodyOf(excerpt.text).split("\n")).toEqual(lines.slice(-MAX_TERMINAL_PROMPT_LINES));
    expect(excerpt).toMatchObject({ includedLines: 200, totalLines: 350, trimmed: true });
  });

  it("keeps at most 8 KiB of output by whole lines", () => {
    const lines = Array.from({ length: 100 }, (_, index) => `${String(index).padStart(3, "0")} ${"é".repeat(60)}`);
    const excerpt = terminalPromptExcerpt(lines.join("\n"), "Terminal 1")!;
    const body = bodyOf(excerpt.text);
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(MAX_TERMINAL_PROMPT_BYTES);
    expect(body.split("\n").at(-1)).toBe(lines.at(-1));
    expect(lines).toContain(body.split("\n")[0]);
    expect(excerpt.text.split("\n")[0]).toBe(
      `Terminal output (Terminal 1, last ${excerpt.includedLines} of 100 lines):`,
    );
  });

  it("shortens a single oversized line from its start without splitting characters", () => {
    const line = `start ${"😀".repeat(3_000)} end`;
    const excerpt = terminalPromptExcerpt(line, "Terminal 1")!;
    const body = bodyOf(excerpt.text);
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(MAX_TERMINAL_PROMPT_BYTES);
    expect(body.endsWith(" end")).toBe(true);
    expect(body).not.toContain("�");
    expect(body.codePointAt(0)).toBe(0x1f600);
    expect(excerpt.text.split("\n")[0]).toBe("Terminal output (Terminal 1, last 8 KiB of 1 line):");
  });

  it("keeps the header to one plain line", () => {
    const excerpt = terminalPromptExcerpt("ok", "Build\n```\u001b[31m  tab")!;
    expect(excerpt.text.split("\n")[0]).toBe("Terminal output (Build ``` [31m tab):");
    expect(terminalPromptExcerpt("ok", "")!.text.split("\n")[0]).toBe("Terminal output (Terminal):");
  });

  it("measures each kept line once and trims to the same lines as joining would", () => {
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    const lines = Array.from({ length: 199 }, (_, index) => `${"é".repeat(40)} line ${index} ${"🙂".repeat(index % 7)}`);
    const selection = [...lines, "x".repeat(4_000)].join("\n");
    const excerpt = terminalPromptExcerpt(selection)!;
    const encodings = encode.mock.calls.length;
    encode.mockRestore();
    expect(encodings).toBeLessThanOrEqual(MAX_TERMINAL_PROMPT_LINES + 1);

    const all = selection.split("\n").map((line) => line.trimEnd());
    const bytes = (from: number): number => new TextEncoder().encode(all.slice(from).join("\n")).byteLength;
    let start = 0;
    while (all.length - start > 1 && bytes(start) > MAX_TERMINAL_PROMPT_BYTES) start += 1;
    expect(start).toBeGreaterThan(0);
    expect(bodyOf(excerpt.text).split("\n")).toEqual(all.slice(start));
    expect(bytes(start)).toBeLessThanOrEqual(MAX_TERMINAL_PROMPT_BYTES);
    expect(bytes(start - 1)).toBeGreaterThan(MAX_TERMINAL_PROMPT_BYTES);
    expect(excerpt.text.split("\n")[0]).toBe(
      `Terminal output (Terminal, last ${all.length - start} of 200 lines):`,
    );
  });
});
