import type { SubagentTrace } from "@shared/contracts";
import { subagentTraceLabel } from "./subagentDisclosure";
import { isBackgroundCommandTrace } from "./subagentTraceRows";

export {
  isBackgroundCommandTrace,
  linkedSubagentTraces,
  MAX_UNLINKED_SUBAGENT_ROWS,
  subagentCurrentStep,
  subagentTraceHasToolRow,
  unlinkedSubagentTraces,
} from "./subagentTraceRows";

export interface SubagentTaskStateWord {
  word: string;
  danger: boolean;
}

const KIND_LABELS: Record<SubagentTrace["taskKind"], string> = {
  agent: "Agent",
  workflow: "Workflow",
  remote: "Remote agent",
  shell: "Background command",
  monitor: "Monitor",
  mcp: "MCP task",
};

const MAX_TITLE_CHARS = 280;

export function subagentKindLabel(trace: SubagentTrace): string {
  return KIND_LABELS[trace.taskKind] ?? "Agent";
}

function humanized(value: string): string {
  const words = value.trim().replace(/[_\s-]+/gu, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Who the provider says is doing the work: its role, else its name. */
export function subagentIdentityLabel(trace: SubagentTrace): string | null {
  const identity = trace.providerRole ?? trace.providerName;
  return identity ? humanized(identity) : null;
}

export function subagentModelLabel(trace: SubagentTrace): string | null {
  if (!trace.model) return null;
  return trace.modelSource === "requested" ? `${trace.model} (requested)` : trace.model;
}

function summary(text: string | null): string | null {
  const line = text?.split(/\r?\n/u).map((part) => part.trim()).find(Boolean);
  if (!line) return null;
  return line.length <= MAX_TITLE_CHARS ? line : `${line.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`;
}

/** What the task is: its description, else a command's text, else who runs it. */
export function subagentTaskTitle(trace: SubagentTrace): string {
  if (isBackgroundCommandTrace(trace)) {
    return summary(trace.description) ?? summary(trace.command) ?? subagentKindLabel(trace);
  }
  return summary(trace.description) ?? subagentIdentityLabel(trace) ?? subagentTraceLabel(trace);
}

const STATE_WORDS: Record<SubagentTrace["status"], SubagentTaskStateWord> = {
  queued: { word: "Queued", danger: false },
  spawned: { word: "Starting", danger: false },
  running: { word: "Running", danger: false },
  waiting: { word: "Waiting", danger: false },
  completed: { word: "Completed", danger: false },
  failed: { word: "Failed", danger: true },
  cancelled: { word: "Stopped", danger: false },
  interrupted: { word: "Interrupted", danger: true },
  lost: { word: "Lost", danger: true },
  unknown: { word: "Unknown", danger: false },
};

/** The one state word the timeline and the Background tasks panel both show. */
export function subagentTaskStateWord(trace: SubagentTrace): SubagentTaskStateWord {
  const command = isBackgroundCommandTrace(trace);
  if (command && trace.background && (trace.status === "spawned" || trace.status === "running")) {
    return { word: "Running in background", danger: false };
  }
  if (command && trace.status === "completed") return { word: "Finished", danger: false };
  if (trace.status === "unknown") {
    if (trace.isLive) return STATE_WORDS.running;
    if (trace.taskKind === "remote") return { word: "Running in the cloud", danger: false };
    if (command) return { word: "May still be running", danger: true };
  }
  return STATE_WORDS[trace.status] ?? STATE_WORDS.unknown;
}

const MAX_ACCESSIBLE_NAME_CHARS = 48;

function clipped(text: string): string {
  return text.length <= MAX_ACCESSIBLE_NAME_CHARS
    ? text
    : `${text.slice(0, MAX_ACCESSIBLE_NAME_CHARS - 1).trimEnd()}…`;
}

/**
 * A short name for controls that act on a task: who runs it (its role or
 * name), else its kind and the start of its title, never a long description.
 */
export function subagentAccessibleName(trace: SubagentTrace): string {
  const identity = isBackgroundCommandTrace(trace) ? null : subagentIdentityLabel(trace);
  if (identity) return clipped(identity);
  const title = subagentTaskTitle(trace);
  const kind = subagentKindLabel(trace);
  return title === kind ? kind : clipped(`${kind}: ${title}`);
}
