import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Conversation,
  Project,
  ServerEvent,
  TurnGitDiffSnapshot,
} from "@shared/contracts";
import type { WorkspacePanelTab } from "../../components/WorkspacePanel";
import {
  resultEvent,
  type CommandWithoutId,
} from "../../lib/runtimeCommands";

interface TurnArtifactsOptions {
  project: Project | null;
  conversation: Conversation | null;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  setActionError: (message: string | null) => void;
  setActiveTool: (tool: WorkspacePanelTab | null) => void;
  openProjectPath: (
    request: Parameters<typeof window.inertia.openProjectPath>[0],
  ) => void;
  loadGit: () => Promise<void>;
}

export function useTurnArtifacts({
  project,
  conversation,
  request,
  setActionError,
  setActiveTool,
  openProjectPath,
  loadGit,
}: TurnArtifactsOptions) {
  const [historicalDiff, setHistoricalDiff] =
    useState<TurnGitDiffSnapshot | null>(null);
  const [historicalSelectedPath, setHistoricalSelectedPath] =
    useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const authority = `${project?.id ?? ""}:${conversation?.id ?? ""}`;
  const authorityRef = useRef(authority);
  const requestGenerationRef = useRef(0);
  authorityRef.current = authority;

  useEffect(() => {
    requestGenerationRef.current += 1;
    setHistoricalDiff(null);
    setHistoricalSelectedPath(null);
    setLoading(false);
  }, [conversation?.id, project?.id]);

  const openTurnDiff = useCallback(async (
    turnId: string,
    path?: string,
  ) => {
    if (!project || !conversation) return;
    const owner = `${project.id}:${conversation.id}`;
    const generation = ++requestGenerationRef.current;
    const ownsResponse = (): boolean => (
      authorityRef.current === owner
      && requestGenerationRef.current === generation
    );
    setLoading(true);
    try {
      const event = resultEvent(await request({
        type: "git.turn.diff",
        payload: {
          projectId: project.id,
          conversationId: conversation.id,
          turnId,
          ...(path ? { path } : {}),
        },
      }));
      if (event.result.kind !== "git.turn.diff") {
        throw new Error(
          "The local service returned an unexpected historical diff.",
        );
      }
      if (!ownsResponse()) return;
      setHistoricalDiff(event.result.diff);
      setHistoricalSelectedPath(
        path && event.result.diff.files.some((file) => file.path === path)
          ? path
          : event.result.diff.files[0]?.path ?? null,
      );
      setActiveTool("changes");
    } catch (error) {
      if (ownsResponse()) setActionError(
        error instanceof Error
          ? error.message
          : "The historical diff could not be opened.",
      );
    } finally {
      if (ownsResponse()) setLoading(false);
    }
  }, [conversation, project, request, setActionError, setActiveTool]);

  const compareTurnArtifacts = useCallback(async (
    earlierTurnId: string,
    laterTurnId: string,
  ) => {
    if (!project || !conversation) return;
    const owner = `${project.id}:${conversation.id}`;
    const generation = ++requestGenerationRef.current;
    const ownsResponse = (): boolean => (
      authorityRef.current === owner
      && requestGenerationRef.current === generation
    );
    setLoading(true);
    try {
      const event = resultEvent(await request({
        type: "git.turn.compare",
        payload: {
          projectId: project.id,
          conversationId: conversation.id,
          earlierTurnId,
          laterTurnId,
        },
      }));
      if (event.result.kind !== "git.turn.diff") {
        throw new Error(
          "The local service returned an unexpected turn comparison.",
        );
      }
      if (!ownsResponse()) return;
      setHistoricalDiff(event.result.diff);
      setHistoricalSelectedPath(event.result.diff.files[0]?.path ?? null);
      setActiveTool("changes");
    } catch (error) {
      if (ownsResponse()) setActionError(
        error instanceof Error
          ? error.message
          : "The turn comparison could not be opened.",
      );
    } finally {
      if (ownsResponse()) setLoading(false);
    }
  }, [conversation, project, request, setActionError, setActiveTool]);

  const openTurnFile = useCallback((path: string) => {
    if (!project || !conversation) return;
    openProjectPath({
      projectId: project.id,
      conversationId: conversation.id,
      relativePath: path,
      action: "open-externally",
    });
  }, [conversation, openProjectPath, project]);

  const showCurrentChanges = useCallback(() => {
    setHistoricalDiff(null);
    setHistoricalSelectedPath(null);
    void loadGit().catch((error) => {
      setActionError(
        error instanceof Error
          ? error.message
          : "Changes could not be refreshed.",
      );
    });
  }, [loadGit, setActionError]);

  return {
    historicalDiff,
    historicalSelectedPath,
    setHistoricalSelectedPath,
    loading,
    openTurnDiff,
    compareTurnArtifacts,
    openTurnFile,
    showCurrentChanges,
  };
}
