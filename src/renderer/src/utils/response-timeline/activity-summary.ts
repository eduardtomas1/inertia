import type { AgentActivity } from "@shared/contracts";
import { commandDisplayText } from "@shared/activity-display";

import { activityAttentionSeverity } from "./activity-attention";

export { commandDisplayText, hostToolActivityTitle } from "@shared/activity-display";

export type ActivityWorkKind = "command" | "read" | "search" | "edit" | "tool" | "event";

export const ACTIVITY_GROUP_LIVE_WINDOW = 4;
export const ACTIVITY_GROUP_ACTIVE_WINDOW = 4;

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
const BROWSER_TOOL_PATTERN = /\b(?:browser|chrome|playwright|puppeteer)\b/iu;

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
  browser: number;
  tool: number;
  failed: number;
  warnings: number;
  running: number;
  events: number;
  editedFiles: number | null;
  readFiles: number | null;
}

const DETAIL_PATH_PATTERN = /^(?:Path:\n|File: )([^\n]+)$/mu;
const BARE_PATH_PATTERN = /^\S*[\\/]\S*$|^[^\s\\/]+\.[A-Za-z0-9]+$/u;

export function activityFilePath(
  activity: Pick<AgentActivity, "kind" | "title" | "detail">,
): string | null {
  const fromDetail = activity.detail
    ? DETAIL_PATH_PATTERN.exec(activity.detail.replace(/\r\n?/gu, "\n"))?.[1]?.trim()
    : undefined;
  const title = activity.title.trim();
  const path = fromDetail
    || (activity.kind === "file" && BARE_PATH_PATTERN.test(title) ? title : "");
  if (!path) return null;
  return path.replace(/\\/gu, "/").replace(/^(?:\.\/)+/u, "");
}

export function summarizeActivities(
  activities: readonly AgentActivity[],
): ActivityGroupSummary {
  const summary: ActivityGroupSummary = {
    command: 0,
    read: 0,
    search: 0,
    edit: 0,
    browser: 0,
    tool: 0,
    failed: 0,
    warnings: 0,
    running: 0,
    events: 0,
    editedFiles: null,
    readFiles: null,
  };
  const paths = { edit: new Set<string>(), read: new Set<string>() };
  const unnamed = { edit: false, read: false };
  for (const activity of activities) {
    const kind = activityWorkKind(activity);
    if (kind === "edit" || kind === "read") {
      const path = activityFilePath(activity);
      if (path) paths[kind].add(path);
      else unnamed[kind] = true;
    }
    if (kind === "event") summary.events += 1;
    else if (kind === "tool" && BROWSER_TOOL_PATTERN.test(normalizedTitle(activity.title))) {
      summary.browser += 1;
    } else summary[kind] += 1;
    const severity = activityAttentionSeverity(activity);
    if (severity === "failure") summary.failed += 1;
    if (severity === "warning") summary.warnings += 1;
    if (activity.status === "running") summary.running += 1;
  }
  if (summary.edit > 0 && !unnamed.edit) summary.editedFiles = paths.edit.size;
  if (summary.read > 0 && !unnamed.read) summary.readFiles = paths.read.size;
  return summary;
}

type ActivityCountKey = Exclude<keyof ActivityGroupSummary, "editedFiles" | "readFiles">;

export interface ActivitySummaryPart {
  key: ActivityCountKey;
  count: number;
  label: string;
  tone: "neutral" | "failure" | "warning";
}

const SUMMARY_PART_LABELS: ReadonlyArray<
  readonly [ActivityCountKey, string, string, ActivitySummaryPart["tone"]]
