import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";

import type { WorkspaceEntry } from "../../src/shared/contracts";
import {
  flattenWorkspaceTree,
  isSafeWorkspaceEntryPath,
  sortWorkspaceEntries,
  workspaceParentPath,
  workspacePathName,
  workspaceTreeKeyboardAction,
} from "../../src/renderer/src/utils/workspaceTree";

function entry(path: string, kind: WorkspaceEntry["kind"]): WorkspaceEntry {
  return { path, kind };
}

describe("workspace tree model", () => {
  it("accepts portable case-preserving relative paths and rejects boundary tricks", () => {
    expect(isSafeWorkspaceEntryPath("Src\\Components\\Thing10.ts")).toBe(true);
    expect(isSafeWorkspaceEntryPath("a:file.ts")).toBe(true);
    expect(isSafeWorkspaceEntryPath("src/components/Thing.ts")).toBe(true);
    for (const path of [
      "",
      ".",
      "..",
      "../secret",
      "src/../../secret",
      "/etc/passwd",
      "src//file.ts",
      "src/\0file.ts",
    ]) {
      expect(isSafeWorkspaceEntryPath(path)).toBe(false);
    }
  });

  it("treats only serialized forward slashes as hierarchy separators", () => {
    expect(workspacePathName("notes\\draft.md")).toBe("notes\\draft.md");
    expect(workspaceParentPath("notes\\draft.md")).toBe("");
    expect(workspacePathName("docs/notes\\draft.md"))
      .toBe("notes\\draft.md");
    expect(workspaceParentPath("docs/notes\\draft.md")).toBe("docs");

    const rows = flattenWorkspaceTree(new Map([
      ["", [
        entry("docs", "directory"),
        entry("notes\\draft.md", "file"),
      ]],
      ["docs", [entry("docs/notes\\draft.md", "file")]],
    ]), new Set(["docs"]));
    expect(rows.map(({ entry: item, parentPath }) => [
      item.path,
      parentPath,
    ])).toEqual([
      ["docs", ""],
      ["docs/notes\\draft.md", "docs"],
      ["notes\\draft.md", ""],
    ]);
  });

  it("sorts directories before files naturally without changing path case", () => {
    expect(sortWorkspaceEntries([
      entry("file10.ts", "file"),
      entry("Folder2", "directory"),
      entry("file2.ts", "file"),
      entry("Folder10", "directory"),
    ])).toEqual([
      entry("Folder2", "directory"),
      entry("Folder10", "directory"),
      entry("file2.ts", "file"),
      entry("file10.ts", "file"),
    ]);
  });

  it("orders a file tree identically whatever the process default locale is", () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-workspace-tree-locale-"));
    try {
      buildSync({
        entryPoints: [resolve("src/renderer/src/utils/workspaceTree.ts")],
        outfile: join(directory, "workspace-tree.mjs"),
        bundle: true,
        platform: "node",
        format: "esm",
        logLevel: "silent",
      });
      const script = join(directory, "order.mjs");
      writeFileSync(script, [
        "import { sortWorkspaceEntries } from \"./workspace-tree.mjs\";",
        "const names = [\"zeta.ts\", \"\u00e4pple.ts\", \"apple.ts\", \"yak.ts\", \"ice.ts\", \"jam.ts\", \"file10.ts\", \"file2.ts\", \"src\"];",
        "const entries = names.map((path) => ({ path, kind: path === \"src\" ? \"directory\" : \"file\" }));",
        "process.stdout.write(JSON.stringify({",
        "  locale: new Intl.Collator().resolvedOptions().locale,",
        "  order: sortWorkspaceEntries(entries).map(({ path }) => path),",
        "}));",
      ].join("\n"));
      const runs = ["en_US.UTF-8", "sv_SE.UTF-8", "lt_LT.UTF-8", "tr_TR.UTF-8"].map((locale) => JSON.parse(
        execFileSync(process.execPath, [script], {
          encoding: "utf8",
          env: { ...process.env, LANG: locale, LC_ALL: locale },
        }),
      ) as { locale: string; order: string[] });

      for (const run of runs) {
        expect(run.order).toEqual([
          "src", "apple.ts", "\u00e4pple.ts", "file2.ts", "file10.ts", "ice.ts", "jam.ts", "yak.ts", "zeta.ts",
        ]);
      }
      if (process.platform !== "win32") {
        expect(runs.map(({ locale }) => locale)).toEqual(["en-US", "sv-SE", "lt-LT", "tr-TR"]);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("flattens only expanded direct-child pages and ignores misplaced entries", () => {
    const pages = new Map<string, WorkspaceEntry[]>([
      ["", [
        entry("src", "directory"),
        entry("README.md", "file"),
        entry("../escape", "file"),
      ]],
      ["src", [
        entry("src/components", "directory"),
        entry("src/index.ts", "file"),
        entry("other/misplaced.ts", "file"),
      ]],
      ["src/components", [entry("src/components/Button.tsx", "file")]],
    ]);
    const collapsed = flattenWorkspaceTree(pages, new Set());
    expect(collapsed.map(({ entry: item, depth }) => [item.path, depth])).toEqual([
      ["src", 1],
      ["README.md", 1],
    ]);

    const expanded = flattenWorkspaceTree(
      pages,
      new Set(["src", "src/components"]),
    );
    expect(expanded.map(({ entry: item, depth, parentPath }) => [
      item.path,
      depth,
      parentPath,
    ])).toEqual([
      ["src", 1, ""],
      ["src/components", 2, "src"],
      ["src/components/Button.tsx", 3, "src/components"],
      ["src/index.ts", 2, "src"],
      ["README.md", 1, ""],
    ]);
  });

  it("models standard tree Arrow, Home, End, Enter, and Space actions", () => {
    const pages = new Map<string, WorkspaceEntry[]>([
      ["", [entry("src", "directory"), entry("README.md", "file")]],
      ["src", [entry("src/index.ts", "file")]],
    ]);
    const collapsed = flattenWorkspaceTree(pages, new Set());
    expect(workspaceTreeKeyboardAction("ArrowRight", "src", collapsed))
      .toEqual({ type: "toggle", path: "src" });
    expect(workspaceTreeKeyboardAction("End", "src", collapsed))
      .toEqual({ type: "focus", path: "README.md" });
    expect(workspaceTreeKeyboardAction("Enter", "README.md", collapsed))
      .toEqual({ type: "open", path: "README.md" });

    const expanded = flattenWorkspaceTree(pages, new Set(["src"]));
    expect(workspaceTreeKeyboardAction("ArrowRight", "src", expanded))
      .toEqual({ type: "focus", path: "src/index.ts" });
    expect(workspaceTreeKeyboardAction("ArrowLeft", "src/index.ts", expanded))
      .toEqual({ type: "focus", path: "src" });
    expect(workspaceTreeKeyboardAction("ArrowLeft", "src", expanded))
      .toEqual({ type: "toggle", path: "src" });
    expect(workspaceTreeKeyboardAction(" ", "src", expanded))
      .toEqual({ type: "toggle", path: "src" });
    expect(workspaceTreeKeyboardAction("Home", "README.md", expanded))
      .toEqual({ type: "focus", path: "src" });
  });
});
