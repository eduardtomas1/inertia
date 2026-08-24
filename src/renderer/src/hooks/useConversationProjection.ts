import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AgentActivity,
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlan,
  AgentReasoning,
  AgentTurn,
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
import {
  appendStreamingReasoning,
  appendStreamingText,
  applyTerminalTurnProjections,
  closeStreamingChannelState,
  closeTextStreamState,
  compareCreatedRecords,
  compareSubagentTraces,
  EMPTY_STREAMING_AGENT_STATE,
  interactionKey,
  mergeProjectionPlans,
  mergeProjectionRecords,
  projectConversationTerminal,
  projectionUsage,
  reconcileTerminalTurnProjections,
  recordsForConversation,
  sameAgentPlan,
  terminalEventMatchesCurrentTurn,
  turnEventOwner,
  withoutHydratedBaseline,
  withTerminalTurnProjection,
  type StreamingAgentState,
  type TerminalTurnProjections,
} from "../utils/terminalTurnProjection";

const EMPTY_REASONINGS: AgentReasoning[] = [];
const EMPTY_TURNS: AgentTurn[] = [];
const EMPTY_CHECKPOINTS: CheckpointSummary[] = [];
const EMPTY_GIT_ARTIFACTS: TurnGitArtifact[] = [];
const MAX_STREAMING_CHARACTERS = 500_000;

function replaceAssistantMessagesForTurn(
  messages: readonly ChatMessage[],
  turnId: string,
  replacement: ChatMessage | null,
): ChatMessage[] {
  const retained = messages.filter((message) =>
    message.turnId !== turnId || message.role !== "assistant");
  if (replacement) retained.push(replacement);
  return retained.sort(compareCreatedRecords);
}

interface FreshHydrationBaseline {
  conversationId: string;
  syncCompleted: boolean;
  text: string | null;
  reasoning: string | null;
  channel: StreamingAgentChannel;
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
  const [[streamingText, streamingReasoning, streamingChannel], setStreaming] =
    useState<StreamingAgentState>(EMPTY_STREAMING_AGENT_STATE);
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
  const [terminalProjections, setTerminalProjections] =
    useState<TerminalTurnProjections>({});
  const requestGenerationRef = useRef(0);
  const terminalRefreshPendingRef = useRef(false);
  const liveTurnOwnerRef = useRef<string | null>(null);
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
  const resetLiveProjection = useCallback((): void => {
    freshHydrationRef.current = null;
    terminalRefreshPendingRef.current = false;
    liveTurnOwnerRef.current = null;
    setStreaming(EMPTY_STREAMING_AGENT_STATE);
    setLiveMessages({});
    setLiveUsage({});
    setLiveActivities({});
    setLiveSubagents({});
    setNativePlans({});
    setTerminalProjections({});
  }, []);
  const closeTextStream = useCallback((): void => {
    const hydration = freshHydrationRef.current;
    if (hydration) {
      hydration.text = "";
      hydration.channel = null;
    }
    setStreaming(closeTextStreamState);
  }, []);

  const conversationId = enabled
    ? targetConversationId === undefined
      ? snapshot?.activeConversationId ?? null
      : targetConversationId
    : null;
  const subscriptionOwner = targetConversationId === undefined
    ? "primary"
    : "secondary";
  const persistedConversation = useMemo(
    () => snapshot?.conversations.find(({ id }) =>
      id === conversationId) ?? null,
    [conversationId, snapshot],
  );
  const conversation = useMemo(() => projectConversationTerminal(
    persistedConversation,
    terminalProjections,
  ), [persistedConversation, terminalProjections]);
  conversationRef.current = conversation;
  useEffect(() => {
    if (enabled) return;
    resetLiveProjection();
  }, [enabled, resetLiveProjection]);
  useEffect(() => {
    if (status !== "online") {
      liveTurnOwnerRef.current = null;
      setStreaming(closeStreamingChannelState);
    }
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
        setStreaming([
          hydration.text ?? "",
          hydration.reasoning ?? "",
          hydration.channel,
        ]);
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
        setStreaming(EMPTY_STREAMING_AGENT_STATE);
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
    if (detailState?.state === "ready") {
      setTerminalProjections((current) =>
        reconcileTerminalTurnProjections(
          current,
          detailState.detail.agentTurns,
        ));
    }
  }, [conversation?.id, detail, detailState]);

