import type { SubagentTrace } from "@shared/contracts";

/*
 * The small part of delegated-task presentation that the timeline's height
 * estimate needs on first load. Titles, state words and names stay with the
 * rows that render them.
 */

export function isBackgroundCommandTrace(trace: SubagentTrace): boolean {
  return trace.taskKind === "shell" || trace.taskKind === "monitor" || trace.taskKind === "mcp";
}

/** The step the agent is on now: its latest step while live. */
export function subagentCurrentStep(trace: SubagentTrace): string | null {
  if (!trace.isLive) return null;
  return trace.steps?.at(-1)?.label ?? trace.activity ?? trace.progress;
}

export const MAX_UNLINKED_SUBAGENT_ROWS = 8;

/**
 * Providers that start delegated work with a tool call of their own. Their
 * traces either replace that row or, in legacy and imported chats without a
 * link, leave the generic row in place; they never need a compact row.
 */
const TOOL_ROW_PROVIDERS: ReadonlySet<string> = new Set(["claude", "opencode"]);

export function subagentTraceHasToolRow(trace: SubagentTrace): boolean {
  return TOOL_ROW_PROVIDERS.has(trace.providerId);
}

export function linkedSubagentTraces(
  traces: readonly SubagentTrace[],
): ReadonlyMap<string, SubagentTrace> {
  const linked = new Map<string, SubagentTrace>();
  for (const trace of traces) {
    if (trace.activityId && !linked.has(trace.activityId)) linked.set(trace.activityId, trace);
  }
  return linked;
}

/**
 * Traces that cannot have a timeline row of their own (Codex collaboration
 * items): live ones first, then the most recent, within a small cap.
 */
export function unlinkedSubagentTraces(
  traces: readonly SubagentTrace[],
  activityIds: ReadonlySet<string>,
  maxRows = MAX_UNLINKED_SUBAGENT_ROWS,
): SubagentTrace[] {
  return traces
    .filter((trace) => !subagentTraceHasToolRow(trace)
      && (!trace.activityId || !activityIds.has(trace.activityId)))
    .map((trace, index) => ({ trace, index }))
    .sort((left, right) => Number(right.trace.isLive) - Number(left.trace.isLive)
      || right.index - left.index)
    .slice(0, maxRows)
    .sort((left, right) => left.index - right.index)
    .map(({ trace }) => trace);
}
