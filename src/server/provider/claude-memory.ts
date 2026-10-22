import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  claudeLinkPolicy,
  claudeProjectDirectories,
  claudeUserConfigHome,
  isClaudePersonalDirectory,
  isContainedPath,
  readBoundedDirectory,
  readBoundedRegularFile,
} from "./claude-config-files";
import { parseClaudeFrontmatter } from "./claude-frontmatter";
import {
  checkClaudeSkillOperation,
  type ClaudeSkillOperationControl,
} from "./claude-skill-operation";

const MAX_MEMORY_FILES = 32;
const MAX_MEMORY_FILE_BYTES = 128 * 1024;
const MAX_MEMORY_TOTAL_BYTES = 256 * 1024;
const MAX_MEMORY_IMPORT_DEPTH = 5;
const MAX_MEMORY_IMPORTS_PER_FILE = 32;
const MAX_RULE_ENTRIES = 128;
const USER_LABEL = "user's private global instructions for all projects";
const PROJECT_LABEL = "project instructions, checked into the codebase";
const MEMORY_PREAMBLE = "Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.";

export interface ClaudeInstructionContext {
  systemPromptAppend: string;
  additionalDirectories: string[];
}

interface MemoryReader {
  root: string;
  home: string | null;
  label: string;
  control: ClaudeSkillOperationControl;
  budget: { files: number; bytes: number; seen: Set<string> };
  sections: string[];
}

function importPaths(text: string): string[] {
  const prose = text
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gmu, "")
    .replace(/`[^`\n]*`/gu, "");
  const paths: string[] = [];
  for (const match of prose.matchAll(/(?:^|\s)@((?:[^\s\\]|\\ )+)/gu)) {
    paths.push(match[1]!.replace(/\\ /gu, " "));
    if (paths.length >= MAX_MEMORY_IMPORTS_PER_FILE) break;
  }
  return paths;
}

function importTarget(
  reference: string,
  importer: string,
  home: string | null,
): string | null {
  if (reference.startsWith("~/")) {
    return home ? resolve(home, reference.slice(2)) : null;
  }
  if (reference.startsWith("~")) return null;
  return isAbsolute(reference)
    ? resolve(reference)
    : resolve(dirname(importer), reference);
}

async function readMemoryFile(
  path: string,
  reader: MemoryReader,
  depth: number,
): Promise<void> {
  checkClaudeSkillOperation(reader.control);
  const key = resolve(path);
  if (
    reader.budget.files >= MAX_MEMORY_FILES
    || reader.budget.seen.has(key)
    || !isContainedPath(reader.root, key)
  ) return;
  reader.budget.seen.add(key);
  const content = await readBoundedRegularFile(
    key,
    reader.root,
    MAX_MEMORY_FILE_BYTES,
    reader.control,
  );
  if (
    !content
    || content.includes(0)
    || reader.budget.bytes + content.byteLength > MAX_MEMORY_TOTAL_BYTES
  ) return;
  reader.budget.files += 1;
  reader.budget.bytes += content.byteLength;
  const text = content.toString("utf8").replace(/^﻿/u, "").trim();
  if (text) reader.sections.push(`Contents of ${key} (${reader.label}):\n\n${text}`);
  if (depth >= MAX_MEMORY_IMPORT_DEPTH) return;
  for (const reference of importPaths(text)) {
    const target = importTarget(reference, key, reader.home);
    if (target && isContainedPath(reader.root, target)) {
      await readMemoryFile(target, reader, depth + 1);
    }
  }
}

async function readRules(
  directory: string,
  reader: MemoryReader,
): Promise<void> {
  const entries = await readBoundedDirectory(
    directory,
    reader.root,
    MAX_RULE_ENTRIES,
    reader.control,
  );
  const files = entries.filter(({ kind }) => kind === "file");
  for (const nested of entries.filter(({ kind }) => kind === "directory")) {
    files.push(...(await readBoundedDirectory(
      nested.path,
      reader.root,
      MAX_RULE_ENTRIES,
      reader.control,
    )).filter(({ kind }) => kind === "file"));
  }
  for (const file of files) {
    if (!file.name.toLowerCase().endsWith(".md")) continue;
    if (reader.budget.files >= MAX_MEMORY_FILES) return;
    const content = await readBoundedRegularFile(
      file.path,
      reader.root,
      MAX_MEMORY_FILE_BYTES,
      reader.control,
    );
    const frontmatter = content
      ? parseClaudeFrontmatter(content.toString("utf8"))
      : null;
    if (frontmatter?.fields.has("paths") || frontmatter?.fields.has("globs")) continue;
    await readMemoryFile(file.path, reader, 0);
  }
}

export async function loadClaudeInstructions(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  control: ClaudeSkillOperationControl = {},
): Promise<ClaudeInstructionContext> {
  const policy = await claudeLinkPolicy(environment, control);
  const { home } = policy;
  const configHome = await claudeUserConfigHome(environment, control);
  const budget = { files: 0, bytes: 0, seen: new Set<string>() };
  const sections: string[] = [];
  if (configHome) {
    const reader: MemoryReader = {
      root: configHome, home, label: USER_LABEL, control, budget, sections,
    };
    await readMemoryFile(join(configHome, "CLAUDE.md"), reader, 0);
    await readRules(join(configHome, "rules"), reader);
  }
  const [workingDirectory, ...parents] = await claudeProjectDirectories(cwd, control);
  const ancestors = parents
    .filter((directory) => !isClaudePersonalDirectory(directory, policy))
    .reverse();
  for (const directory of ancestors) {
    const reader: MemoryReader = {
      root: ancestors[0]!, home, label: PROJECT_LABEL, control, budget, sections,
    };
    await readMemoryFile(join(directory, "CLAUDE.md"), reader, 0);
    await readMemoryFile(join(directory, ".claude", "CLAUDE.md"), reader, 0);
    await readRules(join(directory, ".claude", "rules"), reader);
  }
  return {
    systemPromptAppend: sections.length > 0
      ? [MEMORY_PREAMBLE, ...sections].join("\n\n")
      : "",
    additionalDirectories: workingDirectory
      && !isClaudePersonalDirectory(workingDirectory, policy)
      ? [workingDirectory]
      : [],
  };
}
