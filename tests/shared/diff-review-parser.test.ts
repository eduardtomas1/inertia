import { describe, expect, it } from "vitest";

import {
  diffFileFingerprint,
  diffHunkFingerprint,
  parseUnifiedDiff,
  sha256,
} from "../../src/shared/diff-review";

const representative = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 1111111..2222222 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,3 +1,4 @@ export function answer() {",
  " export function answer() {",
  "-  return 41;",
  "+  const value = 42;",
  "+  return value;",
  " }",
  "@@ -10,2 +11,2 @@",
  " tail",
  "-old end",
  "\\ No newline at end of file",
  "+new end",
  "\\ No newline at end of file",
  "diff --git a/old name.txt b/new name.txt",
  "similarity index 90%",
  "rename from old name.txt",
  "rename to new name.txt",
  "--- a/old name.txt\t",
  "+++ b/new name.txt\t",
  "@@ -1 +1 @@",
  "-before",
  "+after",
  "diff --git \"a/quoted\\tname.txt\" \"b/quoted\\tname.txt\"",
  "--- \"a/quoted\\tname.txt\"",
  "+++ \"b/quoted\\tname.txt\"",
  "@@ -1,0 +1 @@",
  "+added",
  "diff --git a/image.png b/image.png",
  "Binary files a/image.png and b/image.png differ",
  "diff --git a/gone.txt b/gone.txt",
  "deleted file mode 100644",
  "--- a/gone.txt",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-first",
  "-second",
  "diff --git a/untracked.txt b/untracked.txt",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/untracked.txt",
  "@@ -0,0 +1,2 @@",
  "+one",
  "+two",
  "Unable to preview untracked file other.txt.",
  "",
].join("\n");

function fingerprints(patch: string): string[] {
  return parseUnifiedDiff(patch).files.flatMap((file) => [
    diffFileFingerprint(file),
    ...file.hunks.map((hunk) => diffHunkFingerprint(file, hunk)),
  ]);
}

describe("unified diff parsing", () => {
  it("keeps review fingerprints stable for diffs that already parsed correctly", () => {
    expect(fingerprints(representative)).toEqual([
      "04e6cd1bb88c6fd9ee49c826c6e9194020334fc7f5cb2cb24310667eb1daf499",
      "7172a05f6a2fe02727ce47da566d232581399a7935bbebc8dea7c0bd9e486561",
      "1bb1f90abb309415d7474a2ede8ec33269766e52bce8757821dcfa88e9e76b99",
      "3ca751fcc8c50608d73d149453d1129183d48a9bee743b57f27106a5387d15ce",
      "10950f51c367e7cbe55afdcfb8291cf568fa1ac8ad10453b2160618d9f6d29f6",
      "e8e25e45a1790436b70c5b3d3ad26a1e59b793a6ead7d02cd24fb778712fb310",
      "0fcf27e5bb58c7443b21e3d1b806d4ec6b159a40158af0897069ec190c483097",
      "58ecd719d90bd065842842997ca897036b9c4d8013070f5db944634110a7fbcf",
      "1c8cc616c854a1fc158d206cd67cd502509f58a166b0b76a231c170d4bc7650b",
      "f3241243d6e9b7d90fa800c40d37a1ee70f18f28792d525cba9376523a3e13d2",
      "903dc145869384555a974bc5d7e16e93d7b4c9436c6a174660e2871a64f0ec0f",
      "e3b3a4baa81f7e101690fcba845b252313beb1f320edccc1d9f00098c132c6ad",
    ]);
    expect(parseUnifiedDiff(representative).files.map((file) => file.path)).toEqual([
      "src/example.ts",
      "new name.txt",
      "quoted\tname.txt",
      "image.png",
      "gone.txt",
      "untracked.txt",
    ]);
    expect(sha256(JSON.stringify(parseUnifiedDiff(representative)))).toBe("e671b5b9bf95b51c7268fc5f7647418cfaec78d95f5c291bd76996b1db60413b");
  });

  it("keeps a deleted line that starts with two dashes inside its hunk", () => {
    const patch = [
      "diff --git a/schema.sql b/schema.sql",
      "--- a/schema.sql",
      "+++ b/schema.sql",
      "@@ -1,4 +1,3 @@",
      " select 1;",
      "--- remove this comment",
      " select 2;",
      " select 3;",
      "",
    ].join("\n");

    const [file] = parseUnifiedDiff(patch).files;

    expect(file).toMatchObject({ path: "schema.sql", oldPath: "schema.sql", newPath: "schema.sql" });
    expect(file!.hunks[0]!.lines.map((line) => [line.kind, line.content, line.oldLineNumber, line.newLineNumber, line.newInsertionIndex])).toEqual([
      ["context", "select 1;", 1, 1, 0],
      ["deletion", "-- remove this comment", 2, null, 1],
      ["context", "select 2;", 3, 2, 1],
      ["context", "select 3;", 4, 3, 2],
    ]);
  });

  it("keeps an added line that starts with two pluses inside its hunk", () => {
    const patch = [
      "diff --git a/notes.md b/notes.md",
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -1,3 +1,4 @@",
      " first",
      "+++ notes.md",
      " second",
      "-third",
      "+THIRD",
      "",
    ].join("\n");

    const [file] = parseUnifiedDiff(patch).files;

    expect(file).toMatchObject({ path: "notes.md", oldPath: "notes.md", newPath: "notes.md" });
    expect(file!.hunks[0]!.lines.map((line) => [line.kind, line.content, line.oldLineNumber, line.newLineNumber, line.newInsertionIndex])).toEqual([
      ["context", "first", 1, 1, 0],
      ["addition", "++ notes.md", null, 2, 1],
      ["context", "second", 2, 3, 2],
      ["deletion", "third", 3, null, 3],
      ["addition", "THIRD", null, 4, 3],
    ]);
  });

  it("still reads the next file headers after a hunk ends", () => {
    const patch = [
      "diff --git a/one.sql b/one.sql",
      "--- a/one.sql",
      "+++ b/one.sql",
      "@@ -1 +1 @@",
      "--- old",
      "+-- new",
      "diff --git a/two.txt b/two.txt",
      "--- a/two.txt",
      "+++ b/two.txt",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");

    const files = parseUnifiedDiff(patch).files;

    expect(files.map((file) => [file.path, file.hunks[0]!.lines.map((line) => line.content)])).toEqual([
      ["one.sql", ["-- old", "-- new"]],
      ["two.txt", ["a", "b"]],
    ]);
  });

  it("decodes Git's C-style quoted paths, including octal UTF-8 bytes", () => {
    const patch = [
      "diff --git \"a/caf\\303\\251 \\\"x\\\"\\a.txt\" \"b/caf\\303\\251 \\\"x\\\"\\a.txt\"",
      "--- \"a/caf\\303\\251 \\\"x\\\"\\a.txt\"",
      "+++ \"b/caf\\303\\251 \\\"x\\\"\\a.txt\"",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");

    const [file] = parseUnifiedDiff(patch).files;

    expect(file).toMatchObject({
      path: "café \"x\"\u0007.txt",
      oldPath: "café \"x\"\u0007.txt",
      newPath: "café \"x\"\u0007.txt",
    });
  });
});