> = [
  ["command", "command", "commands", "neutral"],
  ["read", "file read", "files read", "neutral"],
  ["search", "search", "searches", "neutral"],
  ["edit", "edit", "edits", "neutral"],
  ["browser", "browser action", "browser actions", "neutral"],
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

export interface ActivitySentencePhrase {
  key: ActivityCountKey | "other";
  joiner: "" | ", " | " and ";
  lead: string;
  count: number;
  noun: string;
}

type SentenceCategory = "command" | "edit" | "read" | "search" | "browser" | "tool";

const SENTENCE_CATEGORIES: ReadonlyArray<
  readonly [SentenceCategory, string, string, string]
> = [
  ["command", "ran", "command", "commands"],
  ["edit", "made", "edit", "edits"],
  ["read", "did", "read", "reads"],
  ["search", "searched", "time", "times"],
  ["browser", "took", "browser action", "browser actions"],
  ["tool", "called", "tool", "tools"],
];

const DISTINCT_FILE_COUNTS = {
  edit: ["editedFiles", "edited"],
  read: ["readFiles", "read"],
} as const;

function plural(count: number, singular: string, many: string): string {
  return count === 1 ? singular : many;
}

function categoryPhrase(
  summary: ActivityGroupSummary,
  [key, lead, singular, many]: readonly [SentenceCategory, string, string, string],
): { lead: string; count: number; noun: string } {
  const files = key === "edit" || key === "read" ? DISTINCT_FILE_COUNTS[key] : null;
  const distinct = files ? summary[files[0]] : null;
  if (files && distinct !== null) {
    return { lead: files[1], count: distinct, noun: plural(distinct, "file", "files") };
  }
  return { lead, count: summary[key], noun: plural(summary[key], singular, many) };
}

function otherActions(count: number): ActivitySentencePhrase {
  return {
    key: "other",
    joiner: " and ",
    lead: "",
    count,
    noun: plural(count, "other action", "other actions"),
  };
}

export function activitySummarySentence(
  summary: ActivityGroupSummary,
): ActivitySentencePhrase[] {
  const present = SENTENCE_CATEGORIES.filter(([key]) => summary[key] > 0);
  if (present.length === 0) {
    return summary.events === 0 || summary.failed + summary.warnings > 0 ? [] : [{
      key: "events",
      joiner: "",
      lead: "",
      count: summary.events,
      noun: plural(summary.events, "update", "updates"),
    }];
  }
  const [first, second, ...rest] = present;
  const lead = categoryPhrase(summary, first!);
  const phrases: ActivitySentencePhrase[] = [{
    key: first![0],
    joiner: "",
    ...lead,
    lead: `${lead.lead[0]!.toUpperCase()}${lead.lead.slice(1)}`,
  }];
  if (second) {
    phrases.push(second[0] === "tool"
      ? otherActions(summary.tool)
      : { key: second[0], joiner: ", ", ...categoryPhrase(summary, second) });
  }
  const remaining = rest.reduce((total, [key]) => total + summary[key], 0);
  if (remaining > 0) phrases.push(otherActions(remaining));
  return phrases;
}

export function activitySentenceText(phrases: readonly ActivitySentencePhrase[]): string {
  return phrases
    .map(({ joiner, lead, count, noun }) => `${joiner}${lead ? `${lead} ` : ""}${count} ${noun}`)
    .join("");
}

export function activitySummarySentenceLabel(summary: ActivityGroupSummary): string {
  const attention = [
    summary.failed > 0 ? `${summary.failed} failed` : null,
    summary.warnings > 0
      ? `${summary.warnings} ${plural(summary.warnings, "warning", "warnings")}`
      : null,
  ].filter((part): part is string => part !== null);
  return [activitySentenceText(activitySummarySentence(summary)), ...attention]
    .filter(Boolean)
    .join(", ");
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
    expandRunning?: boolean;
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
  let running = 0;
  activities.forEach((activity, index) => {
    const keepRunning = !options.settled && activity.status === "running"
      && (++running <= ACTIVITY_GROUP_ACTIVE_WINDOW || options.expandRunning);
    if (index < firstMounted && index !== revealed && !keepRunning) return;
    rows.push({
      activity,
      folded: index < firstVisible && index !== revealed && !keepRunning,
    });
  });
  return rows;
}
