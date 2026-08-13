import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AgentActivity,
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlan,
  AgentReasoning,
  AppSnapshot,
  ChatMessage,
  CheckpointSummary,
  ConversationShell,
  ConversationDetailViewState,
  ServerEvent,
  SubagentTrace,
  ThreadUsageSnapshot,
  TurnGitArtifact,
} from "@shared/contracts";
import {
  mergeConversationShell,
  resolveConversationDetail,
} from "../utils/conversationDetail";
import type { ConnectionStatus } from "./useInertiaConnection";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { markTestStreamingStage } from "../utils/testStreamingTrace";
import type { StreamingAgentChannel } from "../utils/responseTimeline";

const EMPTY_REASONINGS: AgentReasoning[] = [];
const EMPTY_CHECKPOINTS: CheckpointSummary[] = [];
const EMPTY_GIT_ARTIFACTS: TurnGitArtifact[] = [];
const MAX_STREAMING_CHARACTERS = 500_000;

interface FreshHydrationBaseline {
  conversationId: string;
  syncCompleted: boolean;
  streamingTextDelta: string | null;
  streamingReasoningDelta: string | null;
  streamingChannelDelta: StreamingAgentChannel;
  liveMessages: ChatMessage[];
  liveUsage: ThreadUsageSnapshot | null;
  liveActivities: AgentActivity[];
  liveSubagents: SubagentTrace[];
  nativePlan: AgentPlan | null;
  effectivePlan: AgentPlan | null;
  approvals: Map<string, AgentApprovalRequest>;
  inputs: Map<string, AgentInputRequest>;
  hydratedApprovals: Set<string>;
  hydratedInputs: Set<string>;
}

function sameAgentPlan(
  left: AgentPlan | null,
  right: AgentPlan,
): boolean {
  return left !== null
    && left.conversationId === right.conversationId
    && left.runId === right.runId
    && left.turnId === right.turnId
    && left.explanation === right.explanation
    && JSON.stringify(left.steps) === JSON.stringify(right.steps);
}

function interactionKey(value: {
  conversationId: string;
  id: string;
}): string {
  return `${value.conversationId}\0${value.id}`;
}

function withoutHydratedBaseline<T extends { id: string }>(
  current: Record<string, T[]>,
  conversationId: string,
  baseline: readonly T[],
): Record<string, T[]> {
  const existing = current[conversationId];
  if (!existing || baseline.length === 0) return current;
  const baselineRecords = new Map(baseline.map((value) => [value.id, value]));
  const remaining = existing.filter((value) =>
    baselineRecords.get(value.id) !== value);
  if (remaining.length === existing.length) return current;
  const next = { ...current };
  if (remaining.length > 0) next[conversationId] = remaining;
  else delete next[conversationId];
  return next;
}

