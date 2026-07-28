import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const checker = resolve("scripts/check-architecture.mjs");
const roots: string[] = [];

function fixture(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "inertia-architecture-"));
  roots.push(root);
  const config = [
    "{",
    "  // Architecture resolution follows the checked TypeScript aliases.",
    '  "compilerOptions": {',
    '    "moduleResolution": "Bundler",',
    '    "paths": { "@shared/*": ["./src/shared/*"] },',
    "  },",
    "}",
    "",
  ].join("\n");
  writeFileSync(join(root, "tsconfig.node.json"), config);
  writeFileSync(join(root, "tsconfig.web.json"), config);
  for (const [file, contents] of Object.entries(files)) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

function check(root: string): string {
  return execFileSync(
    process.execPath,
    [checker, "--root", root],
    { encoding: "utf8" },
  );
}

function rejectedCheck(root: string): string {
  const result = spawnSync(
    process.execPath,
    [checker, "--root", root],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(1);
  return result.stderr;
}

describe("architecture checker", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves aliases and runtime JavaScript suffixes without parsing comments or assets as modules", () => {
    const root = fixture({
      "src/shared/contracts.ts": [
        'export type { SharedValue } from "./value.js";',
        '// import { fake } from "./missing";',
        "",
      ].join("\n"),
      "src/shared/value.ts": "export interface SharedValue { id: string }\n",
      "src/renderer/main.ts": [
        'import type { SharedValue } from "@shared/contracts";',
        'import "./styles.css";',
        "export const value: SharedValue = { id: \"value\" };",
        "",
      ].join("\n"),
      "src/renderer/styles.css": ".fixture {}\n",
    });

    expect(check(root)).toMatch(
      /passed \(3 source files, 2 internal edges, 0 derived compatibility facades\)/u,
    );
  });

  it("finds cycles that cross aliases and runtime JavaScript suffixes", () => {
    const root = fixture({
      "src/shared/alpha.ts": [
        'export type { Beta } from "@shared/beta";',
        "export interface Alpha { id: string }",
        "",
      ].join("\n"),
      "src/shared/beta.ts": [
        'import type { Alpha } from "./alpha.js";',
        "export interface Beta { alpha: Alpha }",
        "",
      ].join("\n"),
    });

    const error = rejectedCheck(root);
    expect(error).toContain("src contains an import cycle:");
    expect(error).toContain("src/shared/alpha.ts");
    expect(error).toContain("src/shared/beta.ts");
  });

  it("rejects non-literal dynamic imports that would hide graph edges", () => {
    const root = fixture({
      "src/shared/loader.ts": [
        "export async function load(name: string) {",
        "  return import(`./${name}`);",
        "}",
        "",
      ].join("\n"),
    });

    expect(rejectedCheck(root)).toContain(
      "uses a non-literal dynamic-import that cannot be checked",
    );
  });

  it("checks dynamic imports that include an options argument", () => {
    const root = fixture({
      "src/shared/loader.ts": [
        "export async function load() {",
        '  return import("../server/worker.js", {});',
        "}",
        "",
      ].join("\n"),
      "src/server/worker.ts": "export const worker = true;\n",
    });

    expect(rejectedCheck(root)).toContain(
      "crosses source layers shared -> server",
    );
  });

  it("enforces stable top-level source layers for type-only and runtime edges", () => {
    const root = fixture({
      "src/main/protocol.ts": "export interface Protocol { id: string }\n",
      "src/server/worker.ts": [
        'import type { Protocol } from "../main/protocol";',
        "export type WorkerProtocol = Protocol;",
        "",
      ].join("\n"),
    });

    expect(rejectedCheck(root)).toContain(
      "crosses source layers server -> main",
    );
  });

  it("derives paired pure facades and rejects implementation back-imports", () => {
    const root = fixture({
      "src/server/git.ts": 'export type { GitState } from "./git/types";\n',
      "src/server/git/types.ts": "export interface GitState { clean: boolean }\n",
      "src/server/git/status.ts": [
        'import type { GitState } from "../git";',
        "export const status: GitState = { clean: true };",
        "",
      ].join("\n"),
    });

    const error = rejectedCheck(root);
    expect(error).toContain(
      "src/server/git/status.ts:1 imports its compatibility facade",
    );
    expect(error).not.toContain("import cycle");
  });

  it("applies structural ceilings to test cases and support files without path allowlists", () => {
    const oversizedSupport = `${"// support\n".repeat(1_001)}export {};\n`;
    const oversizedTest = `${"// test\n".repeat(2_501)}export {};\n`;
    const oversizedE2eScenario = `${"// scenario\n".repeat(801)}export {};\n`;
    const root = fixture({
      "src/shared/value.ts": "export const value = true;\n",
      "tests/e2e/oversized.spec.ts": oversizedE2eScenario,
      "tests/helpers/oversized.ts": oversizedSupport,
      "tests/large.test.ts": oversizedTest,
    });

    const error = rejectedCheck(root);
    expect(error).toContain(
      "tests/helpers/oversized.ts has 1003 lines "
      + "(test support TypeScript ceiling: 1000)",
    );
    expect(error).toContain(
      "tests/large.test.ts has 2503 lines "
      + "(test case TypeScript ceiling: 2500)",
    );
    expect(error).toContain(
      "tests/e2e/oversized.spec.ts has 803 lines "
      + "(E2E scenario TypeScript ceiling: 800)",
    );
  });
});
