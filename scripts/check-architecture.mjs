import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const lineBudgets = new Map([
  ["src/renderer/src/components/Composer.tsx", 200],
  ["src/renderer/src/components/ResponseTimeline.tsx", 200],
  ["src/renderer/src/utils/responseTimeline.ts", 200],
  ["src/server/git.ts", 200],
  ["src/server/runtime/backends/backend-compatibility-probe.ts", 240],
  // These remaining compatibility seams are lowered as their current
  // behavior is moved behind focused modules in this branch.
  ["src/renderer/src/App.tsx", 1_700],
  ["src/server/database.ts", 2_800],
  ["src/server/index.ts", 2_000],
  ["src/server/runtime/turns/turn-controller.ts", 1_750],
  ["src/shared/contracts.ts", 50],
]);

const forbiddenFacadeImports = [
  {
    directory: "src/renderer/src/components/composer",
    patterns: [/from\s+["'][^"']*\/Composer["']/],
  },
  {
    directory: "src/renderer/src/components/response-timeline",
    patterns: [/from\s+["'][^"']*\/ResponseTimeline["']/],
  },
  {
    directory: "src/renderer/src/utils/response-timeline",
    patterns: [/from\s+["'][^"']*\/responseTimeline["']/],
  },
  {
    directory: "src/server/git",
    patterns: [/from\s+["'][^"']*\/git["']/],
  },
  {
    directory: "src/server/persistence",
    patterns: [/from\s+["'][^"']*\/database["']/],
  },
  {
    directory: "src/shared/contracts",
    patterns: [/from\s+["'][^"']*(?:^|\/)contracts["']/],
  },
];

function sourceFiles(directory) {
  const absoluteDirectory = join(workspaceRoot, directory);
  return readdirSync(absoluteDirectory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && [".ts", ".tsx"].includes(extname(entry.name)))
    .map((entry) => join(entry.parentPath, entry.name));
}

const failures = [];

for (const [file, maximumLines] of lineBudgets) {
  const contents = readFileSync(join(workspaceRoot, file), "utf8");
  const lineCount = contents.split(/\r?\n/u).length;
  if (lineCount > maximumLines) {
    failures.push(`${file} has ${lineCount} lines (budget: ${maximumLines}).`);
  }
}

for (const rule of forbiddenFacadeImports) {
  for (const absoluteFile of sourceFiles(rule.directory)) {
    const contents = readFileSync(absoluteFile, "utf8");
    for (const pattern of rule.patterns) {
      if (pattern.test(contents)) {
        failures.push(
          `${relative(workspaceRoot, absoluteFile)} crosses its module boundary (${pattern}).`,
        );
      }
    }
  }
}

if (failures.length > 0) {
  console.error("Architecture checks failed:\n");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("Architecture checks passed.");
}
