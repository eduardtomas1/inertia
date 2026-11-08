import { describe, expect, it } from "vitest";

import {
  buildFileSelectionPrompt,
  contentSnippetParts,
  markdownFenceFor,
  MAX_FILE_SELECTION_PROMPT_BYTES,
  nextFilePreviewSelection,
} from "../../src/renderer/src/utils/filePreviewSelection";

describe("file preview selection prompts", () => {
  it("uses a fence longer than any backtick run", () => {
    expect(markdownFenceFor("plain")).toBe("```");
    expect(markdownFenceFor("a ``` b")).toBe("````");
    expect(markdownFenceFor("``````")).toBe("```````");
  });

  it("strips CRLF carriage returns and names a single line", () => {
    expect(buildFileSelectionPrompt({
      path: "src/win.ts",
      lines: ["a\r", "b\r", "c"],
      start: 2,
      end: 2,
      mode: "add",
    })).toEqual({
      text: "src/win.ts line 2:\n```\nb\n```",
      includedEnd: 2,
      trimmed: false,
    });
  });

  it("trims to 16 KiB on whole lines and cuts an oversized single line on a code point", () => {
    const line = "é".repeat(5_000);
    const prompt = buildFileSelectionPrompt({
      path: "big.txt",
      lines: [line, line, line],
      start: 1,
      end: 3,
      mode: "add",
    });
    expect(prompt.trimmed).toBe(true);
    expect(prompt.includedEnd).toBe(1);
    expect(prompt.text).toContain("big.txt lines 1-3:");
    expect(prompt.text).toContain("(Excerpt trimmed to line 1 of the selection; limit 300 lines or 16 KiB.)");

    const single = buildFileSelectionPrompt({
      path: "huge.txt",
      lines: ["€".repeat(10_000)],
      start: 1,
      end: 1,
      mode: "ask",
    });
    const excerpt = single.text.split("\n")[2] ?? "";
    expect(new TextEncoder().encode(excerpt).byteLength)
      .toBeLessThanOrEqual(MAX_FILE_SELECTION_PROMPT_BYTES);
    expect(excerpt).toMatch(/^€+$/u);
    expect(single.trimmed).toBe(true);
    expect(single.text.endsWith("KiB.)\n\n")).toBe(true);
  });

  it("rejects ranges outside the loaded lines and clamps selections", () => {
    expect(() => buildFileSelectionPrompt({
      path: "a.ts", lines: ["x"], start: 2, end: 3, mode: "add",
    })).toThrow("Select lines inside the loaded preview.");
    const first = nextFilePreviewSelection(null, "id", 8, false, 5);
    expect(first).toEqual({ identity: "id", anchor: 5, start: 5, end: 5 });
    expect(nextFilePreviewSelection(first, "id", 2, true, 5))
      .toEqual({ identity: "id", anchor: 5, start: 2, end: 5 });
    expect(nextFilePreviewSelection(first, "other", 2, true, 5))
      .toEqual({ identity: "other", anchor: 2, start: 2, end: 2 });
    expect(nextFilePreviewSelection(first, "id", 1, false, 0)).toBeNull();
  });

  it("highlights the first case-insensitive occurrence in a snippet", () => {
    expect(contentSnippetParts("let Needle = needle", "needle"))
      .toEqual(["let ", "Needle", " = needle"]);
    expect(contentSnippetParts("nothing", "needle")).toBeNull();
  });
});
