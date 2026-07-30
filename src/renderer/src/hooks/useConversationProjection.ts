import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AgentActivity,
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlan,
  AppSnapshot,
  ChatMessage,
  ConversationShell,
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
  /**
   * Loads a specific conversation without changing the runtime's active
   * conversation. `undefined` preserves the primary-workspace behavior.
   */
  targetConversationId?: string | null;
  /** Keeps the secondary pane dormant until a split conversation exists. */
  enabled?: boolean;
  autoOpenPlan: boolean;
  onOpenPlan: (conversationId: string) => void;
  onTerminal: () => void;
}

export function useConversationProjection({
  snapshot,
  status,
  request,
  subscribe,
  targetConversationId,
  enabled = true,
  autoOpenPlan,
  onOpenPlan,
  onTerminal,
}: ConversationProjectionOptions) {
  const [detailState, setDetailState] =
    useState<ConversationDetailViewState | null>(null);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const [streamingText, setStreamingText] = useState("");
  const [streamingReasoning, setStreamingReasoning] = useState("");
  const [liveMessages, setLiveMessages] =
    useState<Record<string, ChatMessage[]>>({});
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
  const conversationRef = useRef<ConversationShell | null>(null);
  const enabledRef = useRef(enabled);
  const autoOpenPlanRef = useRef(autoOpenPlan);
  const terminalCallbackRef = useRef(onTerminal);
  const openPlanCallbackRef = useRef(onOpenPlan);
  snapshotRef.current = snapshot;
  enabledRef.current = enabled;
  autoOpenPlanRef.current = autoOpenPlan;
  terminalCallbackRef.current = onTerminal;
  openPlanCallbackRef.current = onOpenPlan;

  const conversationId = enabled
    ? targetConversationId === undefined
      ? snapshot?.activeConversationId ?? null
      : targetConversationId
    : null;
  const subscriptionOwner = targetConversationId === undefined
    ? "primary"
    : "secondary";
  const conversation = useMemo(
    () => snapshot?.conversations.find(({ id }) =>
      id === conversationId) ?? null,
    [conversationId, snapshot],
  );
  conversationRef.current = conversation;
  useEffect(() => {
    if (enabled) return;
    setStreamingText("");
    setStreamingReasoning("");
    setLiveMessages({});
    setLiveUsage({});
    setLiveActivities({});
    setLiveSubagents({});
    setNativePlans({});
  }, [enabled]);
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
    if (!conversationId) return;
    const setSubscription = (nextConversationId: string | null): void => {
      void request({
        type: "conversation.detail.subscription",
        payload: {
          owner: subscriptionOwner,
          conversationId: nextConversationId,
        },
      }).catch(() => undefined);
    };
    setSubscription(conversationId);
    return () => setSubscription(null);
  }, [conversationId, request, subscriptionOwner]);

  useEffect(() => {
    if (status !== "online" || !conversationId) return;
    void request({
      type: "conversation.detail.subscription",
      payload: {
        owner: subscriptionOwner,
        conversationId,
      },
    }).catch(() => undefined);
  }, [conversationId, request, status, subscriptionOwner]);

  useEffect(() => {
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
    detailRefresh,
    conversationId,
    request,
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

  useEffect(() => {
    if (!detail || detail.conversation.id !== conversation?.id) return;
    const authoritativeMessages = new Map(
      detail.messages.map((message) => [message.id, message]),
    );
    const authoritativeActivities = new Map(
      detail.activities.map((activity) => [activity.id, activity]),
    );
    const authoritativeSubagents = new Map(
      detail.subagents.map((trace) => [trace.id, trace]),
    );
    const authoritativeUsage = detail.usage.find(
      ({ conversationId }) => conversationId === detail.conversation.id,
    );
    const authoritativePlan = detail.plans.at(-1);
    const conversationId = detail.conversation.id;

    setLiveMessages((current) => {
      const existing = current[conversationId];
      if (!existing) return current;
      const remaining = existing.filter((message) => {
        const stored = authoritativeMessages.get(message.id);
        return !stored || stored.content !== message.content;
      });
      if (remaining.length === existing.length) return current;
      const next = { ...current };
      if (remaining.length > 0) next[conversationId] = remaining;
      else delete next[conversationId];
      return next;
    });
    setLiveActivities((current) => {
      const existing = current[conversationId];
      if (!existing) return current;
      const remaining = existing.filter((activity) => {
        const stored = authoritativeActivities.get(activity.id);
        return !stored
          || stored.title !== activity.title
          || stored.detail !== activity.detail
          || stored.status !== activity.status;
      });
      if (remaining.length === existing.length) return current;
      const next = { ...current };
      if (remaining.length > 0) next[conversationId] = remaining;
      else delete next[conversationId];
      return next;
    });
    setLiveSubagents((current) => {
      const existing = current[conversationId];
      if (!existing) return current;
      const remaining = existing.filter((trace) => {
        const stored = authoritativeSubagents.get(trace.id);
        return !stored || stored.sequence < trace.sequence;
      });
      if (remaining.length === existing.length) return current;
      const next = { ...current };
      if (remaining.length > 0) next[conversationId] = remaining;
      else delete next[conversationId];
      return next;
    });
    if (authoritativeUsage) {
      setLiveUsage((current) => {
        const live = current[conversationId];
        if (!live || live.updatedAt > authoritativeUsage.updatedAt) {
          return current;
        }
        const next = { ...current };
        delete next[conversationId];
        return next;
      });
    }
    if (authoritativePlan) {
      setNativePlans((current) => {
        const live = current[conversationId];
        if (
          !live
          || live.runId !== authoritativePlan.runId
          || live.turnId !== authoritativePlan.turnId
          || live.explanation !== authoritativePlan.explanation
          || JSON.stringify(live.steps) !== JSON.stringify(authoritativePlan.steps)
        ) {
          return current;
        }
        const next = { ...current };
        delete next[conversationId];
        return next;
      });
    }
  }, [conversation?.id, detail]);

  useEffect(() => subscribe((event) => {
    const activeConversation = conversationRef.current;
    const projectionEnabled = enabledRef.current;
    if (event.type === "server.welcome") {
      requestGenerationRef.current += 1;
      setDetailState(null);
      setStreamingText("");
      setStreamingReasoning("");
      setLiveMessages({});
      setLiveUsage({});
      setLiveActivities({});
      setLiveSubagents({});
      setPendingApprovals([]);
      setPendingInputs([]);
      setNativePlans({});
      return;
    }
    if (event.type === "snapshot.updated") {
      const nextConversation = event.snapshot.conversations.find(
        ({ id }) => id === activeConversation?.id,
      );
      if (
        projectionEnabled
        && activeConversation
        && nextConversation
        && nextConversation.updatedAt !== activeConversation.updatedAt
      ) {
        setDetailRefresh((current) => current + 1);
      }
      return;
    }
    if (event.type === "agent.approval.requested") {
      setPendingApprovals((current) => [
        ...current.filter(({ id, conversationId }) =>
          id !== event.request.id
          || conversationId !== event.request.conversationId),
        event.request,
      ]);
      if (
        projectionEnabled
        && event.request.conversationId === activeConversation?.id
      ) {
        setStreamingText("");
      }
      return;
    }
    if (event.type === "agent.approval.resolved") {
      setPendingApprovals((current) =>
        current.filter(({ id, conversationId }) =>
          id !== event.requestId
          || conversationId !== event.conversationId));
      return;
    }
    if (event.type === "agent.input.requested") {
      setPendingInputs((current) => [
        ...current.filter(({ id, conversationId }) =>
          id !== event.request.id
          || conversationId !== event.request.conversationId),
        event.request,
      ]);
      if (
        projectionEnabled
        && event.request.conversationId === activeConversation?.id
      ) {
        setStreamingText("");
      }
      return;
    }
    if (event.type === "agent.input.resolved") {
      setPendingInputs((current) =>
        current.filter(({ id, conversationId }) =>
          id !== event.requestId
          || conversationId !== event.conversationId));
      return;
    }
    if (!projectionEnabled) return;
    if (event.type === "agent.commentary.persisted") {
      if (event.message.conversationId !== activeConversation?.id) return;
      setLiveMessages((current) => {
        const existing = current[event.message.conversationId] ?? [];
        return {
          ...current,
          [event.message.conversationId]: [
            ...existing.filter(({ id }) => id !== event.message.id),
            event.message,
          ].slice(-64),
        };
      });
      setStreamingText("");
      return;
    }
    if (event.type === "agent.plan.updated") {
      if (event.plan.conversationId !== activeConversation?.id) return;
      setNativePlans((current) => ({
        ...current,
        [event.plan.conversationId]: event.plan,
      }));
      if (event.plan.conversationId === activeConversation?.id) {
        setStreamingText("");
        if (autoOpenPlanRef.current) {
          openPlanCallbackRef.current(event.plan.conversationId);
        }
      }
      return;
    }
    if (event.type === "agent.usage") {
      if (event.usage.conversationId !== activeConversation?.id) return;
      setLiveUsage((current) => ({
        ...current,
        [event.usage.conversationId]: event.usage,
      }));
      return;
    }
    if (event.type === "agent.activity") {
      if (event.activity.conversationId !== activeConversation?.id) return;
      setStreamingText("");
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
      return;
    }
    if (event.type === "agent.subagent.updated") {
      if (event.trace.conversationId !== activeConversation?.id) return;
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
      !activeConversation
      || !("conversationId" in event)
      || event.conversationId !== activeConversation.id
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
  }), [subscribe]);

  useEffect(() => {
    setStreamingText("");
    setStreamingReasoning("");
    setLiveMessages({});
    setLiveUsage({});
    setLiveActivities({});
    setLiveSubagents({});
    setNativePlans({});
  }, [conversation?.id]);

  const turns = useMemo(() => detail?.agentTurns ?? [], [detail?.agentTurns]);
  const messages = useMemo(
    () => {
      const merged = new Map<string, ChatMessage>();
      for (const message of detail?.messages ?? []) merged.set(message.id, message);
      if (conversation) {
        for (const message of liveMessages[conversation.id] ?? []) {
          merged.set(message.id, message);
        }
      }
      return [...merged.values()].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt));
    },
    [conversation, detail?.messages, liveMessages],
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
