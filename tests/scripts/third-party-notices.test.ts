import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "..", "..", "scripts", "generate-third-party-notices.mjs");

type FixturePackage = {
  name: string;
  version: string;
  license?: string;
  files?: Record<string, string>;
};

function fixture(packages: FixturePackage[]): {
  outputPath: string;
  treePath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "inertia-notices-"));
  const dependencies: Record<string, object> = {};
  for (const pkg of packages) {
    const packagePath = join(root, "node_modules", pkg.name);
    mkdirSync(packagePath, { recursive: true });
    writeFileSync(join(packagePath, "package.json"), JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      ...(pkg.license ? { license: pkg.license } : {}),
    }));
    for (const [name, value] of Object.entries(pkg.files ?? {})) {
      writeFileSync(join(packagePath, name), value);
    }
    dependencies[pkg.name] = { path: packagePath, version: pkg.version };
  }
  const treePath = join(root, "tree.json");
  const outputPath = join(root, "THIRD_PARTY_NOTICES.txt");
  writeFileSync(treePath, JSON.stringify({ dependencies }));
  return { outputPath, treePath };
}

function generate(packages: FixturePackage[]): string {
  const { outputPath, treePath } = fixture(packages);
  execFileSync(process.execPath, [script], {
    env: {
      ...process.env,
      INERTIA_NOTICES_TREE_PATH: treePath,
      INERTIA_NOTICES_OUTPUT: outputPath,
    },
  });
  return readFileSync(outputPath, "utf8");
}

describe("third-party notice generation", () => {
  it("sorts packages and de-duplicates identical license text deterministically", () => {
    const packages = [
      { name: "zeta", version: "1.0.0", license: "MIT", files: { LICENSE: "Shared license\r\n" } },
      { name: "alpha", version: "2.0.0", license: "MIT", files: { LICENSE: "Shared license\n" } },
    ];
    const first = generate(packages);
    const second = generate(packages.toReversed());

    expect(first).toBe(second);
    expect(first.indexOf("- alpha@2.0.0")).toBeLessThan(first.indexOf("- zeta@1.0.0"));
    expect(first.match(/^Shared license$/gmu)).toHaveLength(1);
    expect(first).toContain("alpha@2.0.0 (LICENSE), zeta@1.0.0 (LICENSE)");
  });

  it("honors SEE LICENSE IN references", () => {
    const output = generate([{
      name: "restricted-package",
      version: "3.0.0",
      license: "SEE LICENSE IN TERMS.md",
      files: { "TERMS.md": "Use is subject to these terms." },
    }]);

    expect(output).toContain("Declared license: SEE LICENSE IN TERMS.md");
    expect(output).toContain("Use is subject to these terms.");
  });

  it("runs npm's JavaScript entry point through Node without a platform shell", () => {
    const { outputPath, treePath } = fixture([{
      name: "portable-package",
      version: "1.0.0",
      license: "MIT",
      files: { LICENSE: "Portable license" },
    }]);
    const root = dirname(treePath);
    const npmEntryPoint = join(root, "npm-cli.js");
    const invocationPath = join(root, "npm-invocation.json");
    writeFileSync(npmEntryPoint, `
const { readFileSync, writeFileSync } = require("node:fs");
writeFileSync(
  ${JSON.stringify(invocationPath)},
  JSON.stringify({ execPath: process.execPath, arguments: process.argv.slice(2) }),
);
process.stdout.write(readFileSync(${JSON.stringify(treePath)}, "utf8"));
`);
    const environment = { ...process.env };
    for (const name of Object.keys(environment)) {
      if (
        name.toLowerCase() === "npm_execpath"
        || name.toLowerCase() === "inertia_notices_tree_path"
      ) {
        delete environment[name];
      }
    }

    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: {
        ...environment,
        INERTIA_NOTICES_OUTPUT: outputPath,
        npm_execpath: npmEntryPoint,
      },
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(invocationPath, "utf8"))).toEqual({
      execPath: process.execPath,
      arguments: ["ls", "--omit=dev", "--all", "--json", "--long"],
    });
    expect(readFileSync(outputPath, "utf8")).toContain("portable-package@1.0.0");
  });

  it("fails closed when referenced license material is missing", () => {
    const { outputPath, treePath } = fixture([{
      name: "broken-package",
      version: "1.0.0",
      license: "SEE LICENSE IN MISSING.md",
    }]);
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        INERTIA_NOTICES_TREE_PATH: treePath,
        INERTIA_NOTICES_OUTPUT: outputPath,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("references unreadable MISSING.md");
  });

  it("rejects license material reached through an out-of-package symlink", () => {
    const name = "symlinked-package";
    const license = process.platform === "win32"
      ? "SEE LICENSE IN license-root/LICENSE"
      : "MIT";
    const { outputPath, treePath } = fixture([{
      name,
      version: "1.0.0",
      license,
    }]);
    const root = dirname(treePath);
    const packagePath = join(root, "node_modules", name);
    if (process.platform === "win32") {
      const outsideDirectory = join(root, "outside-license");
      mkdirSync(outsideDirectory);
      writeFileSync(join(outsideDirectory, "LICENSE"), "Outside package material");
      symlinkSync(outsideDirectory, join(packagePath, "license-root"), "junction");
    } else {
      const outsideLicense = join(root, "outside-license");
      writeFileSync(outsideLicense, "Outside package material");
      symlinkSync(outsideLicense, join(packagePath, "LICENSE"));
    }

    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        INERTIA_NOTICES_TREE_PATH: treePath,
        INERTIA_NOTICES_OUTPUT: outputPath,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /references (?:a license outside its package|non-regular LICENSE)/u,
    );
  });
});
