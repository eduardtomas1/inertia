import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  Project,
  ProjectAction,
  ServerEvent,
  WorkspaceRun,
} from "@shared/contracts";
import type { WorkspacePanelTab } from "../components/WorkspacePanel";
import type { CommandWithoutId } from "../lib/runtimeCommands";

interface ActivityActionsOptions {
  project: Project | null;
  conversationId: string | null;
  run: (key: string, command: CommandWithoutId) => Promise<ServerEvent>;
  setActiveTool: (tool: WorkspacePanelTab | null) => void;
  setActionError: (message: string | null) => void;
}

interface PendingProjectAction {
  actionId: string;
  projectId: string;
  conversationId: string | null;
}

/*
 * A resume chosen in the composer is scoped to the project it was chosen from,
 * so switching projects before the terminal session is ready drops the request
 * instead of resuming into an unrelated workspace.
 */
interface PendingResumeRequest {
  resumeConversationId: string;
  projectId: string;
}

export function useActivityActions({
  project,
  conversationId,
  run,
  setActiveTool,
  setActionError,
}: ActivityActionsOptions) {
  const [pendingAction, setPendingAction] =
    useState<PendingProjectAction | null>(null);
  const [pendingResume, setPendingResume] =
    useState<PendingResumeRequest | null>(null);
  useEffect(() => {
    setPendingAction((current) => (
      current
      && current.projectId === project?.id
      && current.conversationId === conversationId
        ? current
        : null
    ));
  }, [conversationId, project?.id]);

  useEffect(() => {
    setPendingResume((current) =>
      current && current.projectId !== project?.id ? null : current);
  }, [project?.id]);

  const runProjectAction = useCallback((action: ProjectAction) => {
    if (!project) return;
    setPendingAction({
      actionId: action.id,
      projectId: project.id,
      conversationId,
    });
    setActiveTool("terminal");
  }, [conversationId, project, setActiveTool]);

  const stopWorkspaceRun = useCallback((activity: Pick<WorkspaceRun, "id" | "label">) => {
    void run(`activity.stop:${activity.id}`, {
      type: "activity.stop",
      payload: { runId: activity.id },
    }).catch((error) => {
      const detail = error instanceof Error
        ? error.message
        : "The work could not be stopped.";
      setActionError(`Could not stop ${activity.label}: ${detail}`);
    });
  }, [run, setActionError]);

  const acknowledgeActivity = useCallback((activity: WorkspaceRun) => {
    void run(`activity.acknowledge:${activity.id}`, {
      type: "activity.acknowledge",
      payload: { runId: activity.id },
    }).catch((error) => {
      const detail = error instanceof Error
        ? error.message
        : "The run could not be acknowledged.";
      setActionError(`Could not acknowledge ${activity.label}: ${detail}`);
    });
  }, [run, setActionError]);

  const dismissActivity = useCallback((activity: WorkspaceRun) => {
    void run(`activity.dismiss:${activity.id}`, {
      type: "activity.dismiss",
      payload: { runId: activity.id },
    }).catch((error) => {
      const detail = error instanceof Error
        ? error.message
        : "The run could not be dismissed.";
      setActionError(`Could not dismiss ${activity.label}: ${detail}`);
    });
  }, [run, setActionError]);

  const pendingActionId = pendingAction
    && pendingAction.projectId === project?.id
    && pendingAction.conversationId === conversationId
    ? pendingAction.actionId
    : null;
  const pendingResumeConversationId = pendingResume
    && pendingResume.projectId === project?.id
    ? pendingResume.resumeConversationId
    : null;

  return useMemo(() => ({
    pendingActionId,
    clearPendingAction: () => setPendingAction(null),
    pendingResumeConversationId,
    requestProviderResume: (resumeConversationId: string) => {
      if (!project) return;
      setPendingResume({ resumeConversationId, projectId: project.id });
    },
    clearPendingResume: () => setPendingResume(null),
    runProjectAction,
    stopWorkspaceRun,
    acknowledgeActivity,
    dismissActivity,
  }), [
    acknowledgeActivity,
    dismissActivity,
    pendingActionId,
    pendingResumeConversationId,
    project,
    runProjectAction,
    stopWorkspaceRun,
  ]);
}
