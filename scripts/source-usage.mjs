import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

import { analyzeModuleUsage, typescriptFiles } from "./architecture/analyzer.mjs";

const BUILD_CONFIGS = [
  "electron.vite.config.ts",
  "scripts/runtime-status.vite.config.mjs",
  "src/renderer/private-connect/vite.config.ts",
];
const CONFIG_PATHS = ["tsconfig.node.json", "tsconfig.web.json"];
const MODULE_FILE = /\.[cm]?[jt]sx?$/u;
const portable = (path) => path.replaceAll("\\", "/");

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "extra", "comments", "tokens"].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value && typeof value === "object") walk(value, visit);
  }
}

// Read build declarations without executing their plugins, environment probes,
// native builds or Git commands. Unrecognized input syntax requires review.
export function declaredBuildInputs(contents) {
  const inputs = [];
  function collect(node) {
    if (node.type === "ObjectExpression") {
      for (const property of node.properties) {
        if (property.type !== "ObjectProperty" || property.computed) {
          throw new Error("Build inputs must have explicit static keys.");
        }
        collect(property.value);
      }
    } else if (
      node.type === "CallExpression"
      && node.callee.type === "Identifier" && node.callee.name === "resolve"
      && node.arguments.length === 1 && node.arguments[0].type === "StringLiteral"
    ) inputs.push(node.arguments[0].value);
    else throw new Error("Unrecognized build input; update the usage inventory.");
  }
  walk(parse(contents, { sourceType: "module", plugins: ["typescript"] }).program, (node) => {
    if (node.type === "ObjectProperty" && !node.computed
      && (node.key.name ?? node.key.value) === "rollupOptions") {
      const input = node.value.properties?.find((property) =>
        property.type === "ObjectProperty" && (property.key.name ?? property.key.value) === "input");
      if (!input) throw new Error("Rollup inputs must be explicit in the usage inventory.");
      collect(input.value);
    }
  });
  if (inputs.length === 0) throw new Error("No build inputs found.");
  return inputs;
}

function moduleScripts(html) {
  const sources = [];
  for (const match of html.matchAll(/<script\b([^>]*)>/giu)) {
    const attributes = new Map([...match[1].matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/gu)]
      .map((attribute) => [attribute[1], attribute[2]]));
    if (attributes.get("type") !== "module") continue;
    const source = attributes.get("src");
    if (!source || /^(?:[a-z]+:)?\/\//iu.test(source)) {
      throw new Error("HTML module entry requires a reviewed local src.");
    }
    sources.push(source);
  }
  if (sources.length === 0) throw new Error("No HTML module entries found.");
  return sources;
}

function toolingFiles(root) {
  return [
    ...["tests", "scripts", "benchmarks"].flatMap((directory) =>
      readdirSync(resolve(root, directory), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && MODULE_FILE.test(entry.name))
        .map((entry) => resolve(entry.parentPath, entry.name))),
    ...readdirSync(root).filter((file) => MODULE_FILE.test(file))
      .map((file) => resolve(root, file)),
    ...BUILD_CONFIGS.map((file) => resolve(root, file)),
  ];
}

export function reachableFiles(roots, edges) {
  const adjacency = new Map();
  for (const edge of edges) {
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets);
  }
  const visited = new Set();
  const pending = [...roots];
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    pending.push(...adjacency.get(file) ?? []);
  }
  return visited;
}

