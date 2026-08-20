import type {
  AgentActivity,
  AgentTurn,
} from "@shared/contracts";

const MAX_FAILURE_DETAIL_CHARS = 16 * 1024;
const MAX_FAILURE_CONTEXT_LINES = 80;
const MAX_FAILURE_CONTEXT_LINE_CHARS = 2 * 1024;
export const MAX_COPIED_FAILURE_DIAGNOSTICS_CHARS = 24 * 1024;

export interface FailureDiagnosticFact {
  label: string;
  value: string;
  technical: boolean;
}

export interface FailureDiagnosticsPresentation {
  summary: string;
  executionFacts: FailureDiagnosticFact[];
  providerFacts: FailureDiagnosticFact[];
  cause: string | null;
  context: string | null;
  copyText: string;
}

const PROVIDER_FACT_LABELS: Readonly<Record<string, string>> = {
  reason: "Failure code",
  phase: "Provider phase",
  "exit code": "Exit code",
  signal: "Signal",
  "terminal event": "Terminal event",
  turn: "Provider turn",
  activity: "Last activity",
  cleanup: "Process cleanup",
  "last protocol method": "Last protocol method",
};

function safeTechnicalText(value: string | null): string {
  return (value ?? "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, "")
    .slice(0, MAX_FAILURE_DETAIL_CHARS)
    .trim();
}

function boundedContext(lines: string[]): string | null {
  const bounded = lines
    .slice(0, MAX_FAILURE_CONTEXT_LINES)
    .map((line) => line.length > MAX_FAILURE_CONTEXT_LINE_CHARS
      ? `${line.slice(0, MAX_FAILURE_CONTEXT_LINE_CHARS - 1)}…`
      : line);
  if (lines.length > bounded.length) {
    bounded.push(`… ${lines.length - bounded.length} more lines omitted …`);
  }
  const context = bounded.join("\n").trim();
  return context || null;
}

function sessionState(turn: AgentTurn): string {
  if (turn.providerSessionBefore !== null && turn.providerSessionAfter !== null) {
    return turn.providerSessionBefore === turn.providerSessionAfter
      ? "Resumed existing session"
      : "Provider session changed";
  }
  if (turn.providerSessionBefore !== null) return "Resumed session; completion ID unavailable";
  if (turn.providerSessionAfter !== null) return "Started new session";
  return "Not recorded";
}

function providerLabel(providerId: AgentTurn["providerId"]): string {
  switch (providerId) {
    case "claude": return "Claude";
    case "cursor": return "Cursor";
    case "kimi": return "Kimi Code";
    case "opencode": return "OpenCode";
    default: return "Codex";
  }
}

function copySection(title: string, facts: FailureDiagnosticFact[]): string[] {
  if (facts.length === 0) return [];
  return [title, ...facts.map(({ label, value }) => `${label}: ${value}`), ""];
}

function boundCopyText(value: string): string {
  if (value.length <= MAX_COPIED_FAILURE_DIAGNOSTICS_CHARS) return value;
  const marker = "\n… diagnostics truncated by Inertia …";
  return `${value.slice(0, MAX_COPIED_FAILURE_DIAGNOSTICS_CHARS - marker.length)}${marker}`;
}

/**
 * Builds a renderer-only view over the already-scrubbed persisted error
 * activity. It never reads request/answer content, paths, provider session IDs,
 * or global runtime logs.
 */
export function failureDiagnosticsPresentation(
  turn: AgentTurn,
  activity: AgentActivity,
): FailureDiagnosticsPresentation {
  const detail = safeTechnicalText(activity.detail);
  const providerFacts: FailureDiagnosticFact[] = [];
  const causes: string[] = [];
  const contextLines: string[] = [];
  let inContext = false;
  let inStack = false;
  for (const line of detail.split("\n")) {
    const trimmed = line.trim();
    if (/^Recent provider context:$/iu.test(trimmed)) {
      inContext = true;
      inStack = false;
      continue;
    }
    if (!inContext) {
      const field = trimmed.match(/^([A-Za-z][A-Za-z -]{1,40}):\s*(.*)$/u);
      if (field) {
        const key = field[1]!.toLowerCase();
        const rawValue = field[2]!.trim();
        const value = rawValue || "Not reported";
        const label = PROVIDER_FACT_LABELS[key];
        if (label) {
          inStack = false;
          providerFacts.push({ label, value, technical: true });
          continue;
        }
        if (key === "cause" || key === "error" || key === "stack") {
          causes.push(`${field[1]}:${rawValue ? ` ${rawValue}` : ""}`);
          inStack = key === "stack";
          continue;
        }
      }
      if (inStack) {
        causes.push(line);
        continue;
      }
    }
    if (trimmed || contextLines.length > 0) contextLines.push(line);
  }

  const executionFacts: FailureDiagnosticFact[] = [
    { label: "Provider", value: providerLabel(turn.providerId), technical: false },
    {
      label: "Harness",
      value: turn.modelSelection.harnessId,
      technical: true,
    },
    {
      label: "Backend",
      value: turn.modelSelection.backendProfileDisplayName,
      technical: false,
    },
    { label: "Model", value: turn.modelSelection.modelId, technical: true },
    { label: "Run ID", value: turn.runId, technical: true },
    { label: "Turn ID", value: turn.id, technical: true },
    { label: "Session", value: sessionState(turn), technical: false },
    {
      label: "Terminal reason",
      value: turn.terminalReason ?? "Not recorded",
      technical: true,
    },
  ];
  const cause = causes.join("\n").trim() || null;
  const context = boundedContext(contextLines);
  const copied = [
    "Inertia turn failure diagnostics",
    `Summary: ${activity.title}`,
    "",
    ...copySection("Execution", executionFacts),
    ...copySection("Provider / process", providerFacts),
    ...(cause ? ["Cause", cause, ""] : []),
    ...(context ? ["Recent provider context", context, ""] : []),
    "Privacy: prompts, response content, project paths, provider session IDs, credentials, and token values are excluded or redacted.",
  ].join("\n");
  return {
    summary: activity.title,
    executionFacts,
    providerFacts,
    cause,
    context,
    copyText: boundCopyText(copied),
  };
}
