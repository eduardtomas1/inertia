import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import {
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import { parse, parseExpression } from "@babel/parser";

const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const RUNTIME_JAVASCRIPT_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const TEST_CASE_PATTERN = /\.(?:test|spec)\.[cm]?tsx?$/u;

export const DEFAULT_ALLOWED_SOURCE_LAYERS = new Map([
  ["shared", new Set(["shared"])],
  ["node", new Set(["node", "shared"])],
  ["main", new Set(["main", "node", "shared"])],
  ["server", new Set(["server", "node", "shared"])],
  ["preload", new Set(["preload", "shared"])],
  ["renderer", new Set(["renderer", "shared"])],
]);

function canonicalPath(path) {
  const absolute = resolve(path);
  return process.platform === "win32"
    ? absolute.toLocaleLowerCase("en-US")
    : absolute;
}

function workspacePath(workspaceRoot, file) {
  return relative(workspaceRoot, file).replaceAll("\\", "/");
}

function isContained(directory, file) {
  const child = relative(directory, file);
  return child === ""
    || (
      child !== ".."
      && !child.startsWith(`..${sep}`)
    );
}

function normalizedFacadeName(name) {
  return name.replace(/[^a-z0-9]/giu, "").toLocaleLowerCase("en-US");
}

function configValue(node) {
  if (
    node.type === "StringLiteral"
    || node.type === "NumericLiteral"
    || node.type === "BooleanLiteral"
  ) {
    return node.value;
  }
  if (node.type === "NullLiteral") return null;
  if (node.type === "ArrayExpression") {
    if (node.elements.some((element) => element === null)) {
      throw new Error("Configuration arrays cannot contain empty entries.");
    }
    return node.elements.map((element) => configValue(element));
  }
  if (node.type === "ObjectExpression") {
    const value = {};
    for (const property of node.properties) {
      if (
        property.type !== "ObjectProperty"
        || property.computed
        || (
          property.key.type !== "Identifier"
          && property.key.type !== "StringLiteral"
        )
      ) {
        throw new Error("Configuration objects must contain static keys.");
      }
      const key = property.key.type === "Identifier"
        ? property.key.name
        : property.key.value;
      value[key] = configValue(property.value);
    }
    return value;
  }
  throw new Error(`Unsupported configuration value ${node.type}.`);
}

function parseConfig(contents) {
  return configValue(parseExpression(contents, {
    plugins: ["typescript"],
  }));
}

export function typescriptFiles(directory) {
  if (!existsSync(directory) || !statSync(directory).isDirectory()) return [];
  return readdirSync(directory, {
    recursive: true,
    withFileTypes: true,
  })
    .filter(
      (entry) => entry.isFile()
        && TYPESCRIPT_EXTENSIONS.has(extname(entry.name)),
    )
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort();
}

function compilerPathAliases(workspaceRoot, configPaths) {
  const aliases = new Map();
  for (const configPath of configPaths) {
    const absoluteConfigPath = resolve(workspaceRoot, configPath);
    if (!existsSync(absoluteConfigPath)) {
      throw new Error(`${configPath} is missing.`);
    }
    let config;
    try {
      config = parseConfig(readFileSync(absoluteConfigPath, "utf8"));
    } catch {
      throw new Error(`${configPath} is not valid JSON or JSONC.`);
    }
    const compilerOptions = config.compilerOptions ?? {};
    const baseDirectory = resolve(
      dirname(absoluteConfigPath),
      compilerOptions.baseUrl ?? ".",
    );
    for (const [pattern, targets] of Object.entries(
      compilerOptions.paths ?? {},
    )) {
      if (
        !Array.isArray(targets)
        || targets.length === 0
        || targets.some((target) => typeof target !== "string")
      ) {
        throw new Error(
          `${configPath} has an invalid TypeScript path alias for ${pattern}.`,
        );
      }
      const resolvedTargets = targets.map((target) =>
        resolve(baseDirectory, target)
      );
      const previous = aliases.get(pattern);
      if (
        previous
        && JSON.stringify(previous) !== JSON.stringify(resolvedTargets)
      ) {
        throw new Error(
          `TypeScript path alias ${pattern} resolves differently across configs.`,
        );
      }
      aliases.set(pattern, resolvedTargets);
    }
  }
  return [...aliases]
    .map(([pattern, targets]) => {
      const wildcard = pattern.indexOf("*");
      if (wildcard >= 0 && wildcard !== pattern.lastIndexOf("*")) {
        throw new Error(
          `TypeScript path alias ${pattern} contains multiple wildcards.`,
        );
      }
      return {
        pattern,
        targets,
        prefix: wildcard >= 0 ? pattern.slice(0, wildcard) : pattern,
        suffix: wildcard >= 0 ? pattern.slice(wildcard + 1) : "",
        wildcard: wildcard >= 0,
      };
    })
    .sort((left, right) =>
      right.prefix.length - left.prefix.length
      || right.suffix.length - left.suffix.length
      || left.pattern.localeCompare(right.pattern)
    );
}

function aliasCandidates(specifier, aliases) {
  for (const alias of aliases) {
    if (!alias.wildcard) {
      if (specifier === alias.pattern) return alias.targets;
      continue;
    }
    if (
      specifier.startsWith(alias.prefix)
      && specifier.endsWith(alias.suffix)
      && specifier.length >= alias.prefix.length + alias.suffix.length
    ) {
      const matched = specifier.slice(
        alias.prefix.length,
        specifier.length - alias.suffix.length,
      );
      return alias.targets.map((target) => target.replace("*", matched));
    }
  }
  return null;
}

function moduleCandidates(basePath) {
  const extension = extname(basePath);
  if (
    extension
    && !TYPESCRIPT_EXTENSIONS.has(extension)
    && !RUNTIME_JAVASCRIPT_EXTENSIONS.has(extension)
  ) {
    return { asset: true, candidates: [] };
  }
  const base = RUNTIME_JAVASCRIPT_EXTENSIONS.has(extension)
    ? basePath.slice(0, -extension.length)
    : basePath;
  if (TYPESCRIPT_EXTENSIONS.has(extname(base))) {
    return { asset: false, candidates: [base] };
  }
  return {
    asset: false,
    candidates: [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.mts`,
      `${base}.cts`,
      `${base}.d.ts`,
      join(base, "index.ts"),
      join(base, "index.tsx"),
      join(base, "index.mts"),
      join(base, "index.cts"),
    ],
  };
}

function resolveModule(
  fromFile,
  specifier,
  aliases,
  sourceFileByCanonicalPath,
) {
  const bases = specifier.startsWith(".")
    ? [resolve(dirname(fromFile), specifier)]
    : aliasCandidates(specifier, aliases);
  if (!bases) return { kind: "external" };
  for (const base of bases) {
    const { asset, candidates } = moduleCandidates(base);
    if (asset) return { kind: "asset" };
    for (const candidate of candidates) {
      const target = sourceFileByCanonicalPath.get(canonicalPath(candidate));
      if (target) return { kind: "source", target };
    }
  }
  return { kind: "unresolved" };
}

function importIsTypeOnly(node) {
  if (node.importKind === "type") return true;
  return node.specifiers.length > 0
    && node.specifiers.every((specifier) => specifier.importKind === "type");
}

function exportIsTypeOnly(node) {
  if (node.exportKind === "type") return true;
  return node.specifiers?.length > 0
    && node.specifiers.every((specifier) => specifier.exportKind === "type");
}

function walkAst(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (
      key === "loc"
      || key === "start"
      || key === "end"
      || key === "extra"
      || key.endsWith("Comments")
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, visit);
    } else if (value && typeof value === "object") {
      walkAst(value, visit);
    }
  }
}

function moduleSyntax(file, contents) {
  const ast = parse(contents, {
    sourceType: "module",
    plugins: [
      "typescript",
      ...(file.endsWith(".tsx") ? ["jsx"] : []),
      "decorators-legacy",
      "explicitResourceManagement",
      "importAttributes",
    ],
  });
  const imports = [];
  walkAst(ast.program, (node) => {
    if (node.type === "ImportDeclaration") {
      imports.push({
        kind: "import",
        specifier: node.source.value,
        typeOnly: importIsTypeOnly(node),
        line: node.loc?.start.line ?? 1,
      });
      return;
    }
    if (
      (
        node.type === "ExportNamedDeclaration"
        || node.type === "ExportAllDeclaration"
      )
      && node.source
    ) {
      imports.push({
        kind: "export",
        specifier: node.source.value,
        typeOnly: exportIsTypeOnly(node),
        line: node.loc?.start.line ?? 1,
      });
      return;
    }
    if (
      node.type === "TSImportEqualsDeclaration"
      && node.moduleReference?.type === "TSExternalModuleReference"
      && node.moduleReference.expression?.type === "StringLiteral"
    ) {
      imports.push({
        kind: "import-equals",
        specifier: node.moduleReference.expression.value,
        typeOnly: node.importKind === "type",
        line: node.loc?.start.line ?? 1,
      });
      return;
    }
    if (
      node.type === "CallExpression"
      && node.arguments.length === 1
      && (
        node.callee?.type === "Import"
        || (
          node.callee?.type === "Identifier"
          && node.callee.name === "require"
        )
      )
    ) {
      const argument = node.arguments[0];
      imports.push({
        kind: node.callee.type === "Import"
          ? "dynamic-import"
          : "require",
        specifier: argument?.type === "StringLiteral"
          ? argument.value
          : null,
        typeOnly: false,
        line: node.loc?.start.line ?? 1,
      });
      return;
    }
    if (node.type === "ImportExpression") {
      imports.push({
        kind: "dynamic-import",
        specifier: node.source?.type === "StringLiteral"
          ? node.source.value
          : null,
        typeOnly: false,
        line: node.loc?.start.line ?? 1,
      });
    }
  });
  const pureReexport = ast.program.body.length > 0
    && ast.program.body.every((node) =>
      (
        node.type === "ExportNamedDeclaration"
        || node.type === "ExportAllDeclaration"
      )
      && Boolean(node.source)
      && !node.declaration
    );
  return { imports, pureReexport };
}

function sourceLayer(sourceDirectory, file) {
  const path = relative(sourceDirectory, file);
  return path.split(sep)[0] ?? "";
}

function graphAdjacency(files, edges) {
  const adjacency = new Map(files.map((file) => [file, new Set()]));
  for (const edge of edges) adjacency.get(edge.from)?.add(edge.to);
  return new Map(
    [...adjacency].map(([file, dependencies]) => [
      file,
      [...dependencies].sort(),
    ]),
  );
}

function stronglyConnectedComponents(files, adjacency) {
  const components = [];
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const lowLinks = new Map();
  let index = 0;
  const visit = (file) => {
    indices.set(file, index);
    lowLinks.set(file, index);
    index += 1;
    stack.push(file);
    onStack.add(file);
    for (const dependency of adjacency.get(file) ?? []) {
      if (!indices.has(dependency)) {
        visit(dependency);
        lowLinks.set(
          file,
          Math.min(lowLinks.get(file), lowLinks.get(dependency)),
        );
      } else if (onStack.has(dependency)) {
        lowLinks.set(
          file,
          Math.min(lowLinks.get(file), indices.get(dependency)),
        );
      }
    }
    if (lowLinks.get(file) !== indices.get(file)) return;
    const component = [];
    let dependency;
    do {
      dependency = stack.pop();
      onStack.delete(dependency);
      component.push(dependency);
    } while (dependency !== file);
    if (
      component.length > 1
      || adjacency.get(file)?.includes(file)
    ) {
      components.push(component.sort());
    }
  };
  for (const file of files) {
    if (!indices.has(file)) visit(file);
  }
  return components.sort((left, right) => left[0].localeCompare(right[0]));
}

function cycleTrace(component, adjacency) {
  const componentFiles = new Set(component);
  const visit = (start, current, path, active) => {
    for (const dependency of adjacency.get(current) ?? []) {
      if (!componentFiles.has(dependency)) continue;
      if (dependency === start) return [...path, start];
      if (active.has(dependency)) continue;
      active.add(dependency);
      const cycle = visit(
        start,
        dependency,
        [...path, dependency],
        active,
      );
      if (cycle) return cycle;
      active.delete(dependency);
    }
    return null;
  };
  for (const start of component) {
    const cycle = visit(start, start, [start], new Set([start]));
    if (cycle) return cycle;
  }
  return [...component, component[0]];
}

function pairedFacadeDirectory(file) {
  const parent = dirname(file);
  const name = normalizedFacadeName(
    file.slice(file.lastIndexOf(sep) + 1, -extname(file).length),
  );
  const entry = readdirSync(parent, { withFileTypes: true }).find(
    (candidate) =>
      candidate.isDirectory()
      && normalizedFacadeName(candidate.name) === name,
  );
  return entry ? resolve(parent, entry.name) : null;
}

export function analyzeSourceArchitecture({
  workspaceRoot,
  sourceDirectory = "src",
  configPaths = ["tsconfig.node.json", "tsconfig.web.json"],
  allowedLayers = DEFAULT_ALLOWED_SOURCE_LAYERS,
}) {
  const absoluteWorkspaceRoot = resolve(workspaceRoot);
  const absoluteSourceDirectory = resolve(
    absoluteWorkspaceRoot,
    sourceDirectory,
  );
  const files = typescriptFiles(absoluteSourceDirectory);
  const sourceFileByCanonicalPath = new Map(
    files.map((file) => [canonicalPath(file), file]),
  );
  const failures = [];
  let aliases;
  try {
    aliases = compilerPathAliases(absoluteWorkspaceRoot, configPaths);
  } catch (error) {
    return {
      files,
      edges: [],
      facades: [],
      cycles: [],
      failures: [
        error instanceof Error
          ? error.message
          : "TypeScript path aliases could not be loaded.",
      ],
    };
  }
  const edges = [];
  const modules = new Map();
  for (const file of files) {
    const contents = readFileSync(file, "utf8");
    let syntax;
    try {
      syntax = moduleSyntax(file, contents);
    } catch (error) {
      failures.push(
        `${workspacePath(absoluteWorkspaceRoot, file)} could not be parsed: ${
          error instanceof Error ? error.message : "unknown syntax error"
        }.`,
      );
      continue;
    }
    modules.set(file, syntax);
    for (const dependency of syntax.imports) {
      if (dependency.specifier === null) {
        failures.push(
          `${workspacePath(absoluteWorkspaceRoot, file)}:${dependency.line} uses `
          + `a non-literal ${dependency.kind} that cannot be checked for `
          + "architecture dependencies.",
        );
        continue;
      }
      const resolution = resolveModule(
        file,
        dependency.specifier,
        aliases,
        sourceFileByCanonicalPath,
      );
      if (resolution.kind === "source") {
        edges.push({
          from: file,
          to: resolution.target,
          kind: dependency.kind,
          typeOnly: dependency.typeOnly,
          line: dependency.line,
          specifier: dependency.specifier,
        });
      } else if (resolution.kind === "unresolved") {
        failures.push(
          `${workspacePath(absoluteWorkspaceRoot, file)}:${dependency.line} `
          + `cannot resolve local module ${dependency.specifier}.`,
        );
      }
    }
  }

  for (const file of files) {
    const layer = sourceLayer(absoluteSourceDirectory, file);
    if (!allowedLayers.has(layer)) {
      failures.push(
        `${workspacePath(absoluteWorkspaceRoot, file)} belongs to unknown `
        + `source layer ${layer || "(root)"}.`,
      );
    }
  }
  for (const edge of edges) {
    const fromLayer = sourceLayer(absoluteSourceDirectory, edge.from);
    const toLayer = sourceLayer(absoluteSourceDirectory, edge.to);
    if (
      fromLayer !== toLayer
      && !allowedLayers.get(fromLayer)?.has(toLayer)
    ) {
      failures.push(
        `${workspacePath(absoluteWorkspaceRoot, edge.from)}:${edge.line} crosses `
        + `source layers ${fromLayer} -> ${toLayer} via `
        + `${workspacePath(absoluteWorkspaceRoot, edge.to)}.`,
      );
    }
  }

  const adjacency = graphAdjacency(files, edges);
  const components = stronglyConnectedComponents(files, adjacency);
  const cycles = components.map((component) =>
    cycleTrace(component, adjacency)
  );
  for (const cycle of cycles) {
    failures.push(
      `src contains an import cycle: ${cycle
        .map((file) => workspacePath(absoluteWorkspaceRoot, file))
        .join(" -> ")}.`,
    );
  }

  const facades = [];
  for (const [file, syntax] of modules) {
    if (!syntax.pureReexport) continue;
    const implementationDirectory = pairedFacadeDirectory(file);
    if (!implementationDirectory) continue;
    const ownsImplementation = edges.some(
      (edge) =>
        edge.from === file
        && isContained(implementationDirectory, edge.to),
    );
    if (!ownsImplementation) continue;
    facades.push(file);
    for (const edge of edges) {
      if (
        edge.to === file
        && isContained(implementationDirectory, edge.from)
      ) {
        failures.push(
          `${workspacePath(absoluteWorkspaceRoot, edge.from)}:${edge.line} imports `
          + `its compatibility facade `
          + `${workspacePath(absoluteWorkspaceRoot, file)}.`,
        );
      }
    }
  }

  return {
    files,
    edges,
    facades: facades.sort(),
    cycles,
    failures: [...new Set(failures)].sort(),
  };
}

export function lineCeilingFailures({
  workspaceRoot,
  directory,
  ceiling,
  include = () => true,
  label,
}) {
  const absoluteWorkspaceRoot = resolve(workspaceRoot);
  const absoluteDirectory = resolve(absoluteWorkspaceRoot, directory);
  return typescriptFiles(absoluteDirectory).flatMap((file) => {
    if (!include(file)) return [];
    const lines = readFileSync(file, "utf8").split(/\r?\n/u).length;
    return lines > ceiling
      ? [
          `${workspacePath(absoluteWorkspaceRoot, file)} has ${lines} lines `
          + `(${label}: ${ceiling}).`,
        ]
      : [];
  });
}

export function isTestCaseFile(file) {
  return TEST_CASE_PATTERN.test(file);
}
