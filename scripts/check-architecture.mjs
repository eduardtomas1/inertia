import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const productionTypeScriptLineCeiling = 1_000;

const lineBudgets = new Map([
  ["src/renderer/src/components/Composer.tsx", 200],
  ["src/renderer/src/components/ResponseTimeline.tsx", 200],
  ["src/renderer/src/utils/responseTimeline.ts", 200],
  ["src/server/git.ts", 200],
  ["src/server/runtime/backends/backend-compatibility-probe.ts", 240],
  ["src/renderer/src/App.tsx", 850],
  ["src/renderer/src/components/WorkspaceScene.tsx", 120],
  ["src/renderer/src/components/workspace-scene/createWorkspaceSceneModel.ts", 560],
  ["src/renderer/src/hooks/useConversationProjection.ts", 400],
  ["src/renderer/src/hooks/useWorkspaceLayout.ts", 280],
  ["src/renderer/src/hooks/useWorkspaceTools.ts", 120],
  ["src/renderer/src/hooks/workspace-tools/useWorkspaceGit.ts", 240],
  ["src/renderer/src/hooks/workspace-tools/useWorkspaceFiles.ts", 240],
  ["src/renderer/src/hooks/workspace-tools/useWorkspaceReview.ts", 400],
  ["src/renderer/src/hooks/workspace-tools/useTurnArtifacts.ts", 200],
  ["src/renderer/src/hooks/useBackendProfiles.ts", 220],
  ["src/renderer/src/hooks/useActivityActions.ts", 200],
  ["src/renderer/src/hooks/useDesktopTools.ts", 160],
  ["src/server/database.ts", 750],
  ["src/server/index.ts", 600],
  ["src/server/runtime/turns/turn-controller.ts", 620],
  ["src/server/codex-app-server.ts", 40],
  ["src/server/codex/app-server-run.ts", 700],
  ["src/server/codex/app-server-events.ts", 720],
  ["src/server/codex/app-server-config.ts", 200],
  ["src/server/runtime/backends/backend-profile-controller.ts", 560],
  ["src/server/runtime/backends/backend-profile-runtime.ts", 400],
  ["src/server/runtime/backends/backend-profile-model.ts", 260],
  ["src/shared/contracts.ts", 50],
]);

const maximumLineLengths = new Map([
  ["src/renderer/src/App.tsx", 180],
  ["src/renderer/src/components/WorkspaceScene.tsx", 120],
  ["src/renderer/src/components/workspace-scene/createWorkspaceSceneModel.ts", 120],
]);

const importBudgets = new Map([
  ["src/renderer/src/App.tsx", 34],
  ["src/renderer/src/components/WorkspaceScene.tsx", 14],
  ["src/renderer/src/components/workspace-scene/createWorkspaceSceneModel.ts", 16],
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
    directory: "src/server/runtime/turns",
    patterns: [/from\s+["'][^"']*\/turn-controller["']/],
  },
  {
    directory: "src/server/runtime/commands",
    patterns: [/from\s+["'][^"']*\/(?:server\/)?index["']/],
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

function resolveLocalModule(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(fromFile, "..", specifier);
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function localDependencies(file) {
  const contents = readFileSync(file, "utf8");
  const dependencies = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[^;"']*?\s+from\s+["'](\.[^"']+)["']/gu,
    /\bimport\s*["'](\.[^"']+)["']/gu,
  ];
  for (const pattern of patterns) {
    for (const match of contents.matchAll(pattern)) {
      const dependency = resolveLocalModule(file, match[1]);
      if (dependency) dependencies.push(dependency);
    }
  }
  return dependencies;
}

function firstModuleCycle(directory) {
  const files = sourceFiles(directory);
  const fileSet = new Set(files);
  const graph = new Map(files.map((file) => [
    file,
    localDependencies(file).filter((dependency) => fileSet.has(dependency)),
  ]));
  const state = new Map();
  const stack = [];

  const visit = (file) => {
    state.set(file, "visiting");
    stack.push(file);
    for (const dependency of graph.get(file) ?? []) {
      if (state.get(dependency) === "visiting") {
        return [...stack.slice(stack.indexOf(dependency)), dependency];
      }
      if (state.get(dependency) !== "visited") {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    state.set(file, "visited");
    return null;
  };

  for (const file of files) {
    if (state.has(file)) continue;
    const cycle = visit(file);
    if (cycle) return cycle;
  }
  return null;
}

const failures = [];

for (const absoluteFile of sourceFiles("src")) {
  const contents = readFileSync(absoluteFile, "utf8");
  const lineCount = contents.split(/\r?\n/u).length;
  if (lineCount > productionTypeScriptLineCeiling) {
    failures.push(
      `${relative(workspaceRoot, absoluteFile)} has ${lineCount} lines `
      + `(production TypeScript ceiling: ${productionTypeScriptLineCeiling}).`,
    );
  }
}

for (const [file, maximumLines] of lineBudgets) {
  const contents = readFileSync(join(workspaceRoot, file), "utf8");
  const lineCount = contents.split(/\r?\n/u).length;
  if (lineCount > maximumLines) {
    failures.push(`${file} has ${lineCount} lines (budget: ${maximumLines}).`);
  }
}

for (const [file, maximumLength] of maximumLineLengths) {
  const contents = readFileSync(join(workspaceRoot, file), "utf8");
  const lines = contents.split(/\r?\n/u);
  const invalidLine = lines.findIndex((line) => line.length > maximumLength);
  if (invalidLine >= 0) {
    failures.push(
      `${file}:${invalidLine + 1} exceeds ${maximumLength} characters `
      + `(actual: ${lines[invalidLine].length}).`,
    );
  }
}

for (const [file, maximumImports] of importBudgets) {
  const contents = readFileSync(join(workspaceRoot, file), "utf8");
  const importCount = [...contents.matchAll(/^import\b/gmu)].length;
  if (importCount > maximumImports) {
    failures.push(`${file} has ${importCount} imports (budget: ${maximumImports}).`);
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

for (const directory of [
  "src/shared",
  "src/server/persistence",
  "src/server/codex",
  "src/server/runtime/backends",
  "src/renderer/src/utils/response-timeline",
]) {
  const cycle = firstModuleCycle(directory);
  if (cycle) {
    failures.push(
      `${directory} contains an import cycle: ${cycle
        .map((file) => relative(workspaceRoot, file))
        .join(" -> ")}.`,
    );
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
