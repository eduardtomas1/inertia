import { describe, expect, it } from "vitest";

import { parseUnifiedDiff, selectedDiffReference } from "../../src/shared/diff-review";

const patch = `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,3 +1,4 @@
 export function answer() {
-  return 41;
+  const value = 42;
+  return value;
 }
`;

describe("diff review model", () => {
  it("parses stable file, hunk, line, and line-number identities", () => {
    const first = parseUnifiedDiff(patch);
    const second = parseUnifiedDiff(patch);
    expect(first).toEqual(second);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{8}$/u);
    expect(first.files[0]).toMatchObject({ path: "src/example.ts", oldPath: "src/example.ts", newPath: "src/example.ts" });
    expect(first.files[0].hunks[0].lines.map((line) => [line.kind, line.oldLineNumber, line.newLineNumber])).toEqual([
      ["context", 1, 1],
      ["deletion", 2, null],
      ["addition", null, 2],
      ["addition", null, 3],
      ["context", 3, 4],
    ]);
  });

  it("creates bounded prompt context for only the selected lines", () => {
    const file = parseUnifiedDiff(patch).files[0];
    const hunk = file.hunks[0];
    const reference = selectedDiffReference(file, hunk, hunk.lines.slice(1, 4).map(({ id }) => id));
    expect(reference).toContain("src/example.ts");
    expect(reference).toContain("-2:   return 41;");
    expect(reference).toContain("+2:   const value = 42;");
    expect(reference).not.toContain("export function answer");
  });

  it("decodes Git-quoted paths", () => {
    const quoted = patch.replaceAll("src/example.ts", "src/example file.ts")
      .replace("diff --git a/src/example file.ts b/src/example file.ts", "diff --git \"a/src/example file.ts\" \"b/src/example file.ts\"")
      .replace("--- a/src/example file.ts", "--- \"a/src/example file.ts\"")
      .replace("+++ b/src/example file.ts", "+++ \"b/src/example file.ts\"");
    expect(parseUnifiedDiff(quoted).files[0].path).toBe("src/example file.ts");
  });
});
