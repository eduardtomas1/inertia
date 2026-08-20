import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  AgentGoalSource,
  AgentGoalStatus,
  AgentWorkflowState,
  Conversation,
  Project,
  ServerEvent,
} from "@shared/contracts";
import { resultEvent, type CommandWithoutId } from "../lib/runtimeCommands";
import type { ConnectionStatus } from "./useInertiaConnection";

export interface AgentWorkflowProjection {
  state: AgentWorkflowState | null;
  loading: boolean;
  mutating: boolean;
  error: string | null;
  refresh: (providerRefresh?: boolean) => Promise<void>;
  setGoal: (input: {
    source: AgentGoalSource;
    objective?: string;
    status: AgentGoalStatus;
    tokenBudget?: number | null;
  }) => Promise<void>;
  clearGoal: (source: AgentGoalSource) => Promise<void>;
  listSkills: (forceReload?: boolean) => Promise<void>;
}

export interface UseAgentWorkflowsOptions {
  conversationId: string | null;
  /** Changes when the provider thread or execution route changes in place. */
  routeIdentity: string | null;
  status: ConnectionStatus;
  enabled?: boolean;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
}

function publicMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Agent workflows could not be loaded.";
}

function isRecoverySafetyError(error: unknown): boolean {
  return publicMessage(error).includes("recovery safety mode");
}

export function agentWorkflowRouteIdentity(
  conversation: Conversation | null,
  project: Project | null,
): string | null {
  if (!conversation || !project) return null;
  return [
    conversation.modelSelection.harnessId,
    conversation.modelSelection.backendProfileId,
    conversation.modelSelection.backendConfigurationRevision,
    conversation.providerSessionId ?? "new-thread",
    conversation.worktreePath ?? project.path,
  ].join("\0");
}

export function agentWorkflowTargetConversation(
  persistedConversation: Conversation | null,
  visibleDraft: Conversation | null,
): Conversation | null {
  return visibleDraft ? null : persistedConversation;
}

