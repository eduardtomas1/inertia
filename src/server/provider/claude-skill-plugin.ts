import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import type {
  Settings,
  SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";

import { FILE_OPEN_NO_FOLLOW } from
  "../../node/platform-file-open-flags";
import type { ProviderSkillInput } from "../../shared/contracts";
import {
  checkClaudeSkillOperation,
  runClaudeSkillFilesystemOperation,
  type ClaudeSkillOperationControl,
} from "./claude-skill-operation";

const MAX_DISCOVERED_SKILLS = 128;
const MAX_DISCOVERY_ENTRIES = 512;
const MAX_PROJECT_ANCESTORS = 64;
const MAX_SKILL_FILE_BYTES = 256 * 1024;
const MAX_SKILL_DESCRIPTION_CHARS = 4_096;
const MAX_SKILL_ARGUMENT_HINT_CHARS = 512;
const MAX_STAGED_FILES = 256;
const MAX_STAGED_FILE_BYTES = 1024 * 1024;
const MAX_STAGED_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_STAGED_DEPTH = 12;

export const CLAUDE_ISOLATED_SKILL_PLUGIN_NAME = "inertia-selected-skills";

export const CLAUDE_ISOLATED_SKILL_SETTINGS = {
  disableAllHooks: true,
  disableSkillShellExecution: true,
  disableBundledSkills: true,
  disableClaudeAiConnectors: true,
  syncClaudeAiSkills: false,
  allowedMcpServers: [],
  strictPluginOnlyCustomization: ["skills", "agents", "hooks", "mcp"],
} as const satisfies Settings;

export interface ClaudeFilesystemSkill extends SlashCommand {
  /** Privileged capability data. Never serialize this field to the renderer. */
  path: string;
  scope: "repo" | "user";
}

type ClaudeSkillInput = Extract<
  ProviderSkillInput,
  { source: "claude-native" }
>;

interface SkillRoot {
  container: string;
  skillsDirectory: string;
  scope: ClaudeFilesystemSkill["scope"];
}

export interface StagedClaudeSkillPlugin {
  path: string;
  skillNames: string[];
  cleanup: () => Promise<void>;
}

interface CopyBudget {
  files: number;
  bytes: number;
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const expected = process.platform === "win32" ? name.toLowerCase() : name;
  return Object.entries(environment).find(([key]) =>
    (process.platform === "win32" ? key.toLowerCase() : key) === expected
  )?.[1];
}

function isContainedPath(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === ""
    || (
      fromRoot !== ".."
      && !fromRoot.startsWith(`..${sep}`)
      && !isAbsolute(fromRoot)
    );
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const trailing = value.charCodeAt(index + 1);
      if (trailing < 0xdc00 || trailing > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

async function plainPathComponents(
  root: string,
  candidate: string,
  control: ClaudeSkillOperationControl,
): Promise<boolean> {
  const fromRoot = relative(root, candidate);
  if (!isContainedPath(root, candidate)) return false;
  let current = root;
  for (const component of fromRoot.split(sep).filter(Boolean)) {
    checkClaudeSkillOperation(control);
    current = join(current, component);
    try {
      const status = await runClaudeSkillFilesystemOperation(
        control,
        "lstat",
        current,
        async () => await lstat(current),
      );
      if (status.isSymbolicLink()) return false;
    } catch {
      checkClaudeSkillOperation(control);
      return false;
    }
  }
  return true;
}

async function canonicalDirectory(
  path: string,
  control: ClaudeSkillOperationControl,
): Promise<string | null> {
  try {
    const status = await runClaudeSkillFilesystemOperation(
      control,
      "lstat",
      path,
      async () => await lstat(path),
    );
    if (!status.isDirectory() || status.isSymbolicLink()) return null;
    return await runClaudeSkillFilesystemOperation(
      control,
      "realpath",
      path,
      async () => await realpath(path),
    );
  } catch {
    checkClaudeSkillOperation(control);
    return null;
  }
}

async function projectSkillRoots(
  cwd: string,
  control: ClaudeSkillOperationControl,
): Promise<SkillRoot[]> {
  const canonicalCwd = await runClaudeSkillFilesystemOperation(
    control,
    "realpath",
    cwd,
    async () => await realpath(cwd),
  );
  const ancestors: string[] = [];
  let current = canonicalCwd;
  let repositoryRoot: string | null = null;
  for (let depth = 0; depth < MAX_PROJECT_ANCESTORS; depth += 1) {
    checkClaudeSkillOperation(control);
    ancestors.push(current);
    try {
      const markerPath = join(current, ".git");
      const marker = await runClaudeSkillFilesystemOperation(
        control,
        "lstat",
        markerPath,
        async () => await lstat(markerPath),
      );
      if (!marker.isSymbolicLink() && (marker.isDirectory() || marker.isFile())) {
        repositoryRoot = current;
        break;
      }
    } catch {
      checkClaudeSkillOperation(control);
      // Keep walking to the nearest repository marker.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const scopedAncestors = repositoryRoot
    ? ancestors.slice(0, ancestors.indexOf(repositoryRoot) + 1)
    : ancestors.slice(0, 1);
  return scopedAncestors.map((container) => ({
    container,
    skillsDirectory: join(container, ".claude", "skills"),
    scope: "repo",
  }));
}

async function userSkillRoot(
  environment: NodeJS.ProcessEnv,
  control: ClaudeSkillOperationControl,
): Promise<SkillRoot | null> {
  const configured = environmentValue(environment, "CLAUDE_CONFIG_DIR")?.trim();
  const home = environmentValue(environment, "HOME")?.trim()
    ?? environmentValue(environment, "USERPROFILE")?.trim();
  const requestedContainer = configured && isAbsolute(configured)
    ? configured
    : home && isAbsolute(home)
      ? join(home, ".claude")
      : null;
  if (!requestedContainer) return null;
  const container = await canonicalDirectory(requestedContainer, control);
  if (!container) return null;
  return {
    container,
    skillsDirectory: join(container, "skills"),
    scope: "user",
  };
}

async function claudeSkillRoots(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  control: ClaudeSkillOperationControl,
): Promise<SkillRoot[]> {
  const project = await projectSkillRoots(cwd, control);
  const user = await userSkillRoot(environment, control);
  return user ? [...project, user] : project;
}

function exactSkillName(value: string): string | null {
  if (
    value.length === 0
    || value.length > 160
    || value !== value.trim()
    || hasUnpairedSurrogate(value)
    || /[(),\u0000-\u001f\u007f-\u009f]/u.test(value)
    || value === "."
    || value === ".."
    || value.includes("/")
    || value.includes("\\")
    || value === "*"
    || value.endsWith(":*")
    || value.startsWith("/")
  ) return null;
  return value;
}

async function readBoundedRegularFile(
  path: string,
  containmentRoot: string,
  maximumBytes: number,
  control: ClaudeSkillOperationControl,
): Promise<Buffer | null> {
  let before: Awaited<ReturnType<typeof lstat>>;
  let resolvedBefore: string;
  try {
    before = await runClaudeSkillFilesystemOperation(
      control,
      "lstat",
      path,
      async () => await lstat(path),
    );
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || before.size > maximumBytes
      || !await plainPathComponents(containmentRoot, path, control)
    ) return null;
    resolvedBefore = await runClaudeSkillFilesystemOperation(
      control,
      "realpath",
      path,
      async () => await realpath(path),
    );
    if (!isContainedPath(containmentRoot, resolvedBefore)) return null;
  } catch {
    checkClaudeSkillOperation(control);
    return null;
  }

  const noFollow = process.platform === "win32" ? 0 : FILE_OPEN_NO_FOLLOW;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await runClaudeSkillFilesystemOperation(
      control,
      "open",
      path,
      async () => await open(path, constants.O_RDONLY | noFollow),
      async (opened) => await opened.close().catch(() => undefined),
    );
    const opened = await runClaudeSkillFilesystemOperation(
      control,
      "fstat",
      path,
      async () => await handle!.stat(),
    );
    const resolvedAfterOpen = await runClaudeSkillFilesystemOperation(
      control,
      "realpath",
      path,
      async () => await realpath(path),
    );
    if (
      !opened.isFile()
      || opened.size > maximumBytes
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || resolvedAfterOpen !== resolvedBefore
    ) return null;
    const output = Buffer.alloc(Math.min(maximumBytes + 1, opened.size + 1));
    let offset = 0;
    while (offset < output.length) {
      checkClaudeSkillOperation(control);
      const { bytesRead } = await runClaudeSkillFilesystemOperation(
        control,
        "read",
        path,
        async () => await handle!.read(
          output,
          offset,
          output.length - offset,
          offset,
        ),
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumBytes) return null;
    return output.subarray(0, offset);
  } catch {
    checkClaudeSkillOperation(control);
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function yamlScalar(
  lines: readonly string[],
  index: number,
  rawValue: string,
): { nextIndex: number; value: string } | null {
  const value = rawValue.trim();
  if (/^[|>][-+]?$/u.test(value)) {
    const folded = value.startsWith(">");
    const continuation: string[] = [];
    let nextIndex = index + 1;
    while (nextIndex < lines.length) {
      const line = lines[nextIndex]!;
      if (line.length > 0 && !/^\s/u.test(line)) break;
      continuation.push(line.replace(/^\s{1,8}/u, ""));
      nextIndex += 1;
    }
    return {
      nextIndex,
      value: folded
        ? continuation.join(" ").replace(/\s+/gu, " ").trim()
        : continuation.join("\n").trim(),
    };
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === "string"
        ? { nextIndex: index + 1, value: parsed }
        : null;
    } catch {
      return null;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return {
      nextIndex: index + 1,
      value: value.slice(1, -1).replace(/''/gu, "'"),
    };
  }
  if (value === "" || /^[!&*[{]/u.test(value)) return null;
  return { nextIndex: index + 1, value };
}

function parseSkillFrontmatter(
  content: Buffer,
  directoryName: string,
): Omit<ClaudeFilesystemSkill, "path" | "scope"> | null {
  const text = content.toString("utf8");
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return null;
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  const closing = lines.slice(1, 257).findIndex((line) => line === "---");
  if (closing < 0) return null;
  const frontmatter = lines.slice(1, closing + 1);
  const values = new Map<string, string>();
  for (let index = 0; index < frontmatter.length;) {
    const line = frontmatter[index]!;
    if (line.trim() === "" || /^\s*#/u.test(line)) {
      index += 1;
      continue;
    }
    const field = /^([A-Za-z][A-Za-z0-9_-]{0,63}):(?:\s*(.*))?$/u.exec(line);
    if (!field) {
      index += 1;
      continue;
    }
    const scalar = yamlScalar(frontmatter, index, field[2] ?? "");
    if (!scalar) return null;
    values.set(field[1]!, scalar.value);
    index = scalar.nextIndex;
  }

  const explicitName = values.get("name");
  const name = exactSkillName(explicitName ?? directoryName);
  const description = values.get("description")?.trim();
  const argumentHint = (
    values.get("argument-hint")
    ?? values.get("argument_hint")
    ?? ""
  ).trim();
  if (
    !name
    || name !== directoryName
    || !description
    || description.length > MAX_SKILL_DESCRIPTION_CHARS
    || hasUnpairedSurrogate(description)
    || description.includes("\0")
    || argumentHint.length > MAX_SKILL_ARGUMENT_HINT_CHARS
    || hasUnpairedSurrogate(argumentHint)
    || argumentHint.includes("\0")
  ) return null;
  return { name, description, argumentHint };
}

async function discoverRootSkills(
  root: SkillRoot,
  state: { bytes: number; entries: number; skills: number },
  control: ClaudeSkillOperationControl,
): Promise<ClaudeFilesystemSkill[]> {
  checkClaudeSkillOperation(control);
  if (state.entries >= MAX_DISCOVERY_ENTRIES) return [];
  let skillsDirectory: string;
  try {
    const status = await runClaudeSkillFilesystemOperation(
      control,
      "lstat",
      root.skillsDirectory,
      async () => await lstat(root.skillsDirectory),
    );
    if (
      !status.isDirectory()
      || status.isSymbolicLink()
      || !await plainPathComponents(
        root.container,
        root.skillsDirectory,
        control,
      )
    ) return [];
    skillsDirectory = await runClaudeSkillFilesystemOperation(
      control,
      "realpath",
      root.skillsDirectory,
      async () => await realpath(root.skillsDirectory),
    );
    if (!isContainedPath(root.container, skillsDirectory)) return [];
  } catch {
    checkClaudeSkillOperation(control);
    return [];
  }

  const skills: ClaudeFilesystemSkill[] = [];
  const directory = await runClaudeSkillFilesystemOperation(
    control,
    "opendir",
    skillsDirectory,
    async () => await opendir(skillsDirectory),
    async (opened) => await opened.close().catch(() => undefined),
  );
  try {
    while (true) {
      checkClaudeSkillOperation(control);
      const entry = await runClaudeSkillFilesystemOperation(
        control,
        "readdir",
        skillsDirectory,
        async () => await directory.read(),
      );
      if (!entry) break;
      if (
        state.entries >= MAX_DISCOVERY_ENTRIES
        || state.skills >= MAX_DISCOVERED_SKILLS
      ) break;
      state.entries += 1;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const name = exactSkillName(entry.name);
      if (!name) continue;
      const skillDirectory = join(skillsDirectory, entry.name);
      const skillPath = join(skillDirectory, "SKILL.md");
      if (!await plainPathComponents(skillsDirectory, skillPath, control)) continue;
      const content = await readBoundedRegularFile(
        skillPath,
        skillsDirectory,
        MAX_SKILL_FILE_BYTES,
        control,
      );
      if (!content) continue;
      if (state.bytes + content.byteLength > MAX_STAGED_TOTAL_BYTES) {
        state.entries = MAX_DISCOVERY_ENTRIES;
        break;
      }
      state.bytes += content.byteLength;
      const metadata = parseSkillFrontmatter(content, name);
      if (!metadata) continue;
      const resolvedPath = await runClaudeSkillFilesystemOperation(
        control,
        "realpath",
        skillPath,
        async () => await realpath(skillPath),
      );
      if (!isContainedPath(skillsDirectory, resolvedPath)) continue;
      skills.push({
        ...metadata,
        path: resolvedPath,
        scope: root.scope,
      });
      state.skills += 1;
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return skills;
}

/**
 * Discovers only ordinary user/project Claude skill files. Settings, hooks,
 * permissions, agents, commands, plugins, and MCP definitions are never read.
 */
export async function discoverClaudeFilesystemSkills(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  control: ClaudeSkillOperationControl = {},
): Promise<ClaudeFilesystemSkill[]> {
  const roots = await claudeSkillRoots(cwd, environment, control);
  const state = { bytes: 0, entries: 0, skills: 0 };
  const skills: ClaudeFilesystemSkill[] = [];
  for (const root of roots) {
    checkClaudeSkillOperation(control);
    skills.push(...await discoverRootSkills(root, state, control));
    if (
      state.entries >= MAX_DISCOVERY_ENTRIES
      || state.skills >= MAX_DISCOVERED_SKILLS
    ) break;
  }
  return skills.slice(0, MAX_DISCOVERED_SKILLS);
}

async function matchingCapabilityRoot(
  skill: ClaudeSkillInput,
  roots: readonly SkillRoot[],
  control: ClaudeSkillOperationControl,
): Promise<{ root: SkillRoot; skillDirectory: string } | null> {
  if (!isAbsolute(skill.path) || exactSkillName(skill.name) !== skill.name) {
    return null;
  }
  if (basename(dirname(skill.path)) !== skill.name) return null;
  for (const root of roots) {
    checkClaudeSkillOperation(control);
    const candidate = join(root.skillsDirectory, skill.name, "SKILL.md");
    if (resolve(candidate) !== resolve(skill.path)) continue;
    try {
      if (
        !await plainPathComponents(root.container, candidate, control)
        || await runClaudeSkillFilesystemOperation(
          control,
          "realpath",
          candidate,
          async () => await realpath(candidate),
        ) !== skill.path
      ) continue;
      return { root, skillDirectory: dirname(candidate) };
    } catch {
      checkClaudeSkillOperation(control);
      // The capability no longer names an ordinary current skill.
    }
  }
  return null;
}

async function copyBoundedDirectory(
  sourceRoot: string,
  source: string,
  destination: string,
  budget: CopyBudget,
  depth: number,
  control: ClaudeSkillOperationControl,
): Promise<void> {
  checkClaudeSkillOperation(control);
  if (depth > MAX_STAGED_DEPTH) {
    throw new Error("A selected Claude skill exceeds the directory depth limit.");
  }
  const sourceStatus = await runClaudeSkillFilesystemOperation(
    control,
    "lstat",
    source,
    async () => await lstat(source),
  );
  if (!sourceStatus.isDirectory() || sourceStatus.isSymbolicLink()) {
    throw new Error("A selected Claude skill contains an unsupported filesystem entry.");
  }
  const resolvedSource = await runClaudeSkillFilesystemOperation(
    control,
    "realpath",
    source,
    async () => await realpath(source),
  );
  if (!isContainedPath(sourceRoot, resolvedSource)) {
    throw new Error("A selected Claude skill escaped its validated directory.");
  }
  await runClaudeSkillFilesystemOperation(
    control,
    "mkdir",
    destination,
    async () => await mkdir(destination, { mode: 0o700 }),
  );
  const directory = await runClaudeSkillFilesystemOperation(
    control,
    "opendir",
    source,
    async () => await opendir(source),
    async (opened) => await opened.close().catch(() => undefined),
  );
  try {
    while (true) {
      checkClaudeSkillOperation(control);
      const entry = await runClaudeSkillFilesystemOperation(
        control,
        "readdir",
        source,
        async () => await directory.read(),
      );
      if (!entry) break;
      const sourcePath = join(source, entry.name);
      const destinationPath = join(destination, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error("A selected Claude skill contains a symbolic link.");
      }
      if (entry.isDirectory()) {
        await copyBoundedDirectory(
          sourceRoot,
          sourcePath,
          destinationPath,
          budget,
          depth + 1,
          control,
        );
        continue;
      }
      if (!entry.isFile()) {
        throw new Error("A selected Claude skill contains an unsupported filesystem entry.");
      }
      budget.files += 1;
      if (budget.files > MAX_STAGED_FILES) {
        throw new Error("Selected Claude skills exceed the file count limit.");
      }
      const content = await readBoundedRegularFile(
        sourcePath,
        sourceRoot,
        MAX_STAGED_FILE_BYTES,
        control,
      );
      if (!content) {
        throw new Error("A selected Claude skill file could not be revalidated.");
      }
      budget.bytes += content.byteLength;
      if (budget.bytes > MAX_STAGED_TOTAL_BYTES) {
        throw new Error("Selected Claude skills exceed the copied byte limit.");
      }
      await runClaudeSkillFilesystemOperation(
        control,
        "writeFile",
        destinationPath,
        async () => await writeFile(
          destinationPath,
          content,
          { mode: 0o600, flag: "wx" },
        ),
      );
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  if (await runClaudeSkillFilesystemOperation(
    control,
    "realpath",
    source,
    async () => await realpath(source),
  ) !== resolvedSource) {
    throw new Error("A selected Claude skill changed while it was being copied.");
  }
}

/**
 * Copies revalidated selected skills into one fresh skill-only SDK plugin.
 * The copied plugin contains no settings, hooks, agents, commands, or MCP data.
 */
export async function stageClaudeSkillPlugin(
  skills: readonly ClaudeSkillInput[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  options: ClaudeSkillOperationControl & { metadataOnly?: boolean } = {},
): Promise<StagedClaudeSkillPlugin | null> {
  checkClaudeSkillOperation(options);
  if (skills.length === 0) return null;
  if (skills.length > MAX_DISCOVERED_SKILLS) {
    throw new Error("Claude skill staging exceeds the bounded skill limit.");
  }
  const roots = await claudeSkillRoots(cwd, environment, options);
  const uniqueNames = new Set<string>();
  const selected: Array<{
    input: ClaudeSkillInput;
    metadataContent: Buffer;
    sourceRoot: string;
    skillDirectory: string;
  }> = [];
  for (const input of skills) {
    checkClaudeSkillOperation(options);
    if (uniqueNames.has(input.name)) {
      throw new Error("Selected Claude skill names must be unique.");
    }
    uniqueNames.add(input.name);
    const matched = await matchingCapabilityRoot(input, roots, options);
    if (!matched) {
      throw new Error("A selected Claude skill is no longer available.");
    }
    const metadataContent = await readBoundedRegularFile(
      input.path,
      matched.skillDirectory,
      MAX_SKILL_FILE_BYTES,
      options,
    );
    if (!metadataContent || !parseSkillFrontmatter(metadataContent, input.name)) {
      throw new Error("A selected Claude skill failed revalidation.");
    }
    selected.push({
      input,
      metadataContent,
      sourceRoot: matched.skillDirectory,
      skillDirectory: matched.skillDirectory,
    });
  }

  const tempPrefix = join(tmpdir(), "inertia-claude-skills-");
  const pluginPath = await runClaudeSkillFilesystemOperation(
    options,
    "mkdtemp",
    tempPrefix,
    async () => await mkdtemp(tempPrefix, { encoding: "utf8" }),
    async (abandonedPath) => await rm(abandonedPath, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 4 : 0,
      retryDelay: 100,
    }),
  );
  const cleanup = async (): Promise<void> => {
    await rm(pluginPath, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 4 : 0,
      retryDelay: 100,
    });
  };
  try {
    const manifestDirectory = join(pluginPath, ".claude-plugin");
    await runClaudeSkillFilesystemOperation(
      options,
      "mkdir",
      manifestDirectory,
      async () => await mkdir(manifestDirectory, { mode: 0o700 }),
    );
    const skillsDirectory = join(pluginPath, "skills");
    await runClaudeSkillFilesystemOperation(
      options,
      "mkdir",
      skillsDirectory,
      async () => await mkdir(skillsDirectory, { mode: 0o700 }),
    );
    const manifestPath = join(manifestDirectory, "plugin.json");
    await runClaudeSkillFilesystemOperation(
      options,
      "writeFile",
      manifestPath,
      async () => await writeFile(
        manifestPath,
        JSON.stringify({
          name: CLAUDE_ISOLATED_SKILL_PLUGIN_NAME,
          description: "Ephemeral Inertia-selected Claude skills.",
          version: "1.0.0",
        }),
        { mode: 0o600, flag: "wx" },
      ),
    );
    const budget: CopyBudget = { files: 0, bytes: 0 };
    for (const skill of selected) {
      checkClaudeSkillOperation(options);
      const destination = join(pluginPath, "skills", skill.input.name);
      if (options.metadataOnly) {
        await runClaudeSkillFilesystemOperation(
          options,
          "mkdir",
          destination,
          async () => await mkdir(destination, { mode: 0o700 }),
        );
        budget.files += 1;
        budget.bytes += skill.metadataContent.byteLength;
        if (
          budget.files > MAX_STAGED_FILES
          || budget.bytes > MAX_STAGED_TOTAL_BYTES
        ) {
          throw new Error("Discovered Claude skills exceed the staging limits.");
        }
        const metadataPath = join(destination, "SKILL.md");
        await runClaudeSkillFilesystemOperation(
          options,
          "writeFile",
          metadataPath,
          async () => await writeFile(
            metadataPath,
            skill.metadataContent,
            { mode: 0o600, flag: "wx" },
          ),
        );
      } else {
        await copyBoundedDirectory(
          skill.sourceRoot,
          skill.skillDirectory,
          destination,
          budget,
          0,
          options,
        );
      }
    }
    return {
      path: pluginPath,
      skillNames: selected.map(({ input }) =>
        `${CLAUDE_ISOLATED_SKILL_PLUGIN_NAME}:${input.name}`),
      cleanup,
    };
  } catch (error) {
    await cleanup().catch(() => undefined);
    throw error;
  }
}

export function claudePluginLoadedSelectedSkills(
  message: unknown,
  staged: StagedClaudeSkillPlugin,
): boolean {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  if (record.type !== "system" || record.subtype !== "init") return false;
  const plugins = Array.isArray(record.plugins) ? record.plugins : [];
  const skills = Array.isArray(record.skills)
    ? record.skills.filter((value): value is string => typeof value === "string")
    : [];
  const loadedPlugin = plugins.some((value) => {
    if (!value || typeof value !== "object") return false;
    const plugin = value as Record<string, unknown>;
    return plugin.name === CLAUDE_ISOLATED_SKILL_PLUGIN_NAME
      && typeof plugin.path === "string"
      && resolve(plugin.path) === resolve(staged.path);
  });
  return loadedPlugin
    && staged.skillNames.every((name) => skills.includes(name));
}
