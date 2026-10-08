import type { AgentActivity, AgentApprovalRequest } from "../../shared/contracts/agent";
import { sanitizeProviderActivityDetail } from "../provider/activity-detail";

const COMMAND_LIMIT = 60;
const SKIPPED = /^(?:Patch updated|Plan updated|Plan completed|Hook · |Claude hook|Claude tool summary)/u;
const GENERIC = /^(?:Run command|Cursor tool|Kimi Code tool|Dynamic tool|MCP tool|File change|Command|Tool|Activity)$/iu;
const PHRASES: Array<[RegExp, string, string]> = [
  [/web|url|fetch|brows|http/u, "Browsing the web", "Browsed the web"],
  [/edit|write|replace|patch|notebook|create|file change|apply/u, "Editing files", "Edited files"],
  [/grep|search|find|glob|list|ls$/u, "Searching the code", "Searched the code"],
  [/read|view|open|cat$/u, "Reading files", "Read files"],
  [/command|bash|shell|exec|terminal|run/u, "Running a command", "Ran a command"],
  [/task|agent|delegat/u, "Delegating work", "Delegated work"],
  [/todo|plan/u, "Updating the plan", "Updated the plan"],
];

export function mascotPreview(value: string | null | undefined, limit = 280): string | null {
  const text = (value ?? "").slice(0, 4_096)
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/`([^`]+)`|\*\*([^*]+)\*\*/gu, (_match, code: string | undefined, bold: string | undefined) => code ?? bold ?? "")
    .replace(/^#{1,6}\s+/u, "")
    .replace(/[‪-‮⁦-⁩]/gu, "")
    .replace(/[\s\x00-\x1f\x7f]+/gu, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text || null;
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"'(`])/u).map((part) => part.trim()).filter(Boolean);
}