export function useAgentWorkflows({
  conversationId,
  routeIdentity,
  status,
  enabled = true,
  request,
  subscribe,
}: UseAgentWorkflowsOptions): AgentWorkflowProjection {
  const [state, setState] = useState<AgentWorkflowState | null>(null);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const activeConversationId = enabled ? conversationId : null;
  const activeConversationIdRef = useRef(activeConversationId);
  const statusRef = useRef(status);
  const lifecycleRef = useRef<{
    identity: string | null | undefined;
    status: ConnectionStatus | undefined;
  }>({ identity: undefined, status: undefined });
  const mutationInFlightRef = useRef(false);
  activeConversationIdRef.current = activeConversationId;
  statusRef.current = status;

  const load = useCallback(async (providerRefresh = false): Promise<void> => {
    const targetId = activeConversationIdRef.current;
    if (!targetId || statusRef.current !== "online") return;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setLoading(true);
    setError(null);
    try {
      let response: ServerEvent;
      let savedOnlyWarning: string | null = null;
      try {
        response = await request({
          type: "agent.workflow.load",
          payload: {
            conversationId: targetId,
            refresh: providerRefresh,
          },
        });
      } catch (loadError) {
        if (!isRecoverySafetyError(loadError)) throw loadError;
        savedOnlyWarning = publicMessage(loadError);
        response = await request({
          type: "agent.workflow.saved.load",
          payload: { conversationId: targetId },
        });
      }
      const event = resultEvent(response);
      if (event.result.kind !== "agent.workflow") {
        throw new Error(
          "The local service returned an unexpected workflow response.",
        );
      }
      if (
        generation !== generationRef.current
        || event.result.workflow.conversationId !== targetId
      ) return;
      setState(event.result.workflow);
      if (savedOnlyWarning) setError(savedOnlyWarning);
    } catch (loadError) {
      if (generation !== generationRef.current) return;
      setError(publicMessage(loadError));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    const identity = activeConversationId
      ? `${activeConversationId}\0${routeIdentity ?? ""}`
      : null;
    const identityChanged = lifecycleRef.current.identity !== identity;
    const statusChanged = lifecycleRef.current.status !== status;
    lifecycleRef.current = { identity, status };
    if (!identityChanged && !statusChanged) return;
    generationRef.current += 1;
    setLoading(false);
    if (identityChanged) {
      setState(null);
      setError(null);
    }
    if (activeConversationId && status === "online") {
      void load(true);
    }
  }, [activeConversationId, load, routeIdentity, status]);

  useEffect(() => subscribe((event) => {
    if (event.type === "server.welcome") {
      generationRef.current += 1;
      if (
        activeConversationIdRef.current
        && statusRef.current === "online"
      ) {
        void load(true);
      }
      return;
    }
    if (event.type === "agent.goal.updated") {
      if (event.goal.conversationId !== activeConversationId) return;
      setState((current) => current ? {
        ...current,
        goals: [
          ...current.goals.filter(({ source }) =>
            source !== event.goal.source),
          event.goal,
        ],
        goalRefreshWarning: event.goal.source === "codex-native"
          ? null
          : current.goalRefreshWarning,
        refreshedAt: event.goal.updatedAt,
      } : current);
      return;
    }
    if (
      event.type === "agent.goal.cleared"
      && event.conversationId === activeConversationId
    ) {
      setState((current) => current ? {
        ...current,
        goals: current.goals.filter(({ source }) =>
          source !== event.source),
        goalRefreshWarning: event.source === "codex-native"
          ? null
          : current.goalRefreshWarning,
      } : current);
    }
  }), [activeConversationId, load, subscribe]);

  const runGoalMutation = useCallback(async (
    operation: () => Promise<void>,
  ): Promise<void> => {
    if (mutationInFlightRef.current) {
      throw new Error("Another goal change is already in progress.");
    }
    mutationInFlightRef.current = true;
    setMutating(true);
    try {
      await operation();
    } finally {
      mutationInFlightRef.current = false;
      setMutating(false);
    }
  }, []);

  const setGoal = useCallback(async (input: {
    source: AgentGoalSource;
    objective?: string;
    status: AgentGoalStatus;
    tokenBudget?: number | null;
  }): Promise<void> => {
    if (!activeConversationId) return;
    await runGoalMutation(async () => {
      await request({
        type: "agent.goal.set",
        payload: {
          conversationId: activeConversationId,
          ...input,
        },
      });
    });
  }, [activeConversationId, request, runGoalMutation]);

  const clearGoal = useCallback(async (
    source: AgentGoalSource,
  ): Promise<void> => {
    if (!activeConversationId) return;
    await runGoalMutation(async () => {
      await request({
        type: "agent.goal.clear",
        payload: { conversationId: activeConversationId, source },
      });
    });
  }, [activeConversationId, request, runGoalMutation]);

  const listSkills = useCallback(async (
    forceReload = false,
  ): Promise<void> => {
    const targetId = activeConversationId;
    if (!targetId) return;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setLoading(true);
    setError(null);
    try {
      const event = resultEvent(await request({
        type: "agent.skills.list",
        payload: {
          conversationId: targetId,
          forceReload,
        },
      }));
      if (
        event.result.kind !== "agent.skills"
        || event.result.conversationId !== targetId
      ) {
        throw new Error(
          "The local service returned an unexpected skills response.",
        );
      }
      if (generation !== generationRef.current) return;
      const listedSkills = event.result.skills;
      const skillDiscovery = event.result.skillDiscovery;
      setState((current) => current ? {
        ...current,
        skills: listedSkills,
        skillDiscovery,
        refreshedAt: new Date().toISOString(),
      } : current);
    } catch (listError) {
      if (generation !== generationRef.current) return;
      setError(publicMessage(listError));
      throw listError;
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [activeConversationId, request]);

  return useMemo(() => ({
    state: activeConversationId ? state : null,
    loading: activeConversationId ? loading : false,
    mutating: activeConversationId ? mutating : false,
    error: activeConversationId ? error : null,
    refresh: load,
    setGoal,
    clearGoal,
    listSkills,
  }), [
    activeConversationId,
    clearGoal,
    error,
    listSkills,
    load,
    loading,
    mutating,
    setGoal,
    state,
  ]);
}
