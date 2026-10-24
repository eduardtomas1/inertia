import { promises } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import { readOnlyCommandPathProblem } from "../runtime/watcher/read-only-command-paths";
import {
  classifyReadOnlyCommand,
  environmentFileName,
  readOnlyCommandReminder,
  ripgrepWithoutConfig,
  type ReadOnlyCommandContext,
} from "../runtime/watcher/read-only-commands";

export type ClaudeWatcherDecision =
  | { kind: "allow"; updatedInput: Record<string, unknown> }
  | { kind: "deny"; message: string }
  | { kind: "decline"; approval: "command" | "file-change" | "permissions"; message: string };

export interface ClaudeWatcherRequest {
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  mcpServer: boolean;
  blockedPath: string | undefined;
  platform?: NodeJS.Platform;
}

export const CLAUDE_WATCHER_WRITE_REFUSAL =
  "Watchers are read-only, so Inertia declined this edit. Don't edit files; describe what should change in your reply.";
export const CLAUDE_WATCHER_QUESTION_REFUSAL =
  "Watchers can't ask the user questions during a check. Decide for yourself and answer with your finding, or with SILENT if nothing needs attention.";
export const CLAUDE_WATCHER_PLAN_REFUSAL =
  "Watchers don't use plan mode. Put your review in your reply, or answer SILENT if nothing needs attention.";
export const CLAUDE_WATCHER_READ_REFUSAL =
  "Watchers can only read inside the workspace, and Inertia declines reads and searches that name an environment file.";

const WRITE_TOOLS: ReadonlySet<string> = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const PLAN_TOOLS: ReadonlySet<string> = new Set(["ExitPlanMode", "EnterPlanMode"]);
const READ_TOOLS: Readonly<Record<string, readonly string[]>> = {
  Read: ["file_path"],
  NotebookRead: ["notebook_path"],
  LS: ["path"],
  Glob: ["path"],
  Grep: ["path"],
};
const COMMAND_SHELLS: Readonly<Record<string, "posix" | "windows">> = { Bash: "posix", PowerShell: "windows" };
const SEARCH_FILTER_FIELDS = ["pattern", "glob", "type"] as const;
const ENVIRONMENT_FILTER = /\.env|\benv\b/iu;

export function claudeWatcherToolRefusal(toolName: string): string {
  const name = /^[A-Za-z0-9_.:-]{1,80}$/u.test(toolName) ? toolName : "This tool";
  return `${name} isn't available to a watcher. Read with Read, Grep, Glob and LS, run the allowed read-only commands, and answer with your finding or SILENT.`;
}

export async function claudeWatcherDecision(request: ClaudeWatcherRequest): Promise<ClaudeWatcherDecision> {
  const { toolName } = request;
  if (request.mcpServer) return { kind: "decline", approval: "permissions", message: claudeWatcherToolRefusal(toolName) };
  if (toolName === "AskUserQuestion") return { kind: "deny", message: CLAUDE_WATCHER_QUESTION_REFUSAL };
  if (PLAN_TOOLS.has(toolName)) return { kind: "decline", approval: "permissions", message: CLAUDE_WATCHER_PLAN_REFUSAL };
  if (WRITE_TOOLS.has(toolName)) return { kind: "decline", approval: "file-change", message: CLAUDE_WATCHER_WRITE_REFUSAL };
  const shell = Object.hasOwn(COMMAND_SHELLS, toolName) ? COMMAND_SHELLS[toolName]! : null;
  if (shell !== null) return await commandDecision(request, shell);
  if (Object.hasOwn(READ_TOOLS, toolName)) return await readDecision(request, READ_TOOLS[toolName]!);
  return { kind: "decline", approval: "permissions", message: claudeWatcherToolRefusal(toolName) };
}

async function commandDecision(request: ClaudeWatcherRequest, shell: "posix" | "windows"): Promise<ClaudeWatcherDecision> {
  const { toolInput } = request;
  const reminder = readOnlyCommandReminder(shell);
  const decline = (reason: string): ClaudeWatcherDecision => ({ kind: "decline", approval: "command", message: `${reason} ${reminder}` });
  const command = toolInput.command;
  if (typeof command !== "string") return decline("The command was not text.");
  if (toolInput.run_in_background === true) return decline("Watchers can't run commands in the background.");
  if (toolInput.dangerouslyDisableSandbox === true) return decline("Watchers can't run commands outside the sandbox.");
  if (request.blockedPath !== undefined) return decline("The command reads outside the workspace.");
  const context: ReadOnlyCommandContext = shell === "posix"
    ? { cwd: request.cwd, windows: false, windowsPaths: (request.platform ?? process.platform) === "win32" }
    : { cwd: request.cwd, windows: true, powershell: true, windowsPaths: (request.platform ?? process.platform) === "win32" };
  const verdict = classifyReadOnlyCommand(command, context);
  if (!verdict.allowed) return decline(verdict.reason);
  const problem = await readOnlyCommandPathProblem(command, context);
  if (problem) return decline(problem);
  return { kind: "allow", updatedInput: { ...toolInput, command: ripgrepWithoutConfig(command, context) } };
}

async function readDecision(request: ClaudeWatcherRequest, fields: readonly string[]): Promise<ClaudeWatcherDecision> {
  const decline: ClaudeWatcherDecision = { kind: "decline", approval: "permissions", message: CLAUDE_WATCHER_READ_REFUSAL };
  if (request.blockedPath !== undefined) return decline;
  const values = fields.map((field) => request.toolInput[field]).filter((value) => value !== undefined);
  if (values.some((value) => typeof value !== "string" || value.length === 0 || value.length > 4_096 || value.includes("\0"))) {
    return decline;
  }
  const pattern = request.toolInput.pattern;
  if (request.toolName === "Glob" && typeof pattern === "string" && (isAbsolute(pattern) || pattern.split(/[\\/]/u).includes(".."))) {
    return decline;
  }
  const filters = SEARCH_FILTER_FIELDS
    .filter((field) => field !== "pattern" || request.toolName === "Glob")
    .map((field) => request.toolInput[field]);
  if (filters.some((value) => typeof value === "string" && ENVIRONMENT_FILTER.test(value))) return decline;
  const target = resolve(request.cwd, (values[0] as string | undefined) ?? ".");
  if (environmentFileName(basename(target))) return decline;
  return await insideWorkspace(request.cwd, target) ? { kind: "allow", updatedInput: request.toolInput } : decline;
}

async function insideWorkspace(cwd: string, target: string): Promise<boolean> {
  try {
    const [root, real] = await Promise.all([promises.realpath(cwd), promises.realpath(target)]);
    const child = relative(root, real);
    return child === "" || (child.split(sep)[0] !== ".." && !isAbsolute(child));
  } catch {
    return false;
  }
}
