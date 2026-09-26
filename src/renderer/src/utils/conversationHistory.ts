import type { ConversationDetail } from "@shared/contracts";

export function mergeConversationHistory(current: ConversationDetail, incoming: ConversationDetail,
  mode: "refresh" | "older" | "target"): ConversationDetail {
  if (current.conversation.id !== incoming.conversation.id) return incoming;
  const replacedTurns = new Set(incoming.agentTurns.map(({ id }) => id));
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
  const agentTurns = merge(current.agentTurns, incoming.agentTurns)
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt, "en") || a.id.localeCompare(b.id, "en"));
  const incomingPlanRuns = new Set(incoming.plans.map(({ runId }) => runId));
  const retainedPlans = mode === "refresh"
    ? current.plans.filter((plan) => !incomingPlanRuns.has(plan.runId)
      && (!plan.turnId || !replacedTurns.has(plan.turnId))) : current.plans;
  const planSources = mode === "refresh"
    ? [...retainedPlans, ...incoming.plans] : [...incoming.plans, ...retainedPlans];
  const planByRun = new Map(planSources.map((plan) => [plan.runId, plan]));
  const turnOrder = new Map(agentTurns.map(({ id }, index) => [id, index]));
  const planOrder = (turnId: string | null) => turnId === null ? -1 : turnOrder.get(turnId) ?? -1;
  const plans = [...planByRun.values()].sort((a, b) => planOrder(a.turnId) - planOrder(b.turnId));
  const currentOmitted = current.history?.omittedTurnIds ?? [];
  const omittedTurnIds = [
    ...currentOmitted.filter((id) => mode !== "refresh" || !replacedTurns.has(id)),
    ...(incoming.history?.omittedTurnIds ?? []).filter((id) => mode === "refresh" || !current.agentTurns.some((turn) => turn.id === id)),
  ];
  const unchanged = omittedTurnIds.length === currentOmitted.length
    && omittedTurnIds.every((id) => currentOmitted.includes(id));
  const page = mode === "older" ? incoming.history : current.history ?? incoming.history;
  const history = !page || (unchanged && page === current.history) ? page
    : { older: page.older, ...(omittedTurnIds.length ? { omittedTurnIds: unchanged ? currentOmitted : omittedTurnIds } : {}) };
  return {
    ...(mode === "refresh" ? incoming : current),
    history,
    agentTurns,
    messages: merge(current.messages, incoming.messages)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt, "en") || a.id.localeCompare(b.id, "en")),
    activities: merge(current.activities, incoming.activities),
    subagents: merge(current.subagents, incoming.subagents),
    reasonings: merge(current.reasonings, incoming.reasonings),
    checkpoints: merge(current.checkpoints, incoming.checkpoints),
    turnGitArtifacts: merge(current.turnGitArtifacts, incoming.turnGitArtifacts),
    contextPackets: merge((current.contextPackets ?? []).filter((packet) =>
      mode !== "refresh" || packet.consumedMessageId !== null), incoming.contextPackets ?? []),
    plans,
  };
}
