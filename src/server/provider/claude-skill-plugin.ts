import { lstat, mkdir, mkdtemp, opendir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import type {
  Settings,
  SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";

import type { ProviderSkillInput } from "../../shared/contracts";
import {
  claudeLinkPolicy,
  claudeLinkTargetAllowed,
  claudeProjectDirectories,
  claudeUserConfigHome,
  hasUnpairedSurrogate,
  resolveClaudeLinkTarget,
  type ClaudeLinkPolicy,
  isContainedPath,
  plainPathComponents,
  readBoundedRegularFile,
} from "./claude-config-files";
import {
  frontmatterString,
  parseClaudeFrontmatter,
} from "./claude-frontmatter";
import {
  checkClaudeSkillOperation,
  runClaudeSkillFilesystemOperation,
  type ClaudeSkillOperationControl,
} from "./claude-skill-operation";

const MAX_DISCOVERED_SKILLS = 128;
const MAX_DISCOVERY_ENTRIES = 512;
const MAX_SKILL_FILE_BYTES = 256 * 1024;
const MAX_SKILL_DESCRIPTION_CHARS = 4_096;
const MAX_SKILL_ARGUMENT_HINT_CHARS = 512;
const MAX_SKILL_DELEGATION_CHARS = 160;
const MAX_STAGED_FILES = 256;
const MAX_STAGED_FILE_BYTES = 1024 * 1024;
const MAX_STAGED_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_UNSELECTED_SKILL_FILES = 64;
const MAX_UNSELECTED_SKILL_BYTES = 2 * 1024 * 1024;
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
  links: ClaudeLinkPolicy;
}

interface SkillMetadata {
  name: string;
  description: string;
  argumentHint: string;
  context?: string;
  agent?: string;
}

interface DiscoveredSkill {
  skill: ClaudeFilesystemSkill;
  stagedContent: Buffer;
  skillDirectory: string;
}

interface StagingEntry {
  name: string;
  skillContent: Buffer;
  sourceRoot: string;
  skillDirectory: string;
  selected: boolean;
}

export interface StagedClaudeSkillPlugin {
  path: string;
  skillNames: string[];
  selectedSkillNames: string[];
  cleanup: () => Promise<void>;
}

interface CopyBudget {
  files: number;
  bytes: number;
  maxFiles: number;
  maxBytes: number;
}

async function claudeSkillRoots(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  control: ClaudeSkillOperationControl,
): Promise<SkillRoot[]> {
  const links = await claudeLinkPolicy(environment, control);
  const directories = await claudeProjectDirectories(cwd, control);
  const repositoryLinks = { ...links, repository: directories.at(-1) };
  const project = directories.map(
    (container): SkillRoot => ({
      container,
      skillsDirectory: join(container, ".claude", "skills"),
      scope: "repo",
      links: repositoryLinks,
    }),
  );
  const userHome = await claudeUserConfigHome(environment, control);
  return userHome
    ? [...project, {
        container: userHome,
        skillsDirectory: join(userHome, "skills"),
        scope: "user",
        links,
      }]
    : project;
}

async function realSkillsDirectory(
  root: SkillRoot,
  control: ClaudeSkillOperationControl,
): Promise<string | null> {
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
    ) return null;
    const skillsDirectory = await runClaudeSkillFilesystemOperation(
      control,
      "realpath",
      root.skillsDirectory,
      async () => await realpath(root.skillsDirectory),
    );
    return isContainedPath(root.container, skillsDirectory) ? skillsDirectory : null;
  } catch {
    checkClaudeSkillOperation(control);
    return null;
  }
}

