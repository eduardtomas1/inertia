import type { AgentTurn, SubagentTrace } from "@shared/contracts";
import type {
  CustomAgent,
  CustomAgentAccent,
  CustomAgentCallAttribution,
  CustomAgentIcon,
} from "@shared/custom-agents";
import {
  subagentDisclosureRows,
  subagentTokensLabel,
  subagentTraceLabel,
  type SubagentDisclosureRow,
} from "../subagentDisclosure";

export interface SubagentCallIdentity {
  agentId: string | null;
  name: string;
  handle: string | null;
  icon: CustomAgentIcon;
  accent: CustomAgentAccent;
}

export interface SubagentCallEntry {
  kind: "subagent-call";
  id: string;
  createdAt: string;
  trace: SubagentTrace;
  agent: SubagentCallIdentity;
  canStop: boolean;
  children: SubagentDisclosureRow[];
}

export interface SubagentCallPartition {
  entries: SubagentCallEntry[];
  remaining: SubagentTrace[];
}

const NO_TURNS: readonly AgentTurn[] = [];
const FALLBACK_ICON: CustomAgentIcon = { kind: "symbol", name: "orbit" };

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function callIdentity(
  trace: SubagentTrace,
  customAgentsById: ReadonlyMap<string, CustomAgent>,
  attribution: CustomAgentCallAttribution | undefined,
): SubagentCallIdentity {
  const agentId = trace.customAgentId ?? null;
  const agent = agentId ? customAgentsById.get(agentId) : undefined;
  if (agent) {
    return { agentId: agent.id, name: agent.name, handle: agent.handle, icon: agent.icon, accent: agent.accent };
  }
  if (attribution && (attribution.agentId === agentId || agentId === null)) {
    return {
      agentId: attribution.agentId,
      name: attribution.name,
      handle: attribution.handle,
      icon: attribution.icon,
      accent: attribution.accent,
    };
  }
  return { agentId, name: subagentTraceLabel(trace), handle: null, icon: FALLBACK_ICON, accent: null };
}

export function customAgentsById(
  agents: readonly CustomAgent[] | undefined,
): ReadonlyMap<string, CustomAgent> {
  return new Map((agents ?? []).map((agent) => [agent.id, agent]));
}

export function partitionSubagentCalls(
  traces: readonly SubagentTrace[],
  agentsById: ReadonlyMap<string, CustomAgent>,
  attribution: CustomAgentCallAttribution | undefined,
  turns: readonly AgentTurn[] = NO_TURNS,
): SubagentCallPartition {
  if (!traces.some(({ customAgentId }) => customAgentId)) {
    return { entries: [], remaining: traces as SubagentTrace[] };
  }
  const byId = new Map(traces.map((trace) => [trace.id, trace]));
  const rows = subagentDisclosureRows(traces, turns);
  const entries: SubagentCallEntry[] = [];
  const covered = new Set<string>();
  rows.forEach((row, index) => {
    const { trace } = row;
    if (!trace.customAgentId || covered.has(trace.id)) return;
    const parent = trace.parentTraceId ? byId.get(trace.parentTraceId) : undefined;
    if (parent?.customAgentId === trace.customAgentId) return;
    covered.add(trace.id);
    const children: SubagentDisclosureRow[] = [];
    for (const child of rows.slice(index + 1)) {
      if (child.depth <= row.depth) break;
      covered.add(child.trace.id);
      children.push({ ...child, depth: child.depth - row.depth - 1 });
    }
    entries.push({
      kind: "subagent-call",
      id: `subagent-call:${trace.id}`,
      createdAt: trace.createdAt,
      trace,
      agent: callIdentity(trace, agentsById, attribution),
      canStop: row.canStop,
      children,
    });
  });
  entries.sort((left, right) => timestamp(left.createdAt) - timestamp(right.createdAt));
  return {
    entries,
    remaining: traces.filter(({ id }) => !covered.has(id)),
  };
}

export function mergeSubagentCalls<T extends { createdAt: string }>(
  stream: readonly T[],
  calls: readonly SubagentCallEntry[],
): Array<T | SubagentCallEntry> {
  if (calls.length === 0) return stream as T[];
  const pending = [...calls];
  const merged: Array<T | SubagentCallEntry> = [];
  for (const entry of stream) {
    while (pending.length > 0 && timestamp(pending[0]!.createdAt) <= timestamp(entry.createdAt)) {
      merged.push(pending.shift()!);
    }
    merged.push(entry);
  }
  return [...merged, ...pending];
}

export function withSubagentCalls<T extends { createdAt: string }>(
  stream: readonly T[],
  traces: readonly SubagentTrace[],
  agentsById: ReadonlyMap<string, CustomAgent>,
  attribution: CustomAgentCallAttribution | undefined,
  turns: readonly AgentTurn[] = NO_TURNS,
): Array<T | SubagentCallEntry> {
  return mergeSubagentCalls(stream, partitionSubagentCalls(traces, agentsById, attribution, turns).entries);
}

export function subagentCallLine(trace: SubagentTrace, live: boolean): { text: string; tone: "live" | "done" | "danger" | "muted" } | null {
  if (live) {
    const text = trace.activity ?? trace.progress;
    return text ? { text, tone: "live" } : null;
  }
  if (trace.status === "cancelled") return { text: "Stopped", tone: "muted" };
  if (trace.status === "failed" || trace.status === "interrupted" || trace.status === "lost") {
    return { text: "Failed", tone: "danger" };
  }
  const firstLine = trace.result?.split("\n").map((line) => line.trim()).find(Boolean);
  return firstLine ? { text: firstLine, tone: "done" } : null;
}

export function subagentCallMeta(trace: SubagentTrace, formatDuration: (ms: number) => string): string {
  return [
    trace.model,
    subagentTokensLabel(trace),
    trace.toolUseCount == null ? null : `${trace.toolUseCount} ${trace.toolUseCount === 1 ? "tool use" : "tool uses"}`,
    trace.durationMs == null ? null : formatDuration(trace.durationMs),
  ].filter(Boolean).join(" · ");
}

export function sameSubagentCallEntry(left: SubagentCallEntry, right: SubagentCallEntry): boolean {
  return left.trace === right.trace
    && left.canStop === right.canStop
    && left.agent.name === right.agent.name
    && left.agent.icon === right.agent.icon
    && left.agent.accent === right.agent.accent
    && left.children.length === right.children.length
    && left.children.every((child, index) =>
      child.trace === right.children[index]!.trace
      && child.depth === right.children[index]!.depth
      && child.canStop === right.children[index]!.canStop);
}

export function sameSubagentCallsForTurn(
  previousTraces: readonly SubagentTrace[] | undefined,
  nextTraces: readonly SubagentTrace[] | undefined,
  previousAgents: readonly CustomAgent[] | undefined,
  nextAgents: readonly CustomAgent[] | undefined,
): boolean {
  const sameTraces = previousTraces === nextTraces
    || (!previousTraces?.length && !nextTraces?.length);
  return sameTraces && (
    previousAgents === nextAgents
    || !nextTraces?.some(({ customAgentId }) => customAgentId)
  );
}
