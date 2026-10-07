import { describe, expect, it } from "vitest";

import { reversalText } from "../../src/server/git/reversal";
import { alignedLineEndings } from "../../src/server/git/reversal-files";
import { parseUnifiedDiff } from "../../src/shared/diff-review";

const patch = [
  "diff --git a/example.txt b/example.txt",
  "--- a/example.txt",
  "+++ b/example.txt",
  "@@ -1,3 +1,2 @@",
  " alpha",
  " beta",
  "-gamma",
  "",
].join("\n");

const current = Buffer.from("alpha\nbeta\n");
const original = Buffer.from("alpha\nbeta\ngamma\n");

function deletion() {
  const line = parseUnifiedDiff(patch).files[0]!.hunks[0]!.lines[2]!;
  expect(line).toMatchObject({ kind: "deletion", content: "gamma", newInsertionIndex: 2 });
  return line;
}

describe("selected line reversal text", () => {
  it("restores a deletion after its preceding hunk line", () => {
    const line = deletion();

    expect(reversalText(current, [line], new Map([[line.id, "beta"]]), original).toString("utf8"))
      .toBe("alpha\nbeta\ngamma\n");
  });

  it("refuses to restore a deletion whose preceding hunk line is elsewhere", () => {
    const line = { ...deletion(), newInsertionIndex: 1 };

    expect(() => reversalText(current, [line], new Map([[line.id, "beta"]]), original))
      .toThrow(/no longer match/iu);
  });
});

describe("committed content line-ending alignment", () => {
  it("converts an LF-only committed file to CRLF when the working copy is CRLF throughout", () => {
    expect(alignedLineEndings(Buffer.from("a\nb\n"), Buffer.from("a\r\nc\r\n")).toString()).toBe("a\r\nb\r\n");
  });

  it("leaves mixed, CRLF or binary-free committed content alone", () => {
    expect(alignedLineEndings(Buffer.from("a\nb\n"), Buffer.from("a\r\nb\nc\r\n")).toString()).toBe("a\nb\n");
    expect(alignedLineEndings(Buffer.from("a\r\nb\n"), Buffer.from("a\r\nc\r\n")).toString()).toBe("a\r\nb\n");
    expect(alignedLineEndings(Buffer.from("a\nb\n"), Buffer.from("a\nc\n")).toString()).toBe("a\nb\n");
    expect(alignedLineEndings(Buffer.from("no newline"), Buffer.from("a\r\n")).toString()).toBe("no newline");
  });
});