async function resolveSkillDirectory(
  root: SkillRoot,
  skillsDirectory: string,
  name: string,
  control: ClaudeSkillOperationControl,
): Promise<string | null> {
  if (exactSkillName(name) !== name) return null;
  const entry = join(skillsDirectory, name);
  let status: Awaited<ReturnType<typeof lstat>>;
  try {
    status = await runClaudeSkillFilesystemOperation(
      control,
      "lstat",
      entry,
      async () => await lstat(entry),
    );
  } catch {
    checkClaudeSkillOperation(control);
    return null;
  }
  if (!status.isSymbolicLink() && !status.isDirectory()) return null;
  const target = await resolveClaudeLinkTarget(entry, "directory", control);
  if (!target) return null;
  if (!status.isSymbolicLink()) {
    return target === entry ? target : null;
  }
  return !isContainedPath(target, skillsDirectory)
    && claudeLinkTargetAllowed(target, root.links, "skills")
    ? target
    : null;
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

function delegationField(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed
    && trimmed.length <= MAX_SKILL_DELEGATION_CHARS
    && !hasUnpairedSurrogate(trimmed)
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(trimmed)
    ? trimmed
    : undefined;
}

function stagedSkillContent(body: string, metadata: SkillMetadata): Buffer {
  return Buffer.from([
    "---",
    `name: ${JSON.stringify(metadata.name)}`,
    `description: ${JSON.stringify(metadata.description)}`,
    ...(metadata.argumentHint
      ? [`argument-hint: ${JSON.stringify(metadata.argumentHint)}`]
      : []),
    ...(metadata.context ? [`context: ${JSON.stringify(metadata.context)}`] : []),
    ...(metadata.agent ? [`agent: ${JSON.stringify(metadata.agent)}`] : []),
    "---",
    body,
  ].join("\n"), "utf8");
}

function parseSkill(
  content: Buffer,
  directoryName: string,
): { metadata: SkillMetadata; stagedContent: Buffer } | null {
  const parsed = parseClaudeFrontmatter(content.toString("utf8"));
  if (!parsed) return null;
  const { fields } = parsed;
  const explicitName = fields.get("name");
  if (explicitName !== undefined && typeof explicitName !== "string") return null;
  const name = exactSkillName(explicitName || directoryName);
  const description = frontmatterString(fields, "description")?.trim();
  const rawHint = fields.get("argument-hint") ?? fields.get("argument_hint");
  const argumentHint = (
    typeof rawHint === "string"
      ? rawHint
      : Array.isArray(rawHint) ? `[${rawHint.join(", ")}]` : ""
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
  const context = delegationField(frontmatterString(fields, "context"));
  const agent = delegationField(frontmatterString(fields, "agent"));
  const metadata: SkillMetadata = {
    name,
    description,
    argumentHint,
    ...(context ? { context } : {}),
    ...(agent ? { agent } : {}),
  };
  return { metadata, stagedContent: stagedSkillContent(parsed.body, metadata) };
}

async function discoverRootSkills(
  root: SkillRoot,
  state: { bytes: number; entries: number; skills: number },
  control: ClaudeSkillOperationControl,
): Promise<DiscoveredSkill[]> {
  checkClaudeSkillOperation(control);
  if (state.entries >= MAX_DISCOVERY_ENTRIES) return [];
  const skillsDirectory = await realSkillsDirectory(root, control);
  if (!skillsDirectory) return [];

  const skills: DiscoveredSkill[] = [];
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
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const name = exactSkillName(entry.name);
      if (!name) continue;
      const skillDirectory = await resolveSkillDirectory(
        root,
        skillsDirectory,
        name,
        control,
      );
      if (!skillDirectory) continue;
      const skillPath = join(skillDirectory, "SKILL.md");
      const content = await readBoundedRegularFile(
        skillPath,
        skillDirectory,
        MAX_SKILL_FILE_BYTES,
        control,
      );
      if (!content) continue;
      if (state.bytes + content.byteLength > MAX_STAGED_TOTAL_BYTES) {
        state.entries = MAX_DISCOVERY_ENTRIES;
        break;
      }
      state.bytes += content.byteLength;
      const parsed = parseSkill(content, name);
      if (!parsed) continue;
      const resolvedPath = await runClaudeSkillFilesystemOperation(
        control,
        "realpath",
        skillPath,
        async () => await realpath(skillPath),
      );
      if (!isContainedPath(skillDirectory, resolvedPath)) continue;
      skills.push({
        skill: {
          name: parsed.metadata.name,
          description: parsed.metadata.description,
          argumentHint: parsed.metadata.argumentHint,
          path: resolvedPath,
          scope: root.scope,
        },
        stagedContent: parsed.stagedContent,
        skillDirectory,
      });
      state.skills += 1;
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return skills;
}

async function discoverSkillsInRoots(
  roots: readonly SkillRoot[],
  control: ClaudeSkillOperationControl,
): Promise<DiscoveredSkill[]> {
  const state = { bytes: 0, entries: 0, skills: 0 };
  const skills: DiscoveredSkill[] = [];
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
  return (await discoverSkillsInRoots(roots, control)).map(({ skill }) => skill);
}

async function matchingCapabilityRoot(
  skill: ClaudeSkillInput,
  roots: readonly SkillRoot[],
  control: ClaudeSkillOperationControl,
): Promise<{ root: SkillRoot; skillDirectory: string } | null> {
  if (!isAbsolute(skill.path) || exactSkillName(skill.name) !== skill.name) {
    return null;
  }
  for (const root of roots) {
    checkClaudeSkillOperation(control);
    const skillsDirectory = await realSkillsDirectory(root, control);
    const skillDirectory = skillsDirectory
      ? await resolveSkillDirectory(root, skillsDirectory, skill.name, control)
      : null;
    if (!skillDirectory) continue;
    const candidate = join(skillDirectory, "SKILL.md");
    if (resolve(candidate) !== resolve(skill.path)) continue;
    try {
      if (
        !await plainPathComponents(skillDirectory, candidate, control)
        || await runClaudeSkillFilesystemOperation(
          control,
          "realpath",
          candidate,
          async () => await realpath(candidate),
        ) !== skill.path
      ) continue;
      return { root, skillDirectory };
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
      if (depth === 0 && entry.name.toLowerCase() === "skill.md") continue;
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
      if (budget.files > budget.maxFiles) {
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
      if (budget.bytes > budget.maxBytes) {
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

async function selectedStagingEntries(
  skills: readonly ClaudeSkillInput[],
  roots: readonly SkillRoot[],
  control: ClaudeSkillOperationControl,
): Promise<StagingEntry[]> {
  const uniqueNames = new Set<string>();
  const selected: StagingEntry[] = [];
  for (const input of skills) {
    checkClaudeSkillOperation(control);
    if (uniqueNames.has(input.name)) {
      throw new Error("Selected Claude skill names must be unique.");
    }
    uniqueNames.add(input.name);
    const matched = await matchingCapabilityRoot(input, roots, control);
    if (!matched) {
      throw new Error("A selected Claude skill is no longer available.");
    }
    const metadataContent = await readBoundedRegularFile(
      input.path,
      matched.skillDirectory,
      MAX_SKILL_FILE_BYTES,
      control,
    );
    const parsed = metadataContent ? parseSkill(metadataContent, input.name) : null;
    if (!parsed) {
      throw new Error("A selected Claude skill failed revalidation.");
    }
    selected.push({
      name: input.name,
      skillContent: parsed.stagedContent,
      sourceRoot: matched.skillDirectory,
      skillDirectory: matched.skillDirectory,
      selected: true,
    });
  }
  return selected;
}

function unselectedStagingEntries(
  discovered: readonly DiscoveredSkill[],
  selectedNames: ReadonlySet<string>,
): StagingEntry[] {
  const precedence = [
    ...discovered.filter(({ skill }) => skill.scope === "user"),
    ...discovered.filter(({ skill }) => skill.scope === "repo"),
  ];
  const names = new Set(selectedNames);
  const entries: StagingEntry[] = [];
  for (const { skill, stagedContent, skillDirectory } of precedence) {
    if (names.has(skill.name)) continue;
    names.add(skill.name);
    entries.push({
      name: skill.name,
      skillContent: stagedContent,
      sourceRoot: skillDirectory,
      skillDirectory,
      selected: false,
    });
  }
  return entries;
}

function preferredFirst(
  entries: readonly StagingEntry[],
  preferred: ReadonlySet<string>,
): StagingEntry[] {
  return [
    ...entries.filter(({ name }) => preferred.has(name)),
    ...entries.filter(({ name }) => !preferred.has(name)),
  ];
}

async function preferredDiscoveredSkills(
  roots: readonly SkillRoot[],
  control: ClaudeSkillOperationControl,
): Promise<DiscoveredSkill[]> {
  const state = { bytes: 0, entries: 0, skills: 0 };
  const skills: DiscoveredSkill[] = [];
  for (const root of roots) {
    checkClaudeSkillOperation(control);
    try {
      skills.push(...await discoverRootSkills(root, state, control));
    } catch {
      checkClaudeSkillOperation(control);
    }
    if (state.entries >= MAX_DISCOVERY_ENTRIES || state.skills >= MAX_DISCOVERED_SKILLS) break;
  }
  return skills.slice(0, MAX_DISCOVERED_SKILLS);
}

async function stageSkillEntry(
  skill: StagingEntry,
  destination: string,
  budget: CopyBudget,
  options: ClaudeSkillOperationControl & { metadataOnly?: boolean },
): Promise<void> {
  if (options.metadataOnly) {
    await runClaudeSkillFilesystemOperation(
      options,
      "mkdir",
      destination,
      async () => await mkdir(destination, { mode: 0o700 }),
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
  budget.files += 1;
  budget.bytes += skill.skillContent.byteLength;
  if (budget.files > budget.maxFiles || budget.bytes > budget.maxBytes) {
    throw new Error(options.metadataOnly
      ? "Discovered Claude skills exceed the staging limits."
      : "Selected Claude skills exceed the staging limits.");
  }
  const skillPath = join(destination, "SKILL.md");
  await runClaudeSkillFilesystemOperation(
    options,
    "writeFile",
    skillPath,
    async () => await writeFile(
      skillPath,
      skill.skillContent,
      { mode: 0o600, flag: "wx" },
    ),
  );
}

async function fitsUnselectedBudget(
  source: string,
  budget: CopyBudget,
  depth: number,
  control: ClaudeSkillOperationControl,
): Promise<boolean> {
  checkClaudeSkillOperation(control);
  if (depth > MAX_STAGED_DEPTH) return false;
  let directory: Awaited<ReturnType<typeof opendir>>;
  try {
    directory = await runClaudeSkillFilesystemOperation(
      control,
      "opendir",
      source,
      async () => await opendir(source),
      async (opened) => await opened.close().catch(() => undefined),
    );
  } catch {
    checkClaudeSkillOperation(control);
    return false;
  }
  try {
    while (true) {
      checkClaudeSkillOperation(control);
      const entry = await runClaudeSkillFilesystemOperation(
        control,
        "readdir",
        source,
        async () => await directory.read(),
      );
      if (!entry) return true;
      const path = join(source, entry.name);
      if (entry.isDirectory()) {
        if (!await fitsUnselectedBudget(path, budget, depth + 1, control)) return false;
        continue;
      }
      if (!entry.isFile()) return false;
      if (depth === 0 && entry.name.toLowerCase() === "skill.md") continue;
      const status = await runClaudeSkillFilesystemOperation(
        control,
        "lstat",
        path,
        async () => await lstat(path),
      );
      budget.files += 1;
      budget.bytes += status.size;
      if (
        !status.isFile()
        || status.size > MAX_STAGED_FILE_BYTES
        || budget.files > budget.maxFiles
        || budget.bytes > budget.maxBytes
      ) return false;
    }
  } catch {
    checkClaudeSkillOperation(control);
    return false;
  } finally {
    await directory.close().catch(() => undefined);
  }
}

async function stageUnselectedSkillEntry(
  skill: StagingEntry,
  destination: string,
  budget: CopyBudget,
  options: ClaudeSkillOperationControl & { metadataOnly?: boolean },
): Promise<boolean> {
  const local: CopyBudget = {
    files: budget.files,
    bytes: budget.bytes,
    maxFiles: Math.min(budget.maxFiles, budget.files + MAX_UNSELECTED_SKILL_FILES),
    maxBytes: Math.min(budget.maxBytes, budget.bytes + MAX_UNSELECTED_SKILL_BYTES),
  };
  try {
    if (
      !options.metadataOnly
      && !await fitsUnselectedBudget(skill.skillDirectory, { ...local }, 0, options)
    ) return false;
    await stageSkillEntry(skill, destination, local, options);
  } catch {
    checkClaudeSkillOperation(options);
    await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    return false;
  }
  budget.files = local.files;
  budget.bytes = local.bytes;
  return true;
}

/**
 * Copies revalidated selected skills into one fresh skill-only SDK plugin.
 * The copied plugin contains no settings, hooks, agents, commands, or MCP data.
 */
export async function stageClaudeSkillPlugin(
  skills: readonly ClaudeSkillInput[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  options: ClaudeSkillOperationControl & {
    metadataOnly?: boolean;
    includeDiscovered?: boolean;
    preferredSkillNames?: readonly string[];
  } = {},
): Promise<StagedClaudeSkillPlugin | null> {
  checkClaudeSkillOperation(options);
  const preferred = new Set(options.preferredSkillNames ?? []);
  if (skills.length === 0 && !options.includeDiscovered && preferred.size === 0) return null;
  if (skills.length > MAX_DISCOVERED_SKILLS) {
    throw new Error("Claude skill staging exceeds the bounded skill limit.");
  }
  const roots = await claudeSkillRoots(cwd, environment, options);
  const selected = await selectedStagingEntries(skills, roots, options);
  const selectedNames = new Set(selected.map(({ name }) => name));
  const entries = options.includeDiscovered
    ? [
        ...selected,
        ...preferredFirst(
          unselectedStagingEntries(await discoverSkillsInRoots(roots, options), selectedNames),
          preferred,
        ),
      ]
    : preferred.size > 0
      ? [
          ...selected,
          ...unselectedStagingEntries(
            await preferredDiscoveredSkills(roots, options),
            selectedNames,
          ).filter(({ name }) => preferred.has(name)),
        ]
      : selected;
  if (entries.length === 0) return null;

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
          description: "Ephemeral Inertia-staged Claude skills.",
          version: "1.0.0",
        }),
        { mode: 0o600, flag: "wx" },
      ),
    );
    const budget: CopyBudget = {
      files: 0,
      bytes: 0,
      maxFiles: MAX_STAGED_FILES,
      maxBytes: MAX_STAGED_TOTAL_BYTES,
    };
    const staged: string[] = [];
    for (const skill of entries) {
      checkClaudeSkillOperation(options);
      const destination = join(skillsDirectory, skill.name);
      if (skill.selected) {
        await stageSkillEntry(skill, destination, budget, options);
      } else if (
        !await stageUnselectedSkillEntry(skill, destination, budget, options)
      ) continue;
      staged.push(skill.name);
    }
    if (staged.length === 0) {
      await cleanup();
      return null;
    }
    const qualified = (name: string): string =>
      `${CLAUDE_ISOLATED_SKILL_PLUGIN_NAME}:${name}`;
    return {
      path: pluginPath,
      skillNames: staged.map(qualified),
      selectedSkillNames: selected.map(({ name }) => qualified(name)),
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
    && staged.selectedSkillNames.every((name) => skills.includes(name));
}
