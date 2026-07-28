import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AgentActivity,
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlan,
  AppSnapshot,
  ConversationDetailViewState,
  ServerEvent,
  SubagentTrace,
  ThreadUsageSnapshot,
} from "@shared/contracts";
import {
  mergeConversationShell,
  resolveConversationDetail,
} from "../utils/conversationDetail";
import type { ConnectionStatus } from "./useInertiaConnection";
import type { CommandWithoutId } from "../lib/runtimeCommands";

export interface ConversationProjectionOptions {
  snapshot: AppSnapshot | null;
  status: ConnectionStatus;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  autoOpenPlan: boolean;
  onOpenPlan: (conversationId: string) => void;
  onTerminal: () => void;
}

export function useConversationProjection({
  snapshot,
  status,
  request,
  subscribe,
  autoOpenPlan,
  onOpenPlan,
  onTerminal,
}: ConversationProjectionOptions) {
  const [detailState, setDetailState] =
    useState<ConversationDetailViewState | null>(null);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const [streamingText, setStreamingText] = useState("");
  const [streamingReasoning, setStreamingReasoning] = useState("");
  const [liveUsage, setLiveUsage] =
    useState<Record<string, ThreadUsageSnapshot>>({});
  const [liveActivities, setLiveActivities] =
    useState<Record<string, AgentActivity[]>>({});
  const [liveSubagents, setLiveSubagents] =
    useState<Record<string, SubagentTrace[]>>({});
  const [pendingApprovals, setPendingApprovals] =
    useState<AgentApprovalRequest[]>([]);
  const [pendingInputs, setPendingInputs] =
    useState<AgentInputRequest[]>([]);
  const [nativePlans, setNativePlans] =
    useState<Record<string, AgentPlan>>({});
  const requestGenerationRef = useRef(0);
  const snapshotRef = useRef(snapshot);
  const terminalCallbackRef = useRef(onTerminal);
  const openPlanCallbackRef = useRef(onOpenPlan);
  snapshotRef.current = snapshot;
  terminalCallbackRef.current = onTerminal;
  openPlanCallbackRef.current = onOpenPlan;

  const conversation = useMemo(
    () => snapshot?.conversations.find(({ id }) =>
      id === snapshot.activeConversationId) ?? null,
    [snapshot],
  );
  const detail = useMemo(() => {
    if (
      detailState?.state !== "ready"
      || detailState.conversationId !== conversation?.id
    ) {
      return null;
    }
    return conversation
      ? mergeConversationShell(detailState.detail, conversation)
      : detailState.detail;
  }, [conversation, detailState]);

  useEffect(() => {
    const conversationId = snapshot?.activeConversationId ?? null;
    if (!conversationId) {
      requestGenerationRef.current += 1;
      setDetailState(null);
      return;
    }
    setDetailState((current) => (
      current?.conversationId === conversationId && current.state === "ready"
        ? current
        : { conversationId, state: "loading" }
    ));
    if (status !== "online") {
      requestGenerationRef.current += 1;
      return;
    }

    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    void request({
      type: "conversation.detail.load",
      payload: { conversationId },
    }).then((event) => {
      if (generation !== requestGenerationRef.current) return;
      if (
        event.type !== "request.result"
        || event.result.kind !== "conversation.detail"
      ) {
        throw new Error(
          "The local service returned an unexpected chat detail response.",
        );
      }
      const result = event.result;
      const shell = snapshotRef.current?.conversations.find(
        ({ id }) => id === conversationId,
      ) ?? null;
      setDetailState((current) =>
        resolveConversationDetail(
          current,
          conversationId,
          result,
          shell,
        ));
    }).catch((error) => {
      if (generation !== requestGenerationRef.current) return;
      setDetailState({
        kind: "conversation.detail",
        conversationId,
        state: "failed",
        message: error instanceof Error
          ? error.message
          : "This chat could not be loaded.",
      });
    });
  }, [
    conversation?.latestTurn?.updatedAt,
    conversation?.updatedAt,
    detailRefresh,
    request,
    snapshot?.activeConversationId,
    status,
  ]);

  useEffect(() => {
    if (!detail) return;
    const plan = detail.plans.at(-1);
    if (!plan) return;
    setNativePlans((current) => ({
      ...current,
      [detail.conversation.id]: plan,
    }));
  }, [detail]);

  useEffect(() => subscribe((event) => {
    if (event.type === "server.welcome") {
      requestGenerationRef.current += 1;
      setDetailState(null);
      setStreamingText("");
      setStreamingReasoning("");
      setLiveUsage({});
      setLiveActivities({});
      setLiveSubagents({});
      setPendingApprovals([]);
      setPendingInputs([]);
      setNativePlans({});
      return;
    }
    if (event.type === "agent.approval.requested") {
      setPendingApprovals((current) => [
        ...current.filter(({ id }) => id !== event.request.id),
        event.request,
      ]);
      if (event.request.conversationId === conversation?.id) {
        setStreamingText("");
      }
      return;
    }
    if (event.type === "agent.approval.resolved") {
      setPendingApprovals((current) =>
        current.filter(({ id }) => id !== event.requestId));
      return;
    }
    if (event.type === "agent.input.requested") {
      setPendingInputs((current) => [
        ...current.filter(({ id }) => id !== event.request.id),
        event.request,
      ]);
      if (event.request.conversationId === conversation?.id) {
        setStreamingText("");
      }
      return;
    }
    if (event.type === "agent.input.resolved") {
      setPendingInputs((current) =>
        current.filter(({ id }) => id !== event.requestId));
      return;
    }
    if (event.type === "agent.plan.updated") {
      setNativePlans((current) => ({
        ...current,
        [event.plan.conversationId]: event.plan,
      }));
      if (event.plan.conversationId === conversation?.id) {
        setStreamingText("");
        if (autoOpenPlan) {
          openPlanCallbackRef.current(event.plan.conversationId);
        }
      }
      return;
    }
    if (event.type === "agent.usage") {
      setLiveUsage((current) => ({
        ...current,
        [event.usage.conversationId]: event.usage,
      }));
      return;
    }
    if (event.type === "agent.activity") {
      setLiveActivities((current) => {
        const existing = current[event.activity.conversationId] ?? [];
        return {
          ...current,
          [event.activity.conversationId]: [
            ...existing.filter(({ id }) => id !== event.activity.id),
            event.activity,
          ].slice(-100),
        };
      });
      if (event.activity.conversationId === conversation?.id) {
        setStreamingText("");
      }
      return;
    }
    if (event.type === "agent.subagent.updated") {
      setLiveSubagents((current) => {
        const existing = current[event.trace.conversationId] ?? [];
        return {
          ...current,
          [event.trace.conversationId]: [
            ...existing.filter(({ id }) => id !== event.trace.id),
            event.trace,
          ].slice(-128),
        };
      });
      return;
    }
    if (
      !conversation
      || !("conversationId" in event)
      || event.conversationId !== conversation.id
    ) {
      return;
    }
    if (event.type === "agent.started") {
      setStreamingText("");
      setStreamingReasoning("");
    }
    if (event.type === "agent.text") {
      setStreamingText((current) =>
        `${current}${event.text}`.slice(-500_000));
    }
    if (event.type === "agent.reasoning") {
      setStreamingReasoning((current) =>
        `${current}${event.text}`.slice(-500_000));
    }
    if (event.type === "agent.completed" || event.type === "agent.failed") {
      setStreamingText("");
      setStreamingReasoning("");
      terminalCallbackRef.current();
    }
  }), [autoOpenPlan, conversation, subscribe]);

  useEffect(() => {
    setStreamingText("");
    setStreamingReasoning("");
  }, [conversation?.id]);

  const turns = useMemo(() => detail?.agentTurns ?? [], [detail?.agentTurns]);
  const messages = useMemo(
    () => [...(detail?.messages ?? [])].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)),
    [detail?.messages],
  );
  const activities = useMemo(() => {
    if (!conversation) return [];
    const merged = new Map<string, AgentActivity>();
    for (const activity of detail?.activities ?? []) {
      merged.set(activity.id, activity);
    }
    for (const activity of liveActivities[conversation.id] ?? []) {
      merged.set(activity.id, activity);
    }
    return [...merged.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt));
  }, [conversation, detail?.activities, liveActivities]);
  const subagents = useMemo(() => {
    if (!conversation) return [];
    const merged = new Map<string, SubagentTrace>();
    for (const trace of detail?.subagents ?? []) merged.set(trace.id, trace);
    for (const trace of liveSubagents[conversation.id] ?? []) {
      merged.set(trace.id, trace);
    }
    return [...merged.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
      || a.sequence - b.sequence
      || a.id.localeCompare(b.id));
  }, [conversation, detail?.subagents, liveSubagents]);
  const usage = useMemo(() => {
    if (!conversation) return null;
    return liveUsage[conversation.id]
      ?? detail?.usage.find(({ conversationId }) =>
        conversationId === conversation.id)
      ?? null;
  }, [conversation, detail?.usage, liveUsage]);
  const plans = useMemo(() => {
    if (!conversation) return [];
    const merged = new Map<string, AgentPlan>();
    for (const plan of detail?.plans ?? []) {
      merged.set(`${plan.runId}:${plan.turnId ?? "legacy"}`, plan);
    }
    const live = nativePlans[conversation.id];
    if (live) {
      merged.set(`${live.runId}:${live.turnId ?? "legacy"}`, live);
    }
    return [...merged.values()];
  }, [conversation, detail?.plans, nativePlans]);
  const approvals = useMemo(
    () => pendingApprovals.filter(
      (request) => request.conversationId === conversation?.id,
    ),
    [conversation?.id, pendingApprovals],
  );
  const inputRequests = useMemo(
    () => pendingInputs.filter(
      (request) => request.conversationId === conversation?.id,
    ),
    [conversation?.id, pendingInputs],
  );
  const refreshDetail = useCallback(
    () => setDetailRefresh((version) => version + 1),
    [],
  );

  return {
    conversation,
    detail,
    detailState,
    refreshDetail,
    turns,
    messages,
    activities,
    subagents,
    reasonings: detail?.reasonings ?? [],
    plans,
    checkpoints: detail?.checkpoints ?? [],
    turnGitArtifacts: detail?.turnGitArtifacts ?? [],
    usage,
    streamingText,
    streamingReasoning,
    pendingApprovals: approvals,
    pendingInputs: inputRequests,
    nativePlans,
  };
}