  useEffect(() => subscribe((event) => {
    const activeConversation = conversationRef.current;
    const projectionEnabled = enabledRef.current;
    if (event.type === "server.welcome") {
      requestGenerationRef.current += 1;
      terminalRefreshPendingRef.current = false;
      liveTurnOwnerRef.current = null;
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
        setStreaming(closeStreamingChannelState);
        freshHydrationRef.current = {
          conversationId: activeConversation.id,
          syncCompleted: false,
          text: null,
          reasoning: null,
          channel: null,
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
        resetLiveProjection();
        setDetailState(null);
        setPendingApprovals([]);
        setPendingInputs([]);
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
        liveTurnOwnerRef.current = turnEventOwner(event.request);
        closeTextStream();
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
        liveTurnOwnerRef.current = turnEventOwner(event.request);
        closeTextStream();
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
      closeTextStream();
      return;
    }
    if (event.type === "agent.plan.updated") {
      if (event.plan.conversationId !== activeConversation?.id) return;
      if (event.plan.turnId) liveTurnOwnerRef.current = turnEventOwner({
        runId: event.plan.runId,
        turnId: event.plan.turnId,
      });
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
          if (hydration) hydration.channel = null;
          setStreaming(closeStreamingChannelState);
          return;
        }
        closeTextStream();
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
      if (event.activity.turnId) liveTurnOwnerRef.current = turnEventOwner({
        runId: event.activity.runId,
        turnId: event.activity.turnId,
      });
      closeTextStream();
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
      liveTurnOwnerRef.current = turnEventOwner(event);
      if (freshHydrationRef.current) {
        freshHydrationRef.current.text = "";
        freshHydrationRef.current.reasoning = "";
        freshHydrationRef.current.channel = null;
      }
      setStreaming(EMPTY_STREAMING_AGENT_STATE);
    }
    if (event.type === "agent.text") {
      liveTurnOwnerRef.current = turnEventOwner(event);
      const hydration = freshHydrationRef.current;
      if (hydration) {
        hydration.text = `${
          hydration.text ?? ""
        }${event.text}`.slice(-MAX_STREAMING_CHARACTERS);
      }
      setStreaming((current) => appendStreamingText(
        current,
        event.text,
        MAX_STREAMING_CHARACTERS,
      ));
      if (hydration) hydration.channel = "text";
      markTestStreamingStage("renderer-projection-updated");
    }
    if (event.type === "agent.text.replaced") {
      const eventOwner = turnEventOwner(event);
      if (terminalEventMatchesCurrentTurn({
        conversation: activeConversation,
        detailState: detailStateRef.current,
        eventOwner,
        liveOwner: liveTurnOwnerRef.current,
      })) {
        liveTurnOwnerRef.current = eventOwner;
        const hydration = freshHydrationRef.current;
        if (hydration) {
          hydration.text = "";
          hydration.channel = null;
        }
        setStreaming(closeTextStreamState);
      }
      setDetailState((current) => {
        if (
          current?.state !== "ready"
          || current.conversationId !== event.conversationId
        ) return current;
        return {
          ...current,
          detail: {
            ...current.detail,
            messages: replaceAssistantMessagesForTurn(
              current.detail.messages,
              event.turnId,
              event.message,
            ),
          },
        };
      });
      setLiveMessages((current) => {
        const existing = current[event.conversationId] ?? [];
        const replacement = replaceAssistantMessagesForTurn(
          existing,
          event.turnId,
          event.message,
        );
        if (replacement.length === 0) {
          if (!(event.conversationId in current)) return current;
          const next = { ...current };
          delete next[event.conversationId];
          return next;
        }
        return {
          ...current,
          [event.conversationId]: replacement,
        };
      });
    }
    if (event.type === "agent.reasoning") {
      liveTurnOwnerRef.current = turnEventOwner(event);
      const hydration = freshHydrationRef.current;
      if (hydration) {
        hydration.reasoning = `${
          hydration.reasoning ?? ""
        }${event.text}`.slice(-MAX_STREAMING_CHARACTERS);
      }
      setStreaming((current) => appendStreamingReasoning(
        current,
        event.text,
        MAX_STREAMING_CHARACTERS,
      ));
      if (hydration) hydration.channel = "reasoning";
    }
    if (event.type === "agent.completed" || event.type === "agent.failed") {
      const embeddedTerminalAssistantMessage = event.terminalAssistantMessage;
      const terminalAssistantMessage = embeddedTerminalAssistantMessage
        && embeddedTerminalAssistantMessage.role === "assistant"
        && embeddedTerminalAssistantMessage.conversationId === event.conversationId
        && embeddedTerminalAssistantMessage.turnId === event.turnId
        && embeddedTerminalAssistantMessage.id === event.terminalAssistantMessageId
        ? embeddedTerminalAssistantMessage
        : null;
      if (terminalAssistantMessage) {
        setLiveMessages((current) => {
          const existing = current[terminalAssistantMessage.conversationId] ?? [];
          return {
            ...current,
            [terminalAssistantMessage.conversationId]: [
              ...existing.filter(({ id }) => id !== terminalAssistantMessage.id),
              terminalAssistantMessage,
            ],
          };
        });
      }
      const liveTurnOwner = liveTurnOwnerRef.current;
      const eventOwner = turnEventOwner(event);
      if (!terminalEventMatchesCurrentTurn({
        conversation: activeConversation,
        detailState: detailStateRef.current,
        eventOwner,
        liveOwner: liveTurnOwner,
      })) return;
      liveTurnOwnerRef.current = null;
      if (freshHydrationRef.current) {
        freshHydrationRef.current.channel = null;
      }
      setStreaming(closeStreamingChannelState);
      const retainOtherTurn = (request: {
        conversationId: string;
        runId: string;
        turnId: string;
      }): boolean => request.conversationId !== event.conversationId
        || turnEventOwner(request) !== eventOwner;
      setPendingApprovals((current) => current.filter(retainOtherTurn));
      setPendingInputs((current) => current.filter(retainOtherTurn));
      setTerminalProjections((current) => withTerminalTurnProjection(
        current,
        {
          owner: eventOwner,
          status: event.status,
          terminalReason: event.terminalReason,
          terminalAssistantMessageId:
            terminalAssistantMessage?.id ?? event.terminalAssistantMessageId,
        },
      ));
      terminalRefreshPendingRef.current = true;
      terminalCallbackRef.current();
    }
  }), [
    closeTextStream,
    resetLiveProjection,
    subscribe,
    subscriptionOwner,
  ]);

