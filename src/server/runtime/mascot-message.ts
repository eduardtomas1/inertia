import type { AgentActivity, AgentApprovalRequest } from "../../shared/contracts/agent";
import { commandDisplayText, hostToolActivityTitle } from "../../shared/activity-display";
import { sanitizeProviderActivityDetail } from "../provider/activity-detail";

const COMMAND_LIMIT = 60;
const SKIPPED = /^(?:Patch updated|Plan updated|Plan completed|Hook · |Claude hook|Claude tool summary)/u;
const GENERIC = /^(?:Run command|Cursor tool|Kimi Code tool|Dynamic tool|MCP tool|File change|Command|Tool|Activity)$/iu;
const PHRASES: Array<[RegExp, string, string, string]> = [
  [/todo ?read|read todos/u, "Reading the plan", "Read the plan", "Could not read the plan"],
  [/todo|plan|task ?(?:create|update)/u, "Updating the plan", "Updated the plan", "Could not update the plan"],
  [/task ?list/u, "Listing tasks", "Listed tasks", "Could not list tasks"],
  [/list ?mcp ?resources/u, "Listing resources", "Listed resources", "Could not list resources"],
  [/notebook ?read/u, "Reading files", "Read files", "Could not read files"],
  [/web|url|fetch|brows|http/u, "Browsing the web", "Browsed the web", "Could not browse the web"],
  [/edit|write|replace|patch|notebook|create|file change|apply/u, "Editing files", "Edited files", "Could not edit files"],
  [/grep|search|find|glob|list|ls$/u, "Searching the code", "Searched the code", "Could not search the code"],
  [/read|view|open|cat$/u, "Reading files", "Read files", "Could not read files"],
  [/command|bash|shell|exec|terminal|run/u, "Running a command", "Ran a command", "A command failed"],
  [/task|agent|delegat/u, "Delegating work", "Delegated work", "Could not delegate work"],
];

function cut(text: string, length: number): string {
  const part = text.slice(0, length);
  return /[\uD800-\uDBFF]$/u.test(part) ? part.slice(0, -1) : part;
}

function bounded(text: string, limit: number): string {
  return text.length > limit ? `${cut(text, limit - 1).trimEnd()}…` : text;
}

function wellFormed(text: string): string {
  return text.replace(/[\uD800-\uDFFF]/gu, "\uFFFD");
}

export function mascotPreview(value: string | null | undefined, limit = 280): string | null {
  const text = wellFormed(cut(value ?? "", 4_096))
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/`([^`]+)`|\*\*([^*]+)\*\*/gu, (_match, code: string | undefined, bold: string | undefined) => code ?? bold ?? "")
    .replace(/^#{1,6}\s+/u, "")
    .replace(/[‪-‮⁦-⁩]/gu, "")
    .replace(/[\s\x00-\x1f\x7f]+/gu, " ").trim();
  return wellFormed(bounded(text, limit)) || null;
}

const SENTENCE_BREAK = /(?<=[.!?])(?<!\b(?:[Ee]\.g|[Ii]\.e|etc|vs|cf)\.)\s+(?=[\p{Lu}\p{N}"'(`])/u;

function sentences(text: string): string[] {
  return text.split(SENTENCE_BREAK).map((part) => part.trim()).filter(Boolean);
}

