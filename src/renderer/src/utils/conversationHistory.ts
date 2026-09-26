import type { ConversationDetail } from "@shared/contracts";

/** Keep loaded older pages while replacing the authoritative refreshed turns. */
export function mergeConversationHistory(current: ConversationDetail, incoming: ConversationDetail,
  mode: "refresh" | "older" | "target"): ConversationDetail {
  if (current.conversation.id !== incoming.conversation.id) return incoming;
  const replacedTurns = new Set(incoming.agentTurns.map(({ id }) => id));
  // A long offline gap can put an entire page between the loaded and latest
  // windows. Restart at the new page so its cursor cannot silently skip that gap.
  if (mode === "refresh" && !current.agentTurns.some(({ id }) => replacedTurns.has(id))
    && !current.messages.some(({ id }) => incoming.messages.some((message) => message.id === id))) return incoming;
  const merge = <T extends { id: string; turnId?: string | null }>(left: T[], right: T[]): T[] => {
    const values = new Map<string, T>();
    if (mode === "refresh") {
      for (const entry of left) if (!entry.turnId || !replacedTurns.has(entry.turnId)) values.set(entry.id, entry);
      for (const entry of right) values.set(entry.id, entry);
    } else {
      for (const entry of right) values.set(entry.id, entry);
      for (const entry of left) values.set(entry.id, entry);
    }
    return [...values.values()];
  };
  const retainedPlans = mode === "refresh"
    ? current.plans.filter((plan) => !plan.turnId || !replacedTurns.has(plan.turnId)) : current.plans;
  const planByRun = new Map([...incoming.plans, ...retainedPlans].map((plan) => [plan.runId, plan]));
  if (mode === "refresh") for (const plan of incoming.plans) planByRun.set(plan.runId, plan);
  return {
    ...(mode === "refresh" ? incoming : current),
    history: mode === "older" ? incoming.history : current.history ?? incoming.history,
    agentTurns: merge(current.agentTurns, incoming.agentTurns)
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.id.localeCompare(b.id)),
    messages: merge(current.messages, incoming.messages)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    activities: merge(current.activities, incoming.activities),
    subagents: merge(current.subagents, incoming.subagents),
    reasonings: merge(current.reasonings, incoming.reasonings),
    checkpoints: merge(current.checkpoints, incoming.checkpoints),
    turnGitArtifacts: merge(current.turnGitArtifacts, incoming.turnGitArtifacts),
    contextPackets: merge((current.contextPackets ?? []).filter((packet) =>
      mode !== "refresh" || packet.consumedMessageId !== null), incoming.contextPackets ?? []),
    plans: [...planByRun.values()],
  };
}
