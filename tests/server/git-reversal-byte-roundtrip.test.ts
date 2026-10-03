import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, it } from "vitest";
import { reversalText } from "../../src/server/git/reversal";
import { parseUnifiedDiff } from "../../src/shared/diff-review";

it("restores exact bytes across real Git patches with BOMs and mixed endings", () => {
  const root = mkdtempSync(join(tmpdir(), "inertia-reversal-roundtrip-"));
  const texts = ["", "\uFEFF", "alpha", "alpha\n", "alpha\r\n", "\uFEFFalpha\n",
    "\uFEFFalpha\r\nbeta\nlast", "alpha\nbeta\r\nlast\n", "café\n🧪\n", "\n\n", "alpha\n\nlast"];
  try {
    mkdirSync(join(root, "old"));
    mkdirSync(join(root, "new"));
    const cases = new Map<string, { original: string; current: string }>();
    for (const original of texts) for (const current of texts) {
      if (original === current) continue;
      const name = `case-${cases.size}.txt`;
      cases.set(name, { original, current });
      writeFileSync(join(root, "old", name), original);
      writeFileSync(join(root, "new", name), current);
    }
    const diff = spawnSync("git", ["diff", "--no-index", "--no-ext-diff", "--no-color", "--no-renames", "--text", "--", "old", "new"], {
      cwd: root, encoding: "utf8", timeout: 5_000,
    });
    expect(diff.status).toBe(1);
    const files = parseUnifiedDiff(diff.stdout).files;
    expect(files).toHaveLength(cases.size);
    for (const file of files) {
      const { original, current } = cases.get(basename(file.newPath))!;
      const selected = file.hunks
        .flatMap((hunk) => hunk.lines).filter((line) => line.kind === "addition" || line.kind === "deletion");
      expect(reversalText(Buffer.from(current), selected, new Map(), Buffer.from(original)),
        JSON.stringify({ original, current })).toEqual(Buffer.from(original));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