function prose(content: string): string[] {
  let fence: string | null = null;
  const lines: string[] = [];
  for (const raw of content.replace(/<!--[\s\S]*?(?:-->|$)/gu, "").split("\n")) {
    const marker = /^\s*(```|~~~|\$\$)/u.exec(raw)?.[1];
    if (marker) {
      if (fence === marker) fence = null;
      else if (fence === null && !(marker === "$$" && raw.trim().slice(2).includes("$$"))) fence = marker;
      continue;
    }
    if (fence !== null || /^(?: {4}|\t)/u.test(raw)) continue;
    const line = raw.trim().replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
      .replace(/(^|[\s(])[*_](?=[^*_\s])([^*_]*?[^*_\s])[*_](?=[\s).,;:!?]|$)/gu, "$1$2")
      .replace(/~~[^~]*~~|\$\$[^$]*\$\$|<\/?(?:details|summary)\b[^>]*>/giu, "").trim();
    if (/^(?:=+|-{2,})$/u.test(line) && lines.at(-1)) lines[lines.length - 1] = "";
    else lines.push(line);
  }
  return lines.filter((line) => line && !/^(?:#|[-*_]{3,}$|=+$|\|)/u.test(line))
    .map((line) => line.replace(/^(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+)?(?:\[[ xX]\]\s+)?/u, ""));
}

function paired(parts: readonly string[], index: number, neighbour: number): string | null {
  const part = parts[index];
  const other = parts[neighbour];
  if (!part) return null;
  if (part.length >= 24 || !other) return mascotPreview(part);
  const [first, second] = neighbour < index ? [other, part] : [part, other];
  return mascotPreview(/[.!?…:]$/u.test(first) ? `${first} ${second}` : part);
}

export function mascotCommentaryLine(content: string): string | null {
  const lines = prose(content.slice(-1_048_576));
  const parts: string[] = [];
  for (let index = lines.length - 1; index >= 0 && parts.length < 2; index -= 1) {
    const line = lines[index]!;
    const found = sentences(mascotPreview(line.slice(-4_096).replace(/^[\uDC00-\uDFFF]/u, ""), 4_096) ?? "");
    if (line.length <= 4_096) parts.unshift(...found);
    else { parts.unshift(...found.slice(1)); break; }
  }
  return paired(parts, parts.length - 1, parts.length - 2);
}

export function mascotResultLine(content: string): string | null {
  const lines = prose(content.slice(0, 16_384));
  const parts: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (parts.length > 1) break;
    if (/^(?:\*\*|__)[^*_]+(?:\*\*|__):?$/u.test(line) || (line.endsWith(":") && index < lines.length - 1)) continue;
    parts.push(...sentences(mascotPreview(line, 4_096) ?? ""));
  }
  return paired(parts, 0, 1);
}

export function mascotCommand(value: string): string | null {
  const text = (sanitizeProviderActivityDetail(commandDisplayText(cut(value, 4_096)), { maxChars: 4_096 }) ?? "")
    .replace(/\s+/gu, " ").trim().replace(/<workspace>\//gu, "").replace(/<workspace>/gu, ".");
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

function imperative(title: string): string {
  return /^\p{Lu}\p{Ll}*(?:\s+\p{Lu}\p{Ll}*)*$/u.test(title) ? title.toLowerCase() : title.replace(/^\p{Lu}(?=\p{Ll})/u, (first) => first.toLowerCase());
}

function tense(state: AgentActivity["status"], running: string, done: string, failed: string): string | null {
  return mascotPreview(state === "failed" ? failed : state === "completed" ? done : running);
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
  if (command) return tense(state, `Running ${command}`, `Ran ${command}`, `${command} failed`);
  const changed = files(detail);
  if (changed.length) {
    const subject = `${fileName(changed[0]!)}${changed.length > 1 ? ` and ${changed.length - 1} more` : ""}`;
    return tense(state, `Editing ${subject}`, `Edited ${subject}`, `Could not edit ${subject}`);
  }
  const host = hostToolActivityTitle({ kind: activity.kind, title, status: state });
  if (host) return host;
  const used = /^mcp__(.+?)__(.+)$/u.exec(title) ?? /^MCP · ([^/]+)\/(.+)$/u.exec(title) ?? /^Tool · ()(.+)$/u.exec(title);
  if (used) {
    const subject = `${used[1] ? `${used[1]}: ` : ""}${used[2]}`;
    return tense(state, `Using ${subject}`, `Used ${subject}`, `Could not use ${subject}`);
  }
  const name = title.toLowerCase().replace(/[_·/\s]+/gu, " ").trim();
  const path = section(detail, "Path");
  const target = section(detail, "Query") ?? section(detail, "URL") ?? section(detail, "Pattern");
  const human = /\s/u.test(title) && !GENERIC.test(title);
  if (human && (path || target)) {
    const shown = path ? fileName(path.split("\n")[0]!) : mascotCommand(target!.split("\n")[0]!);
    if (shown) return tense(state, `${title}: ${shown}`, `${title}: ${shown}`, `Could not ${imperative(title)}: ${shown}`);
  }
  if (human && /^\p{Lu}/u.test(title)) return tense(state, title, title, `Could not ${imperative(title)}`);
  if (human && activity.kind === "command") {
    const shown = mascotCommand(title);
    if (shown) return tense(state, `Running ${shown}`, `Ran ${shown}`, `${shown} failed`);
  }
  const phrase = PHRASES.find(([pattern]) => pattern.test(name));
  return phrase ? tense(state, phrase[1], phrase[2], phrase[3]) : null;
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

function approvalDetail(detail: string | null): string | null {
  const text = detail?.trim() ?? "";
  if (!text || text.includes("\n") || /^[[{]/u.test(text)) return null;
  return sanitizeProviderActivityDetail(text.replace(/(^|\s)(?:[A-Za-z]:)?(?:[\\/][^\s\\/]+)*[\\/]([^\s\\/]+)[\\/]?/gu, "$1$2"), { maxChars: 4_096 });
}

export function mascotApprovalLine(request: Pick<AgentApprovalRequest, "kind" | "title" | "command" | "detail" | "reason">): string {
  const target = approvalTarget(request);
  const parts = target ? [`Run ${target}?`, request.reason] : [request.title, request.reason ?? approvalDetail(request.detail)];
  return mascotPreview(parts.filter(Boolean).join(" — ")) ?? "Review the request in the chat.";
}
