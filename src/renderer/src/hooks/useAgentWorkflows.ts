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
  AgentSkillSummary,
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
  error: string | null;
  selectedSkillIds: readonly string[];
  refresh: (providerRefresh?: boolean) => Promise<void>;
  setGoal: (input: {
    source: AgentGoalSource;
    objective?: string;
    status: AgentGoalStatus;
    tokenBudget?: number | null;
  }) => Promise<void>;
  clearGoal: (source: AgentGoalSource) => Promise<void>;
  listSkills: (forceReload?: boolean) => Promise<void>;
  toggleSkill: (skill: AgentSkillSummary) => void;
  clearSelectedSkills: () => void;
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
  const [error, setError] = useState<string | null>(null);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const generationRef = useRef(0);
  const activeConversationId = enabled ? conversationId : null;

  const load = useCallback(async (providerRefresh = false): Promise<void> => {
    const targetId = activeConversationId;
    if (!targetId || status !== "online") return;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setLoading(true);
    setError(null);
    try {
      const event = resultEvent(await request({
        type: "agent.workflow.load",
        payload: {
          conversationId: targetId,
          refresh: providerRefresh,
        },
      }));
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
      const available = new Set(
        event.result.workflow.skills.map(({ id }) => id),
      );
      setSelectedSkillIds((current) =>
        current.filter((id) => available.has(id)));
    } catch (loadError) {
      if (generation !== generationRef.current) return;
      setError(publicMessage(loadError));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [activeConversationId, request, status]);

  useEffect(() => {
    generationRef.current += 1;
    setState(null);
    setError(null);
    setSelectedSkillIds([]);
    if (activeConversationId && status === "online") {
      void load(true);
    }
  }, [activeConversationId, load, routeIdentity, status]);

  useEffect(() => subscribe((event) => {
    if (event.type === "server.welcome") {
      generationRef.current += 1;
      setState(null);
      setSelectedSkillIds([]);
      if (activeConversationId && status === "online") {
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
      } : current);
    }
  }), [activeConversationId, load, status, subscribe]);

  const setGoal = useCallback(async (input: {
    source: AgentGoalSource;
    objective?: string;
    status: AgentGoalStatus;
    tokenBudget?: number | null;
  }): Promise<void> => {
    if (!activeConversationId) return;
    await request({
      type: "agent.goal.set",
      payload: {
        conversationId: activeConversationId,
        ...input,
      },
    });
  }, [activeConversationId, request]);

  const clearGoal = useCallback(async (
    source: AgentGoalSource,
  ): Promise<void> => {
    if (!activeConversationId) return;
    await request({
      type: "agent.goal.clear",
      payload: { conversationId: activeConversationId, source },
    });
  }, [activeConversationId, request]);

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
      const available = new Set(listedSkills.map(({ id }) => id));
      setSelectedSkillIds((current) =>
        current.filter((id) => available.has(id)));
    } catch (listError) {
      if (generation !== generationRef.current) return;
      setError(publicMessage(listError));
      throw listError;
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [activeConversationId, request]);

  const toggleSkill = useCallback((skill: AgentSkillSummary): void => {
    if (
      skill.conversationId !== activeConversationId
      || !skill.enabled
    ) return;
    setSelectedSkillIds((current) => current.includes(skill.id)
      ? current.filter((id) => id !== skill.id)
      : current.length < 8
        ? [...current, skill.id]
        : current);
  }, [activeConversationId]);

  const clearSelectedSkills = useCallback(
    () => setSelectedSkillIds([]),
    [],
  );

  return useMemo(() => ({
    state,
    loading,
    error,
    selectedSkillIds,
    refresh: load,
    setGoal,
    clearGoal,
    listSkills,
    toggleSkill,
    clearSelectedSkills,
  }), [
    clearGoal,
    clearSelectedSkills,
    error,
    listSkills,
    load,
    loading,
    selectedSkillIds,
    setGoal,
    state,
    toggleSkill,
  ]);
}