  useEffect(() => {
    resetLiveProjection();
  }, [conversation?.id, resetLiveProjection]);

  const activeConversationId = conversation?.id ?? null;
  const turns = useMemo(() => applyTerminalTurnProjections(
    detail?.agentTurns ?? EMPTY_TURNS,
    terminalProjections,
    conversation?.latestTurn ?? null,
  ), [conversation?.latestTurn, detail?.agentTurns, terminalProjections]);
  const messages = useMemo(
    () => mergeProjectionRecords(
      detail?.messages ?? [],
      activeConversationId ? liveMessages[activeConversationId] ?? [] : [],
      compareCreatedRecords,
    ),
    [activeConversationId, detail?.messages, liveMessages],
  );
  const activities = useMemo(() => mergeProjectionRecords(
    detail?.activities ?? [],
    activeConversationId ? liveActivities[activeConversationId] ?? [] : [],
    compareCreatedRecords,
  ), [activeConversationId, detail?.activities, liveActivities]);
  const subagents = useMemo(() => mergeProjectionRecords(
    detail?.subagents ?? [],
    activeConversationId ? liveSubagents[activeConversationId] ?? [] : [],
    compareSubagentTraces,
  ), [activeConversationId, detail?.subagents, liveSubagents]);
  const usage = useMemo(() => projectionUsage(
    activeConversationId,
    liveUsage,
    detail?.usage ?? [],
  ), [activeConversationId, detail?.usage, liveUsage]);
  const plans = useMemo(() => activeConversationId
    ? mergeProjectionPlans(
        detail?.plans ?? [],
        nativePlans[activeConversationId],
      )
    : [], [activeConversationId, detail?.plans, nativePlans]);
  const approvals = useMemo(
    () => recordsForConversation(pendingApprovals, conversation?.id),
    [conversation?.id, pendingApprovals],
  );
  const inputRequests = useMemo(
    () => recordsForConversation(pendingInputs, conversation?.id),
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
    terminalProjections,
    pendingApprovals: approvals,
    pendingInputs: inputRequests,
  };
}