function prose(content: string): string[] {
  let fence: string | null = null;
  const lines: string[] = [];
  for (const line of content.slice(0, 16_384).split("\n")) {
    const marker = /^\s*(```|~~~)/u.exec(line)?.[1];
    if (marker) { fence = fence === null ? marker : fence === marker ? null : fence; continue; }
    if (fence === null && !/^(?: {4}|\t)/u.test(line)) {
      lines.push(line.trim().replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
        .replace(/(^|[\s(])[*_](?=[^*_\s])([^*_]*?[^*_\s])[*_](?=[\s).,;:!?]|$)/gu, "$1$2"));
    }
  }
  return lines;
}

export function mascotCommentaryLine(content: string): string | null {
  const parts = sentences(mascotPreview(prose(content).join("\n"), 4_096) ?? "");
  const last = parts.at(-1);
  if (!last) return null;
  return mascotPreview(last.length < 24 && parts.length > 1 ? `${parts.at(-2)} ${last}` : last);
}

export function mascotResultLine(content: string): string | null {
  const line = prose(content).find((part) => part && !/^(?:#|[-*_]{3,}$|\|)/u.test(part));
  const text = mascotPreview(line?.replace(/^(?:>\s*)?(?:(?:[-*+]|\d+[.)])\s+)?/u, ""), 4_096);
  return text ? mascotPreview(sentences(text)[0]) : null;
}

function bounded(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

export function mascotCommand(value: string): string | null {
  let text = value.slice(0, 4_096).replace(/\s+/gu, " ").trim();
  const wrapped = /^(?:\S*\/)?(?:ba|z|da|k|fi)?sh\s+-l?c\s+(['"])(.*)\1$/u.exec(text);
  if (wrapped) text = wrapped[2]!.trim();
  text = (sanitizeProviderActivityDetail(text, { maxChars: 4_096 }) ?? "").replace(/\s+/gu, " ").trim()
    .replace(/^cd \S+ && /u, "").replace(/<workspace>\//gu, "").replace(/<workspace>/gu, ".");
  return mascotPreview(bounded(text, COMMAND_LIMIT), COMMAND_LIMIT);
}

function section(detail: string, name: string): string | null {
  const marker = `${name}:\n`;
  const index = detail.startsWith(marker) ? -2 : detail.indexOf(`\n\n${marker}`);
  if (index === -1) return null;
  const from = index + 2 + marker.length;
  const end = detail.indexOf("\n\n", from);
  return detail.slice(from, end < 0 ? undefined : end).trim() || null;
}

function fileName(path: string): string {
  return path.replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1) || path;
}

function files(detail: string): string[] {
  const listed = section(detail, "Files")?.split("\n").map((line) => line.replace(/^[a-z]+:\s*/u, "").trim()).filter(Boolean) ?? [];
  if (listed.length) return listed;
  const named = /^File: (.+)$/mu.exec(detail)?.[1] ?? /\bThe file (\S+) has been (?:updated|created)/u.exec(detail)?.[1];
  return named ? [named] : [];
}

function tense(state: AgentActivity["status"], running: string, done: string, subject: string): string | null {
  return mascotPreview(state === "failed" ? `${running === "Running" ? "" : `${running} `}${subject} failed` : `${state === "completed" ? done : running} ${subject}`);
}

export function mascotActivityLine(activity: Pick<AgentActivity, "kind" | "title" | "detail" | "status">): string | null {
  if (activity.kind !== "command" && activity.kind !== "tool" && activity.kind !== "file") return null;
  const title = (sanitizeProviderActivityDetail(activity.title.replace(/^Interrupted · /u, ""), { maxChars: 4_096 }) ?? "")
    .replace(/\s+/gu, " ").trim();
  if (SKIPPED.test(title)) return null;
  const detail = activity.detail?.slice(0, 32_768) ?? "";
  const state = activity.status;
  const raw = section(detail, "Command");
  const command = raw ? mascotCommand(raw) : null;
  if (command) return tense(state, "Running", "Ran", command);
  const changed = files(detail);
  if (changed.length) return tense(state, "Editing", "Edited", `${fileName(changed[0]!)}${changed.length > 1 ? ` and ${changed.length - 1} more` : ""}`);
  const name = title.toLowerCase().replace(/^mcp(?: · |__)/u, "mcp ").replace(/[_·/\s]+/gu, " ").trim();
  const tool = /^(?:mcp|tool) (.+)$/u.exec(name);
  if (tool && name !== "mcp tool") return tense(state, "Using", "Used", tool[1]!);
  const path = section(detail, "Path");
  const target = section(detail, "Query") ?? section(detail, "URL") ?? section(detail, "Pattern");
  const human = /\s/u.test(title) && !GENERIC.test(title);
  if (human && (path || target)) {
    const shown = path ? fileName(path.split("\n")[0]!) : mascotCommand(target!.split("\n")[0]!);
    if (shown) return mascotPreview(`${title}: ${shown}${state === "failed" ? " failed" : ""}`);
  }
  if (human && /^\p{Lu}/u.test(title)) return mascotPreview(state === "failed" ? `${title} failed` : title);
  if (human && activity.kind === "command") {
    const shown = mascotCommand(title);
    if (shown) return tense(state, "Running", "Ran", shown);
  }
  const phrase = PHRASES.find(([pattern]) => pattern.test(name));
  if (!phrase) return null;
  return state === "failed" ? `${phrase[1]} failed` : phrase[state === "completed" ? 2 : 1];
}

function approvalTarget(request: Pick<AgentApprovalRequest, "kind" | "command" | "detail" | "reason">): string | null {
  if (request.command) return mascotCommand(request.command);
  const detail = request.detail?.trim() ?? "";
  if (!detail || request.reason || request.kind !== "command") return null;
  if (detail.startsWith("{")) {
    try {
      const value = JSON.parse(detail) as { command?: unknown; input?: { command?: unknown } };
      const command = typeof value.command === "string" ? value.command : value.input?.command;
      return typeof command === "string" ? mascotCommand(command) : null;
    } catch { return null; }
  }
  return detail.includes("\n") ? null : mascotCommand(detail);
}

export function mascotApprovalLine(request: Pick<AgentApprovalRequest, "kind" | "title" | "command" | "detail" | "reason">): string {
  const target = approvalTarget(request);
  const action = target ? `${request.title}: ${target}` : request.title;
  return mascotPreview([action, request.reason].filter(Boolean).join(" — ")) ?? "Review the request in the chat.";
}
