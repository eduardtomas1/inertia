import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function evaluate<T>(body: string): T {
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { declaredBuildInputs, reachableFiles, sourceUsage } from "./scripts/source-usage.mjs";
    ${body}
  `], { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })) as T;
}

describe("source usage inventory", () => {
  it("derives every named build input and refuses computed inputs", () => {
    const result = evaluate<{ entries: string[]; rejected: boolean }>(`
      const entries = declaredBuildInputs('export default { main: { build: { rollupOptions: { input: { main: resolve("src/main.ts"), worker: resolve("src/worker.ts") } } } }, renderer: { build: { rollupOptions: { input: resolve("src/index.html") } } } }');
      let rejected = false;
      try { declaredBuildInputs('export default { build: { rollupOptions: { input: resolve(variable) } } }'); }
      catch { rejected = true; }
      console.log(JSON.stringify({ entries, rejected }));
    `);
    expect(result).toEqual({
      entries: ["src/main.ts", "src/worker.ts", "src/index.html"], rejected: true,
    });
  });

  it("finds disconnected cycles even when tests retain another disconnected module", () => {
    const result = evaluate<{ production: string[]; complete: string[] }>(`
      const edges = [
        { from: "main", to: "lazy" }, { from: "lazy", to: "types" },
        { from: "orphan-a", to: "orphan-b" }, { from: "orphan-b", to: "orphan-a" },
        { from: "test", to: "fixture" }, { from: "fixture", to: "types" },
      ];
      console.log(JSON.stringify({
        production: [...reachableFiles(["main"], edges)].sort(),
        complete: [...reachableFiles(["main", "test"], edges)].sort(),
      }));
    `);
    expect(result.production).toEqual(["lazy", "main", "types"]);
    expect(result.complete).toEqual(["fixture", "lazy", "main", "test", "types"]);
  });

  it("retains documentation and other repository tools without rooting source or generated output", () => {
    const report = evaluate<{
      toolingRoots: string[];
      production: string[];
      testAndToolOnly: string[];
      unreferenced: string[];
      analysisLimitations: string[];
    }>(`
      import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { dirname, join } from "node:path";
      const root = mkdtempSync(join(tmpdir(), "inertia-source-usage-"));
      const build = 'export default { build: { rollupOptions: { input: resolve("src/main.ts") } } };';
      const files = {
        "electron.vite.config.ts": build,
        "scripts/runtime-status.vite.config.mjs": build,
        "src/renderer/private-connect/vite.config.ts": build,
        "scripts/source-usage-resources.json": '{"sourceEntries":[],"resources":[]}',
        "tsconfig.node.json": "{}",
        "tsconfig.web.json": "{}",
        "database-migration-lineage.json": '{"migrations":[]}',
        "package.json": '{"build":{}}',
        "src/main.ts": "export {};",
        "src/docs-only.ts": "export {};",
        "src/other-tool-only.ts": "export {};",
        "src/generated-only.ts": "export {};",
        "src/dependency-only.ts": "export {};",
        "src/orphan.ts": "export {};",
        "docs/pr-evidence/legacy/evidence.ts": 'import "../../../src/docs-only.ts";',
        ".github/tools/inspect.cjs": 'require("../../src/other-tool-only.ts");',
        "docs/out/generated.mjs": 'import "../../src/generated-only.ts";',
        "resources/generated/tool.ts": 'import "../../src/generated-only.ts";',
        "node_modules/dependency/index.js": 'require("../../src/dependency-only.ts");',
        ".git/ignored.ts": "this must never be parsed",
      };
      try {
        for (const [file, contents] of Object.entries(files)) {
          const path = join(root, file);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, contents);
        }
        // These conventional directories need not contain any modules.
        mkdirSync(join(root, "tests"));
        mkdirSync(join(root, "benchmarks"));
        console.log(JSON.stringify(sourceUsage(root)));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    `);
    expect(report.toolingRoots).toEqual([
      ".github/tools/inspect.cjs",
      "docs/pr-evidence/legacy/evidence.ts",
      "electron.vite.config.ts",
      "scripts/runtime-status.vite.config.mjs",
      "src/renderer/private-connect/vite.config.ts",
    ]);
    expect(report.production).toEqual(["src/main.ts"]);
    expect(report.testAndToolOnly).toEqual([
      "src/docs-only.ts", "src/other-tool-only.ts", "src/renderer/private-connect/vite.config.ts",
    ]);
    expect(report.unreferenced).toEqual([
      "src/dependency-only.ts", "src/generated-only.ts", "src/orphan.ts",
    ]);
    expect(report.analysisLimitations).toEqual([]);
  });

  it("keeps reviewed non-production files visible and reports all shipped entry families", () => {
    const report = evaluate<{
      productionRoots: string[];
      toolingRoots: string[];
      production: string[];
      testAndToolOnly: string[];
      unreferenced: string[];
      analysisLimitations: string[];
      lazyImports: { from: string; to: string }[];
      inlineTypeImports: { from: string; to: string }[];
      compatibilityPins: { path: string }[];
    }>("console.log(JSON.stringify(sourceUsage(process.cwd())));");
    expect(report.toolingRoots).toContain("docs/pr-evidence/legacy-368/legacy-backfill-evidence.ts");
    expect(report.productionRoots).toEqual(expect.arrayContaining([
      "src/main/index.ts",
      "src/main/linux-file-icon-worker.ts",
      "src/main/snapshot-shortcut-worker.ts",
      "src/server/runtime-worker.ts",
      "src/server/runtime-status-cli.ts",
      "src/server/persistence/message-search-worker.ts",
      "src/server/persistence/database-recovery-import-worker.ts",
      "src/server/runtime/attachments/document-preparation-worker.ts",
      "src/preload/index.ts",
      "src/preload/detached-chat.ts",
      "src/preload/mascot.ts",
      "src/preload/preview-agent-privacy.ts",
      "src/renderer/private-connect/src/main.tsx",
      "src/renderer/src/mascot/main.ts",
      "src/renderer/src/workers/diff-parser.worker.ts",
    ]));
    // Reviewed exceptions are findings, never artificial production roots.
    // See docs/SOURCE_USAGE_AUDIT.md for owners and retirement conditions.
    expect(report.testAndToolOnly).toEqual([
      "src/renderer/private-connect/vite.config.ts",
      "src/server/codex/app-server-notifications.ts",
      "src/server/runtime/backends/kimi-claude-preset.ts",
    ]);
    expect(report.unreferenced).toEqual([
      "src/renderer/src/utils/composerToolReadiness.ts",
    ]);
    expect(report.production).toContain("src/server/provider/adapters.ts");
    expect(report.production).not.toContain("src/server/provider/cli-agent-harness.ts");
    expect(report.lazyImports.length).toBeGreaterThan(0);
    expect(report.inlineTypeImports).toContainEqual({
      from: "src/preload/index.ts", to: "src/shared/snapshots.ts",
    });
    expect(report.compatibilityPins).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "src/shared/model-routing.ts" }),
      expect.objectContaining({ path: "src/shared/attachments.ts" }),
    ]));
    // Tool-only computed loaders remain visible, while source parse/resolution
    // errors must never make a partial production graph look complete.
    expect(report.analysisLimitations.filter((failure) => failure.startsWith("src/"))).toEqual([]);
    expect(report.analysisLimitations.filter((failure) => failure.includes("could not be parsed"))).toEqual([]);
    expect(report.analysisLimitations.length).toBeGreaterThan(0);
  });
});
