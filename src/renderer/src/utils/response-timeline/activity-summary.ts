import type { AgentActivity } from "@shared/contracts";

import { activityAttentionSeverity } from "./activity-attention";

export type ActivityWorkKind = "command" | "read" | "search" | "edit" | "tool" | "event";

export const ACTIVITY_GROUP_LIVE_WINDOW = 4;

const SHELL_WRAPPER_PATTERN =
  /^(?:(?:\/usr)?\/bin\/)?(?:ba|z|da)?sh\s+-l?c\s+([\s\S]+)$/u;
const LEADING_CD_PATTERN = /^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*/u;
const SETUP_LINE_PATTERN =
  /^(?:#|export\s+[A-Za-z_][A-Za-z0-9_]*=|set\s+[-+][a-zA-Z]+|cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*$|source\s+\S+\s*$|\.\s+\S+\s*$)/u;
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const GENERIC_COMMAND_TITLE_PATTERN =
  /^(?:agent command|bash|command|execute command|run command|shell|terminal)$/iu;
const READ_PROGRAMS = new Set([
  "bat",
  "batcat",
  "cat",
  "head",
  "less",
  "more",
  "nl",
  "tail",
]);
const SEARCH_PROGRAMS = new Set([
  "ack",
  "ag",
  "egrep",
  "fd",
  "fdfind",
  "fgrep",
  "find",
  "grep",
  "locate",
  "ls",
  "rg",
  "tree",
]);
const READ_TOOL_PATTERN = /^(?:read|view|open|image view)\b/iu;
const SEARCH_TOOL_PATTERN =
  /^(?:browse|codebase search|find|glob|grep|list|look ?up|ls|search|tool search|web fetch|web search)\b/iu;
const EDIT_TOOL_PATTERN =
  /^(?:apply (?:a )?patch|create (?:a )?file|edit|file change|multi edit|notebook edit|refactor|str replace|write)\b/iu;

function normalizedTitle(title: string): string {
  return title
    .replace(/([a-z\d])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .trim();
}

export function activityCommandText(
  activity: Pick<AgentActivity, "detail">,
): string | null {
  if (!activity.detail) return null;
  const detail = activity.detail.replace(/\r\n?/gu, "\n");
  const match = /^Command:\n([\s\S]*?)(?:\n\n(?:Output|Error):\n[\s\S]*)?$/u
    .exec(detail);
  const command = match?.[1]?.trim();
  return command ? command : null;
}

export function unwrapShellCommand(command: string): string {
  const trimmed = command.trim();
  const match = SHELL_WRAPPER_PATTERN.exec(trimmed);
  if (!match) return trimmed;
  let body = match[1]!.trim();
  const quote = body[0];
  if (
    (quote === "'" || quote === "\"")
    && body.length >= 2
    && body.endsWith(quote)
  ) {
    body = body.slice(1, -1);
  }
  return body.replace(/'"'"'/gu, "'").trim();
}

export function commandDisplayText(command: string): string {
  const lines = unwrapShellCommand(command)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const meaningful = lines.find((line) => !SETUP_LINE_PATTERN.test(line))
    ?? lines[0]
    ?? "";
  return meaningful.replace(LEADING_CD_PATTERN, "");
}

function commandWorkKind(command: string): ActivityWorkKind {
  const segment = commandDisplayText(command).split(/\s*(?:&&|\|\||;|\|)\s*/u)[0] ?? "";
  const tokens = segment.split(/\s+/u).filter(Boolean);
  while (tokens.length > 0 && ENV_ASSIGNMENT_PATTERN.test(tokens[0]!)) {
    tokens.shift();
  }
  const program = tokens[0]?.split("/").at(-1) ?? "";
  if (SEARCH_PROGRAMS.has(program)) return "search";
  if (program === "git" && (tokens[1] === "grep" || tokens[1] === "ls-files")) {
    return "search";
  }
  if (READ_PROGRAMS.has(program)) return "read";
  if (
    program === "sed"
    && tokens.includes("-n")
    && !tokens.some((token) => /^-[a-zA-Z]*i/u.test(token))
  ) {
    return "read";
  }
  return "command";
}

export function isGenericCommandTitle(title: string): boolean {
  return GENERIC_COMMAND_TITLE_PATTERN.test(title.trim());
}

export function activityWorkKind(
  activity: Pick<AgentActivity, "kind" | "title" | "detail">,
): ActivityWorkKind {
  if (
    activity.kind === "status"
    || activity.kind === "error"
    || activity.kind === "reasoning"
  ) {
    return "event";
  }
  if (activity.kind === "file") return "edit";
  if (activity.kind === "command") {
    const command = activityCommandText(activity);
    if (command) return commandWorkKind(command);
    return isGenericCommandTitle(activity.title)
      ? "command"
      : commandWorkKind(activity.title);
  }
  const title = normalizedTitle(activity.title);
  if (EDIT_TOOL_PATTERN.test(title)) return "edit";
  if (READ_TOOL_PATTERN.test(title)) return "read";
  if (SEARCH_TOOL_PATTERN.test(title)) return "search";
  return "tool";
}

const WORK_KIND_VERBS: Record<ActivityWorkKind, readonly [string, string]> = {
  command: ["Running", "Ran"],
  read: ["Reading", "Read"],
  search: ["Searching", "Searched"],
  edit: ["Editing", "Edited"],
  tool: ["Calling", "Called"],
  event: ["Updating", "Updated"],
};

export interface ActivityCommandLine {
  verb: string;
  target: string;
}

export function activityCommandLine(
  activity: Pick<AgentActivity, "kind" | "title" | "detail" | "status">,
): ActivityCommandLine | null {
  if (activity.kind !== "command" || !isGenericCommandTitle(activity.title)) {
    return null;
  }
  const command = activityCommandText(activity);
  if (!command) return null;
  const target = commandDisplayText(command);
  if (!target) return null;
  const [running, done] = WORK_KIND_VERBS[commandWorkKind(command)];
  return {
    verb: activity.status === "running" ? running : done,
    target,
  };
}

export interface ActivityGroupSummary {
  command: number;
  read: number;
  search: number;
  edit: number;
  tool: number;
  failed: number;
  warnings: number;
  running: number;
  events: number;
}

export function summarizeActivities(
  activities: readonly AgentActivity[],
): ActivityGroupSummary {
  const summary: ActivityGroupSummary = {
    command: 0,
    read: 0,
    search: 0,
    edit: 0,
    tool: 0,
    failed: 0,
    warnings: 0,
    running: 0,
    events: 0,
  };
  for (const activity of activities) {
    const kind = activityWorkKind(activity);
    if (kind === "event") summary.events += 1;
    else summary[kind] += 1;
    const severity = activityAttentionSeverity(activity);
    if (severity === "failure") summary.failed += 1;
    if (severity === "warning") summary.warnings += 1;
    if (activity.status === "running") summary.running += 1;
  }
  return summary;
}

export interface ActivitySummaryPart {
  key: keyof ActivityGroupSummary;
  count: number;
  label: string;
  tone: "neutral" | "failure" | "warning";
}

const SUMMARY_PART_LABELS: ReadonlyArray<
  readonly [keyof ActivityGroupSummary, string, string, ActivitySummaryPart["tone"]]
> = [
  ["command", "command", "commands", "neutral"],
  ["read", "file read", "files read", "neutral"],
  ["search", "search", "searches", "neutral"],
  ["edit", "edit", "edits", "neutral"],
  ["tool", "tool call", "tool calls", "neutral"],
  ["failed", "failed", "failed", "failure"],
  ["warnings", "warning", "warnings", "warning"],
];

export function activitySummaryParts(
  summary: ActivityGroupSummary,
): ActivitySummaryPart[] {
  const parts = SUMMARY_PART_LABELS
    .filter(([key]) => summary[key] > 0)
    .map(([key, singular, plural, tone]) => ({
      key,
      count: summary[key],
      label: summary[key] === 1 ? singular : plural,
      tone,
    }));
  if (parts.length > 0 || summary.events === 0) return parts;
  return [{
    key: "events",
    count: summary.events,
    label: summary.events === 1 ? "update" : "updates",
    tone: "neutral",
  }];
}

export function activitySummaryLabel(parts: readonly ActivitySummaryPart[]): string {
  return parts.map(({ count, label }) => `${count} ${label}`).join(", ");
}

export interface ActivityGroupRowPresentation {
  activity: AgentActivity;
  folded: boolean;
}

export function latestFailureIndex(activities: readonly AgentActivity[]): number {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    if (activityAttentionSeverity(activities[index]!) === "failure") return index;
  }
  return -1;
}

export function resolveActivityGroupWindow(
  activities: readonly AgentActivity[],
  options: {
    expanded: boolean;
    settled: boolean;
    revealLatestFailure?: boolean;
  },
): ActivityGroupRowPresentation[] {
  if (options.expanded) {
    return activities.map((activity) => ({ activity, folded: false }));
  }
  const firstMounted = Math.max(0, activities.length - ACTIVITY_GROUP_LIVE_WINDOW - 1);
  const firstVisible = options.settled
    ? activities.length
    : activities.length - ACTIVITY_GROUP_LIVE_WINDOW;
  const revealed = options.settled && options.revealLatestFailure
    ? latestFailureIndex(activities)
    : -1;
  const rows: ActivityGroupRowPresentation[] = [];
  activities.forEach((activity, index) => {
    if (index < firstMounted && index !== revealed) return;
    rows.push({
      activity,
      folded: index < firstVisible && index !== revealed,
    });
  });
  return rows;
}
