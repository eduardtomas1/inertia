import type { SubagentTrace } from "@shared/contracts";

export interface TurnAgentStatus {
  live: number;
  running: number;
  total: number;
  failed: number;
}

export function turnAgentStatus(traces: readonly SubagentTrace[]): TurnAgentStatus | null {
  if (traces.length === 0) return null;
  let live = 0;
  let running = 0;
  let failed = 0;
  for (const trace of traces) {
    if (trace.isLive) {
      live += 1;
      if (trace.status === "running" || trace.status === "spawned") running += 1;
    } else if (trace.status === "failed" || trace.status === "interrupted" || trace.status === "lost") failed += 1;
  }
  return { live, running, total: traces.length, failed };
}

export function sameTurnAgentStatus(
  previous: readonly SubagentTrace[] | undefined,
  next: readonly SubagentTrace[] | undefined,
): boolean {
  if (previous === next) return true;
  const left = turnAgentStatus(previous ?? []);
  const right = turnAgentStatus(next ?? []);
  return left === right || (left !== null && right !== null
    && left.live === right.live
    && left.running === right.running
    && left.total === right.total
    && left.failed === right.failed);
}

function agents(count: number): string {
  return `${count} ${count === 1 ? "agent" : "agents"}`;
}

export function turnAgentStatusText(status: TurnAgentStatus): { text: string; failed: string | null } {
  return {
    text: status.live > 0 ? `${agents(status.live)} working` : `${agents(status.total)} finished`,
    failed: status.failed > 0 ? `${status.failed} failed` : null,
  };
}
