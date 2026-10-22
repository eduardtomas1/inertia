import { dirname, join } from "node:path";

import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

import {
  claudeLinkPolicy,
  claudeLinkTargetAllowed,
  claudeProjectDirectories,
  claudeUserConfigHome,
  hasUnpairedSurrogate,
  isContainedPath,
  readBoundedDirectory,
  readBoundedRegularFile,
  resolveClaudeLinkTarget,
  type ClaudeConfigDirectoryEntry,
  type ClaudeLinkPolicy,
} from "./claude-config-files";
import {
  frontmatterList,
  frontmatterString,
  parseClaudeFrontmatter,
  type ClaudeFrontmatterValue,
} from "./claude-frontmatter";
import {
  checkClaudeSkillOperation,
  type ClaudeSkillOperationControl,
} from "./claude-skill-operation";

const MAX_AGENT_FILES = 64;
const MAX_AGENT_DIRECTORY_ENTRIES = 256;
const MAX_AGENT_FILE_BYTES = 256 * 1024;
const MAX_AGENT_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_AGENT_NAME_CHARS = 128;
const MAX_AGENT_DESCRIPTION_CHARS = 4_096;
const MAX_AGENT_LIST_ITEMS = 128;
const MAX_AGENT_LIST_ITEM_CHARS = 512;
const MAX_AGENT_MODEL_CHARS = 128;
const AGENT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const AGENT_FIELDS = [
  "name",
  "description",
  "tools",
  "disallowedTools",
  "model",
  "effort",
  "skills",
  "maxTurns",
  "omitClaudeMd",
  "background",
] as const;

interface AgentRoot {
  container: string;
  agentsDirectory: string;
  links: ClaudeLinkPolicy;
}

interface AgentFile {
  path: string;
  containmentRoot: string;
}

interface AgentBudget {
  files: number;
  bytes: number;
}

function safeText(value: string, maximum: number): boolean {
  return value.length > 0
    && value.length <= maximum
    && !hasUnpairedSurrogate(value)
    && !value.includes("\0");
}

function agentName(value: ClaudeFrontmatterValue | undefined): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return safeText(name, MAX_AGENT_NAME_CHARS)
    && !name.startsWith("-")
    && !name.normalize("NFKC").includes(":")
    && !/[/\\\u0000-\u001f\u007f-\u009f]/u.test(name)
    ? name
    : null;
}

function agentList(
  value: ClaudeFrontmatterValue | undefined,
): string[] | undefined {
  const items = frontmatterList(value);
  if (items === undefined) return undefined;
  return items
    .filter((item) => safeText(item, MAX_AGENT_LIST_ITEM_CHARS)
      && !/[\u0000-\u001f\u007f-\u009f]/u.test(item))
    .slice(0, MAX_AGENT_LIST_ITEMS);
}

function agentToolList(
  value: ClaudeFrontmatterValue | undefined,
): string[] | undefined {
  const items = agentList(value);
  return items?.includes("*") ? undefined : items;
}

function agentBoolean(value: ClaudeFrontmatterValue | undefined): true | undefined {
  return value === "true" ? true : undefined;
}

function agentEffort(
  value: ClaudeFrontmatterValue | undefined,
): AgentDefinition["effort"] {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  const named = AGENT_EFFORTS.find((effort) => effort === normalized);
  if (named) return named;
  return /^[1-9][0-9]{0,6}$/u.test(normalized) ? Number(normalized) : undefined;
}

function agentMaxTurns(value: ClaudeFrontmatterValue | undefined): number | undefined {
  return typeof value === "string" && /^[1-9][0-9]{0,5}$/u.test(value.trim())
    ? Number(value.trim())
    : undefined;
}

function agentModel(value: ClaudeFrontmatterValue | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const model = value.trim();
  if (!safeText(model, MAX_AGENT_MODEL_CHARS) || /\s/u.test(model)) return undefined;
  return model.toLowerCase() === "inherit" ? "inherit" : model;
}

