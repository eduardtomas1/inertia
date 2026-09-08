import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import config from "../../playwright.config";
import {
  assertE2eWindowResource,
  discoverE2eResources,
  exactScenarioPattern,
  scenarioResource,
} from "../support/e2e-resource-policy";

const directories: string[] = [];
function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "inertia-e2e-policy-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Electron scenario resource ownership", () => {
  it("uses explicit metadata independent of quotes, formatting, or helper-owned launch options", () => {
    expect(scenarioResource("// @inertia-e2e-resource primary-display\nlaunchHelper();", "nested.spec.ts"))
      .toBe("primary-display");
    expect(scenarioResource("\uFEFF// @inertia-e2e-resource isolated\r\nimport 'helper';", "nested.spec.ts"))
      .toBe("isolated");
  });

  it.each([
    "launchHelper();",
    "// @inertia-e2e-resource unknown\n",
    "\n// @inertia-e2e-resource isolated\n",
    "// @inertia-e2e-resource isolated\n// @inertia-e2e-resource primary-display\n",
  ])("fails rather than silently omitting an undeclared/misdeclared spec", (source) => {
    expect(() => scenarioResource(source, "new.spec.ts")).toThrow("exactly one first-line");
  });

  it("discovers nested and renamed scenarios once and ignores support files", () => {
    const directory = fixture();
    const nested = join(directory, "nested");
    mkdirSync(nested);
    const primary = join(nested, "renamed [focus].spec.ts");
    const isolated = join(directory, "isolation.spec.ts");
    writeFileSync(primary, "// @inertia-e2e-resource primary-display\n");
    writeFileSync(isolated, "// @inertia-e2e-resource isolated\n");
    writeFileSync(join(nested, "support.ts"), "no metadata needed here");
    expect(discoverE2eResources(directory)).toEqual({
      isolated: [isolated], "primary-display": [primary],
    });
    writeFileSync(join(nested, "new.spec.ts"), "undeclared scenario");
    expect(() => discoverE2eResources(directory)).toThrow("new.spec.ts");
  });

  it("rejects an empty suite and symbolic-link traversal rather than losing or duplicating work", () => {
    const directory = fixture();
    expect(() => discoverE2eResources(directory)).toThrow("no scenarios");
    symlinkSync(directory, join(directory, "cycle"), process.platform === "win32" ? "junction" : "dir");
    expect(() => discoverE2eResources(directory)).toThrow("symbolic links");
  });

  it("matches exact portable file identity instead of interpreting filenames as globs", () => {
    const pattern = exactScenarioPattern(["C:\\repo (copy)\\tests\\nested\\[focus].spec.ts"]);
    expect(pattern.test("C:/repo (copy)/tests/nested/[focus].spec.ts")).toBe(true);
    expect(pattern.test("C:\\repo (copy)\\tests\\nested\\[focus].spec.ts")).toBe(true);
    expect(pattern.test("C:/repo (copy)/tests/nested/f.spec.ts")).toBe(false);
    expect(pattern.test("C:/repo (copy)/tests/nested/[focus].spec.ts.extra")).toBe(false);
    expect(exactScenarioPattern([]).test("")).toBe(false);
  });

  it.skipIf(process.platform === "win32")("rejects literal backslash names that alias a nested resource path", () => {
    const directory = fixture();
    mkdirSync(join(directory, "nested"));
    writeFileSync(join(directory, "nested", "focus.spec.ts"), "// @inertia-e2e-resource isolated\n");
    writeFileSync(join(directory, "nested\\focus.spec.ts"), "// @inertia-e2e-resource primary-display\n");
    expect(() => discoverE2eResources(directory)).toThrow("unambiguous separators");
  });

  it("rejects helper-selected primary display use before any isolated app is launched", () => {
    expect(() => assertE2eWindowResource("isolated", "primary")).toThrow("primary-display");
    expect(() => assertE2eWindowResource("runtime-recovery", "primary")).toThrow("primary-display");
    expect(() => assertE2eWindowResource("display-sensitive", "primary")).not.toThrow();
    expect(() => assertE2eWindowResource("isolated", undefined)).not.toThrow();
  });

  it("assigns every current spec/scenario exactly once in the actual Playwright configuration", () => {
    const resources = discoverE2eResources(join(process.cwd(), "tests/e2e"));
    const projects = config.projects!;
    expect(projects.map((project) => project.name)).toEqual([
      "display-sensitive", "isolated", "runtime-recovery",
    ]);
    for (const [resource, files] of Object.entries(resources)) {
      for (const file of files) {
        for (const title of ["ordinary scenario", "destructive scenario @runtime-recovery"]) {
          const assigned = projects.filter((project) => {
            expect(project.testMatch).toBeInstanceOf(RegExp);
            return (project.testMatch as RegExp).test(file)
              && (!project.grep || (project.grep as RegExp).test(title))
              && (!project.grepInvert || !(project.grepInvert as RegExp).test(title));
          });
          expect(assigned.map((project) => project.name), `${file}: ${title}`).toEqual([
            resource === "primary-display" ? "display-sensitive"
              : title.includes("@runtime-recovery") ? "runtime-recovery" : "isolated",
          ]);
        }
      }
    }
    for (const name of ["display-sensitive", "runtime-recovery"]) {
      expect(projects.find((project) => project.name === name)?.workers).toBe(1);
    }
    expect(config.retries ?? 0).toBe(0);
  });
});
