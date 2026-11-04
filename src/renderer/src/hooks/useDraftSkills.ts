import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  AgentSkillSummary,
  AgentWorkflowSkillsCapability,
  Conversation,
  ServerEvent,
} from "@shared/contracts";
import { agentSkillsCapability } from "../../../shared/agent-skills-capability";
import { resultEvent, type CommandWithoutId } from "../lib/runtimeCommands";
import type { ConnectionStatus } from "./useInertiaConnection";

export interface DraftSkillsProjection {
  skills: readonly AgentSkillSummary[];
  capability: AgentWorkflowSkillsCapability | null;
  loading: boolean;
  error: string | null;
  list: (forceReload?: boolean) => Promise<void>;
}

const NO_SKILLS: readonly AgentSkillSummary[] = [];

function draftRouteIdentity(draft: Conversation | null): string | null {
  return draft
    ? `${draft.id}\0${draft.projectId}\0${draft.providerId}\0${draft.modelSelection.harnessId}`
    : null;
}

export function useDraftSkills({
  draft,
  status,
  request,
}: {
  draft: Conversation | null;
  status: ConnectionStatus | undefined;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
}): DraftSkillsProjection {
  const identity = draftRouteIdentity(draft);
  const [skills, setSkills] = useState<readonly AgentSkillSummary[]>(NO_SKILLS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const capability = useMemo(
    () => draft
      ? agentSkillsCapability(draft.providerId, draft.modelSelection.harnessId)
      : null,
    [draft],
  );
  useEffect(() => {
    generationRef.current += 1;
    setSkills(NO_SKILLS);
    setLoading(false);
    setError(null);
  }, [identity, status]);
  const list = useCallback(async (forceReload = false): Promise<void> => {
    if (!draft || !capability?.available) return;
    const harnessId = draft.modelSelection.harnessId;
    if (harnessId !== "codex-app-server" && harnessId !== "claude-agent-sdk") return;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setLoading(true);
    setError(null);
    try {
      const event = resultEvent(await request({
        type: "agent.skills.preview",
        payload: {
          draftConversationId: draft.id,
          projectId: draft.projectId,
          harnessId,
          forceReload,
        },
      }));
      if (event.result.kind !== "agent.skills" || event.result.conversationId !== draft.id) {
        throw new Error("The local service returned an unexpected skills response.");
      }
      if (generation === generationRef.current) setSkills(event.result.skills);
    } catch (listError) {
      if (generation !== generationRef.current) return;
      setError(listError instanceof Error ? listError.message : "Skills could not be loaded.");
      throw listError;
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [capability, draft, request]);
  return useMemo(
    () => ({ skills, capability, loading, error, list }),
    [capability, error, list, loading, skills],
  );
}