export function sourceUsage(root) {
  const path = (file) => portable(relative(root, file));
  const read = (file) => readFileSync(resolve(root, file), "utf8");
  const resourceReview = JSON.parse(read("scripts/source-usage-resources.json"));
  for (const resource of [...resourceReview.sourceEntries, ...resourceReview.resources]) {
    read(resource.owner);
  }
  const buildInputs = BUILD_CONFIGS.map((config) => ({
    config, inputs: declaredBuildInputs(read(config)),
  }));
  const productionRoots = [...new Set([...buildInputs.flatMap(({ inputs }) => inputs.flatMap((input) => {
    if (!input.endsWith(".html")) return [resolve(root, input)];
    return moduleScripts(read(input)).map((source) =>
      resolve(root, dirname(input), source.replace(/^\//u, "")));
  })), ...resourceReview.sourceEntries.map((entry) => resolve(root, entry.path))])].sort();
  const source = typescriptFiles(resolve(root, "src"));
  const tools = [...new Set(toolingFiles(root))].sort();
  const files = [...new Set([...source, ...tools])].sort();
  for (const entry of productionRoots) {
    if (!source.includes(entry)) throw new Error(`Missing source entry ${path(entry)}.`);
  }
  // Inventory also retains inline import("...").Type references. Keep the
  // existing architecture checker's edge/cycle policy unchanged in this audit.
  const graph = analyzeModuleUsage({
    workspaceRoot: root, files, configPaths: CONFIG_PATHS, includeTypeQueries: true,
  });
  const production = reachableFiles(productionRoots, graph.edges);
  const complete = reachableFiles([...productionRoots, ...tools], graph.edges);
  const runtime = reachableFiles(productionRoots, graph.edges.filter((edge) => !edge.typeOnly));
  const lineage = JSON.parse(read("database-migration-lineage.json"));
  const packageJson = JSON.parse(read("package.json"));
  return {
    scope: "Conservative file reachability, including type imports. Not an unused-export or dependency audit; never authorizes deletion alone.",
    buildInputs,
    productionRoots: productionRoots.map(path),
    toolingRoots: tools.map(path),
    toolingPolicy: "Every checked-in test, benchmark, script and root/build config is a conservative tool root, including helpers. No src glob is a production root.",
    production: source.filter((file) => production.has(file)).map(path),
    complete: source.filter((file) => complete.has(file)).map(path),
    productionTypeOnly: source.filter((file) => production.has(file) && !runtime.has(file)).map(path),
    testAndToolOnly: source.filter((file) => !production.has(file) && complete.has(file)).map(path),
    unreferenced: source.filter((file) => !complete.has(file) && !file.endsWith(".d.ts")).map(path),
    ambientDeclarations: source.filter((file) => file.endsWith(".d.ts")).map(path),
    lazyImports: graph.edges.filter((edge) => edge.kind === "dynamic-import" && production.has(edge.from))
      .map((edge) => ({ from: path(edge.from), to: path(edge.to) })),
    inlineTypeImports: graph.edges.filter((edge) => edge.kind === "type-query" && production.has(edge.from))
      .map((edge) => ({ from: path(edge.from), to: path(edge.to) })),
    compatibilityPins: lineage.migrations.flatMap((migration) =>
      (migration.sources ?? []).map((pin) => ({ version: migration.version, ...pin }))),
    packaging: {
      main: packageJson.main,
      files: packageJson.build.files,
      extraResources: packageJson.build.extraResources,
      asarUnpack: packageJson.build.asarUnpack,
      hooks: Object.fromEntries(Object.entries(packageJson.build)
        .filter(([key]) => /^(?:before|after)|^(?:nsis|mac|win|linux)$/u.test(key))),
    },
    resourceReview,
    // Dynamic tool imports (for example generated package-smoke output) remain
    // visible; a partial graph is never reported as an exhaustive proof.
    analysisLimitations: graph.failures,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = sourceUsage(resolve(fileURLToPath(new URL("..", import.meta.url))));
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(report.scope);
    console.log(`${report.productionRoots.length} production entries; ${report.production.length} production files; ${report.testAndToolOnly.length} test/tool-only files; ${report.unreferenced.length} unreferenced files.`);
    for (const key of ["productionRoots", "testAndToolOnly", "unreferenced", "ambientDeclarations", "analysisLimitations"]) {
      console.log(`\n${key}:\n${report[key].map((value) => `  ${value}`).join("\n")}`);
    }
    console.log("\nUse --json for complete production/tool roots, type-only edges, lazy imports, compatibility pins and resource/packaging inventory.");
  }
}