export function claudeAgentDefinition(
  text: string,
  skillName: (name: string) => string = (name) => name,
): { name: string; definition: AgentDefinition } | null {
  const parsed = parseClaudeFrontmatter(text);
  if (!parsed) return null;
  const { fields } = parsed;
  if (AGENT_FIELDS.some((field) => fields.get(field) === null)) return null;
  const name = agentName(fields.get("name"));
  const description = frontmatterString(fields, "description")
    ?.replaceAll("\\n", " ")
    .trim();
  if (!name || !description || !safeText(description, MAX_AGENT_DESCRIPTION_CHARS)) {
    return null;
  }
  const tools = fields.has("tools") ? agentToolList(fields.get("tools")) : undefined;
  const disallowedTools = fields.has("disallowedTools")
    ? agentToolList(fields.get("disallowedTools"))
    : undefined;
  const skills = agentList(fields.get("skills"))?.map(skillName);
  const model = agentModel(fields.get("model"));
  const effort = agentEffort(fields.get("effort"));
  const maxTurns = agentMaxTurns(fields.get("maxTurns"));
  const omitClaudeMd = agentBoolean(fields.get("omitClaudeMd"));
  const background = agentBoolean(fields.get("background"));
  return {
    name,
    definition: {
      description,
      prompt: parsed.body.trim(),
      ...(tools !== undefined ? { tools } : {}),
      ...(disallowedTools !== undefined ? { disallowedTools } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(skills !== undefined && skills.length > 0 ? { skills } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(omitClaudeMd ? { omitClaudeMd } : {}),
      ...(background ? { background } : {}),
    },
  };
}

function isMarkdownEntry({ kind, name }: ClaudeConfigDirectoryEntry): boolean {
  return kind !== "directory" && name.toLowerCase().endsWith(".md");
}

async function agentFile(
  entry: ClaudeConfigDirectoryEntry,
  root: AgentRoot,
  control: ClaudeSkillOperationControl,
): Promise<AgentFile | null> {
  if (entry.kind === "file") return { path: entry.path, containmentRoot: root.container };
  const target = await resolveClaudeLinkTarget(entry.path, "file", control);
  if (!target || !target.toLowerCase().endsWith(".md")) return null;
  const directory = dirname(target);
  return dirname(directory) !== directory
    && (root.links.home === null || !isContainedPath(directory, root.links.home))
    && claudeLinkTargetAllowed(target, root.links, "agents")
    ? { path: target, containmentRoot: directory }
    : null;
}

async function agentFiles(
  root: AgentRoot,
  control: ClaudeSkillOperationControl,
): Promise<AgentFile[]> {
  const entries = await readBoundedDirectory(
    root.agentsDirectory,
    root.container,
    MAX_AGENT_DIRECTORY_ENTRIES,
    control,
  );
  const candidates = entries.filter(isMarkdownEntry);
  for (const directory of entries.filter(({ kind }) => kind === "directory")) {
    checkClaudeSkillOperation(control);
    if (candidates.length >= MAX_AGENT_FILES) break;
    candidates.push(...(await readBoundedDirectory(
      directory.path,
      root.container,
      MAX_AGENT_DIRECTORY_ENTRIES,
      control,
    )).filter(isMarkdownEntry));
  }
  const files: AgentFile[] = [];
  for (const candidate of candidates.slice(0, MAX_AGENT_FILES)) {
    const file = await agentFile(candidate, root, control);
    if (file) files.push(file);
  }
  return files;
}

async function loadRootAgents(
  root: AgentRoot,
  budget: AgentBudget,
  skillName: (name: string) => string,
  control: ClaudeSkillOperationControl,
): Promise<Array<{ name: string; definition: AgentDefinition }>> {
  const agents: Array<{ name: string; definition: AgentDefinition }> = [];
  for (const file of await agentFiles(root, control)) {
    checkClaudeSkillOperation(control);
    if (budget.files >= MAX_AGENT_FILES) break;
    budget.files += 1;
    const content = await readBoundedRegularFile(
      file.path,
      file.containmentRoot,
      MAX_AGENT_FILE_BYTES,
      control,
    );
    if (!content) continue;
    if (budget.bytes + content.byteLength > MAX_AGENT_TOTAL_BYTES) {
      budget.files = MAX_AGENT_FILES;
      break;
    }
    budget.bytes += content.byteLength;
    const agent = claudeAgentDefinition(content.toString("utf8"), skillName);
    if (agent) agents.push(agent);
  }
  return agents;
}

export async function loadClaudeAgents(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  control: ClaudeSkillOperationControl = {},
  skillName: (name: string) => string = (name) => name,
): Promise<Record<string, AgentDefinition>> {
  const links = await claudeLinkPolicy(environment, control);
  const roots: AgentRoot[] = (await claudeProjectDirectories(cwd, control)).map(
    (container) => ({
      container,
      agentsDirectory: join(container, ".claude", "agents"),
      links,
    }),
  );
  const userHome = await claudeUserConfigHome(environment, control);
  if (userHome) {
    roots.push({ container: userHome, agentsDirectory: join(userHome, "agents"), links });
  }
  const budget: AgentBudget = { files: 0, bytes: 0 };
  const agents = new Map<string, AgentDefinition>();
  for (const root of roots) {
    checkClaudeSkillOperation(control);
    for (const { name, definition } of await loadRootAgents(root, budget, skillName, control)) {
      if (!agents.has(name)) agents.set(name, definition);
    }
  }
  return Object.fromEntries(agents);
}
