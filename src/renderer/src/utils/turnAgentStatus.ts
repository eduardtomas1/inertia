import type { SubagentTrace } from "@shared/contracts";
import { isBackgroundCommandTrace } from "./subagentTaskPresentation";

export interface TurnAgentStatus {
  live: number;
  running: number;
  total: number;
  failed: number;
  agents: number;
  liveAgents: number;
  commands: number;
  liveCommands: number;
}

export function turnAgentStatus(traces: readonly SubagentTrace[]): TurnAgentStatus | null {
  if (traces.length === 0) return null;
  const status: TurnAgentStatus = {
    live: 0,
    running: 0,
    total: traces.length,
    failed: 0,
    agents: 0,
    liveAgents: 0,
    commands: 0,
    liveCommands: 0,
  };
  for (const trace of traces) {
    const command = isBackgroundCommandTrace(trace);
    if (command) status.commands += 1;
    else status.agents += 1;
    if (trace.isLive) {
      status.live += 1;
      if (command) status.liveCommands += 1;
      else status.liveAgents += 1;
      if (trace.status === "running" || trace.status === "spawned") status.running += 1;
    } else if (trace.status === "failed" || trace.status === "interrupted" || trace.status === "lost") {
      status.failed += 1;
    }
  }
  return status;
}

/**
 * A turn re-renders only when a trace of its own is added, removed or
 * advanced. Provider patches raise the sequence; a user's Stop changes only
 * the update time, so both are compared.
 */
export function sameSubagentRevisions(
  previous: readonly SubagentTrace[] | undefined,
  next: readonly SubagentTrace[] | undefined,
): boolean {
  if (previous === next) return true;
  const left = previous ?? [];
  const right = next ?? [];
  return left.length === right.length
    && left.every((trace, index) => trace.id === right[index]!.id
      && trace.sequence === right[index]!.sequence
      && trace.updatedAt === right[index]!.updatedAt);
}

function counted(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function turnAgentStatusText(status: TurnAgentStatus): { text: string; failed: string | null } {
  const parts: string[] = [];
  if (status.agents > 0) {
    parts.push(status.liveAgents > 0
      ? `${counted(status.liveAgents, "agent", "agents")} working`
      : `${counted(status.agents, "agent", "agents")} finished`);
  }
  if (status.commands > 0) {
    parts.push(status.liveCommands > 0
      ? `${counted(status.liveCommands, "background command", "background commands")} running`
      : counted(status.commands, "background command", "background commands"));
  }
  return {
    text: parts.join(" · "),
    failed: status.failed > 0 ? `${status.failed} failed` : null,
  };
}