function compareCreatedRecords(
  left: { createdAt: string; id: string },
  right: { createdAt: string; id: string },
): number {
  if (left.createdAt < right.createdAt) return -1;
  if (left.createdAt > right.createdAt) return 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function compareCreatedAt(
  left: { createdAt: string },
  right: { createdAt: string },
): number {
  return left.createdAt < right.createdAt
    ? -1
    : left.createdAt > right.createdAt
      ? 1
      : 0;
}

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
  const [streamingChannel, setStreamingChannel] =
    useState<StreamingAgentChannel>(null);
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
  const terminalRefreshPendingRef = useRef(false);
  const freshHydrationRef = useRef<FreshHydrationBaseline | null>(null);
  const snapshotRef = useRef(snapshot);
  const conversationRef = useRef<ConversationShell | null>(null);
  const detailStateRef = useRef(detailState);
  const liveMessagesRef = useRef(liveMessages);
  const liveUsageRef = useRef(liveUsage);
  const liveActivitiesRef = useRef(liveActivities);
  const liveSubagentsRef = useRef(liveSubagents);
  const pendingApprovalsRef = useRef(pendingApprovals);
  const pendingInputsRef = useRef(pendingInputs);
  const nativePlansRef = useRef(nativePlans);
  const enabledRef = useRef(enabled);
  const autoOpenPlanRef = useRef(autoOpenPlan);
  const terminalCallbackRef = useRef(onTerminal);
  const openPlanCallbackRef = useRef(onOpenPlan);
  snapshotRef.current = snapshot;
  detailStateRef.current = detailState;
  liveMessagesRef.current = liveMessages;
  liveUsageRef.current = liveUsage;
  liveActivitiesRef.current = liveActivities;
  liveSubagentsRef.current = liveSubagents;
  pendingApprovalsRef.current = pendingApprovals;
  pendingInputsRef.current = pendingInputs;
  nativePlansRef.current = nativePlans;
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
    freshHydrationRef.current = null;
    terminalRefreshPendingRef.current = false;
    setStreamingText("");
    setStreamingReasoning("");
    setStreamingChannel(null);
    setLiveMessages({});
    setLiveUsage({});
    setLiveActivities({});
    setLiveSubagents({});
    setNativePlans({});
  }, [enabled]);
  useEffect(() => {
    if (status !== "online") setStreamingChannel(null);
  }, [status]);
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
      const hydration = freshHydrationRef.current;
      if (
        result.state === "ready"
        && hydration?.conversationId === conversationId
      ) {
        freshHydrationRef.current = null;
        setStreamingText(hydration.streamingTextDelta ?? "");
        setStreamingReasoning(hydration.streamingReasoningDelta ?? "");
        setStreamingChannel(hydration.streamingChannelDelta);
        setLiveMessages((current) => withoutHydratedBaseline(
          current,
          conversationId,
          hydration.liveMessages,
        ));
        setLiveActivities((current) => withoutHydratedBaseline(
          current,
          conversationId,
          hydration.liveActivities,
        ));
        setLiveSubagents((current) => withoutHydratedBaseline(
          current,
          conversationId,
          hydration.liveSubagents,
        ));
        setLiveUsage((current) => {
          if (
            hydration.liveUsage === null
            || current[conversationId] !== hydration.liveUsage
          ) return current;
          const next = { ...current };
          delete next[conversationId];
          return next;
        });
        setNativePlans((current) => {
          if (
            hydration.nativePlan === null
            || current[conversationId] !== hydration.nativePlan
          ) return current;
          const next = { ...current };
          delete next[conversationId];
          return next;
        });
      }
      if (
        result.state === "ready"
        && terminalRefreshPendingRef.current
      ) {
        terminalRefreshPendingRef.current = false;
        setStreamingText("");
        setStreamingReasoning("");
        setStreamingChannel(null);
      }
    }).catch((error) => {
      if (generation !== requestGenerationRef.current) return;
      setDetailState((current) => (
        current?.conversationId === conversationId
        && current.state === "ready"
          ? current
          : {
              kind: "conversation.detail",
              conversationId,
              state: "failed",
              message: error instanceof Error
                ? error.message
                : "This chat could not be loaded.",
            }
      ));
    });
  }, [
    detailRefresh,
    conversationId,
    request,
    status,
  ]);

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
      terminalRefreshPendingRef.current = false;
      const currentDetail = detailStateRef.current;
      const remainsMounted = Boolean(
        projectionEnabled
        && activeConversation
        && currentDetail?.state === "ready"
        && currentDetail.conversationId === activeConversation.id
        && event.snapshot.conversations.some(
          ({ id }) => id === activeConversation.id,
        )
        && (
          subscriptionOwner === "secondary"
          || event.snapshot.activeConversationId === activeConversation.id
        )
      );
      if (remainsMounted && activeConversation) {
        // A disconnected stream is historical until this runtime generation
        // replays a new text or reasoning delta for the mounted conversation.
        setStreamingChannel(null);
        freshHydrationRef.current = {
          conversationId: activeConversation.id,
          syncCompleted: false,
          streamingTextDelta: null,
          streamingReasoningDelta: null,
          streamingChannelDelta: null,
          liveMessages: liveMessagesRef.current[activeConversation.id] ?? [],
          liveUsage: liveUsageRef.current[activeConversation.id] ?? null,
          liveActivities:
            liveActivitiesRef.current[activeConversation.id] ?? [],
          liveSubagents:
            liveSubagentsRef.current[activeConversation.id] ?? [],
          nativePlan: nativePlansRef.current[activeConversation.id] ?? null,
          effectivePlan:
            nativePlansRef.current[activeConversation.id]
            ?? (currentDetail?.state === "ready"
              ? currentDetail.detail.plans.at(-1) ?? null
              : null),
          approvals: new Map(
            pendingApprovalsRef.current.map((request) => [
              interactionKey(request),
              request,
            ]),
          ),
          inputs: new Map(
            pendingInputsRef.current.map((request) => [
              interactionKey(request),
              request,
            ]),
          ),
          hydratedApprovals: new Set(),
          hydratedInputs: new Set(),
        };
      } else {
        freshHydrationRef.current = null;
        setDetailState(null);
        setStreamingText("");
        setStreamingReasoning("");
        setStreamingChannel(null);
        setLiveMessages({});
        setLiveUsage({});
        setLiveActivities({});
        setLiveSubagents({});
        setPendingApprovals([]);
        setPendingInputs([]);
        setNativePlans({});
      }
      return;
    }
    if (event.type === "runtime.sync.completed") {
      const hydration = freshHydrationRef.current;
      if (hydration) {
        hydration.syncCompleted = true;
        setPendingApprovals((current) => current.filter((request) => {
          const key = interactionKey(request);
          return !hydration.approvals.has(key)
            || hydration.hydratedApprovals.has(key);
        }));
        setPendingInputs((current) => current.filter((request) => {
          const key = interactionKey(request);
          return !hydration.inputs.has(key)
            || hydration.hydratedInputs.has(key);
        }));
      }
      return;
    }
    if (event.type === "conversation.detail.invalidated") {
      if (
        projectionEnabled
        && event.conversationId === activeConversation?.id
      ) {
        setDetailRefresh((current) => current + 1);
      }
      return;
    }
    if (event.type === "agent.approval.requested") {
      freshHydrationRef.current?.hydratedApprovals.add(
        interactionKey(event.request),
      );
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
        if (freshHydrationRef.current) {
          freshHydrationRef.current.streamingTextDelta = "";
          freshHydrationRef.current.streamingChannelDelta = null;
        }
        setStreamingText("");
        setStreamingChannel(null);
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
      freshHydrationRef.current?.hydratedInputs.add(
        interactionKey(event.request),
      );
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
        if (freshHydrationRef.current) {
          freshHydrationRef.current.streamingTextDelta = "";
          freshHydrationRef.current.streamingChannelDelta = null;
        }
        setStreamingText("");
        setStreamingChannel(null);
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
    if (event.type === "conversation.message.persisted") {
      if (event.message.conversationId !== activeConversation?.id) return;
      setLiveMessages((current) => {
        const existing = current[event.message.conversationId] ?? [];
        return {
          ...current,
          [event.message.conversationId]: [
            ...existing.filter(({ id }) => id !== event.message.id),
            event.message,
          ],
        };
      });
      return;
    }
    if (event.type === "agent.commentary.persisted") {
      if (event.message.conversationId !== activeConversation?.id) return;
      setLiveMessages((current) => {
        const existing = current[event.message.conversationId] ?? [];
        return {
          ...current,
          [event.message.conversationId]: [
            ...existing.filter(({ id }) => id !== event.message.id),
            event.message,
          ],
        };
      });
      if (freshHydrationRef.current) {
        freshHydrationRef.current.streamingTextDelta = "";
        freshHydrationRef.current.streamingChannelDelta = null;
      }
      setStreamingText("");
      setStreamingChannel(null);
      return;
    }
    if (event.type === "agent.plan.updated") {
      if (event.plan.conversationId !== activeConversation?.id) return;
      const hydration = freshHydrationRef.current;
      const replayedHydrationPlan = Boolean(
        hydration
        && !hydration.syncCompleted
        && hydration.conversationId === event.plan.conversationId
        && sameAgentPlan(hydration.effectivePlan, event.plan),
      );
      setNativePlans((current) => ({
        ...current,
        [event.plan.conversationId]: event.plan,
      }));
      if (event.plan.conversationId === activeConversation?.id) {
        if (replayedHydrationPlan) {
          if (hydration) hydration.streamingChannelDelta = null;
          setStreamingChannel(null);
          return;
        }
        if (hydration) {
          hydration.streamingTextDelta = "";
          hydration.streamingChannelDelta = null;
        }
        setStreamingText("");
        setStreamingChannel(null);
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
      if (freshHydrationRef.current) {
        freshHydrationRef.current.streamingTextDelta = "";
        freshHydrationRef.current.streamingChannelDelta = null;
      }
      setStreamingText("");
      setStreamingChannel(null);
      setLiveActivities((current) => {
        const existing = current[event.activity.conversationId] ?? [];
        return {
          ...current,
          [event.activity.conversationId]: [
            ...existing.filter(({ id }) => id !== event.activity.id),
            event.activity,
          ],
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
          ],
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
      terminalRefreshPendingRef.current = false;
      if (freshHydrationRef.current) {
        freshHydrationRef.current.streamingTextDelta = "";
        freshHydrationRef.current.streamingReasoningDelta = "";
        freshHydrationRef.current.streamingChannelDelta = null;
      }
      setStreamingText("");
      setStreamingReasoning("");
      setStreamingChannel(null);
    }
    if (event.type === "agent.text") {
      const hydration = freshHydrationRef.current;
      if (hydration) {
        hydration.streamingTextDelta = `${
          hydration.streamingTextDelta ?? ""
        }${event.text}`.slice(-MAX_STREAMING_CHARACTERS);
      }
      setStreamingText((current) =>
        `${current}${event.text}`.slice(-MAX_STREAMING_CHARACTERS));
      setStreamingChannel("text");
      if (hydration) hydration.streamingChannelDelta = "text";
      markTestStreamingStage("renderer-projection-updated");
    }
    if (event.type === "agent.reasoning") {
      const hydration = freshHydrationRef.current;
      if (hydration) {
        hydration.streamingReasoningDelta = `${
          hydration.streamingReasoningDelta ?? ""
        }${event.text}`.slice(-MAX_STREAMING_CHARACTERS);
      }
      setStreamingReasoning((current) =>
        `${current}${event.text}`.slice(-MAX_STREAMING_CHARACTERS));
      setStreamingChannel("reasoning");
      if (hydration) hydration.streamingChannelDelta = "reasoning";
    }
    if (event.type === "agent.completed" || event.type === "agent.failed") {
      if (freshHydrationRef.current) {
        freshHydrationRef.current.streamingChannelDelta = null;
      }
      setStreamingChannel(null);
      terminalRefreshPendingRef.current = true;
      terminalCallbackRef.current();
    }
  }), [subscribe, subscriptionOwner]);

  useEffect(() => {
    freshHydrationRef.current = null;
    terminalRefreshPendingRef.current = false;
    setStreamingText("");
    setStreamingReasoning("");
    setStreamingChannel(null);
    setLiveMessages({});
    setLiveUsage({});
    setLiveActivities({});
    setLiveSubagents({});
    setNativePlans({});
  }, [conversation?.id]);

  const activeConversationId = conversation?.id ?? null;
  const turns = useMemo(() => detail?.agentTurns ?? [], [detail?.agentTurns]);
  const messages = useMemo(
    () => {
      const merged = new Map<string, ChatMessage>();
      for (const message of detail?.messages ?? []) merged.set(message.id, message);
      if (activeConversationId) {
        for (const message of liveMessages[activeConversationId] ?? []) {
          merged.set(message.id, message);
        }
      }
      return [...merged.values()].sort(compareCreatedRecords);
    },
    [activeConversationId, detail?.messages, liveMessages],
  );
  const activities = useMemo(() => {
    if (!activeConversationId) return [];
    const merged = new Map<string, AgentActivity>();
    for (const activity of detail?.activities ?? []) {
      merged.set(activity.id, activity);
    }
    for (const activity of liveActivities[activeConversationId] ?? []) {
      merged.set(activity.id, activity);
    }
    return [...merged.values()].sort(compareCreatedRecords);
  }, [activeConversationId, detail?.activities, liveActivities]);
  const subagents = useMemo(() => {
    if (!activeConversationId) return [];
    const merged = new Map<string, SubagentTrace>();
    for (const trace of detail?.subagents ?? []) merged.set(trace.id, trace);
    for (const trace of liveSubagents[activeConversationId] ?? []) {
      merged.set(trace.id, trace);
    }
    return [...merged.values()].sort((a, b) =>
      compareCreatedAt(a, b)
      || a.sequence - b.sequence
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }, [activeConversationId, detail?.subagents, liveSubagents]);
  const usage = useMemo(() => {
    if (!activeConversationId) return null;
    return liveUsage[activeConversationId]
      ?? detail?.usage.find(({ conversationId }) =>
        conversationId === activeConversationId)
      ?? null;
  }, [activeConversationId, detail?.usage, liveUsage]);
  const plans = useMemo(() => {
    if (!activeConversationId) return [];
    const merged = new Map<string, AgentPlan>();
    for (const plan of detail?.plans ?? []) {
      merged.set(`${plan.runId}:${plan.turnId ?? "legacy"}`, plan);
    }
    const live = nativePlans[activeConversationId];
    if (live) {
      merged.set(`${live.runId}:${live.turnId ?? "legacy"}`, live);
    }
    return [...merged.values()];
  }, [activeConversationId, detail?.plans, nativePlans]);
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
    latestTurnSummary: conversation?.latestTurn ?? null,
    detail,
    detailState,
    refreshDetail,
    turns,
    messages,
    activities,
    subagents,
    reasonings: detail?.reasonings ?? EMPTY_REASONINGS,
    plans,
    checkpoints: detail?.checkpoints ?? EMPTY_CHECKPOINTS,
    turnGitArtifacts: detail?.turnGitArtifacts ?? EMPTY_GIT_ARTIFACTS,
    usage,
    streamingText,
    streamingReasoning,
    streamingChannel,
    pendingApprovals: approvals,
    pendingInputs: inputRequests,
  };
}
