import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AppSnapshot,
  Project,
  ProjectAction,
  ServerEvent,
  WorkspaceRun,
} from "@shared/contracts";
import type { WorkspacePanelTab } from "../components/WorkspacePanel";
import type { CommandWithoutId } from "../lib/runtimeCommands";

interface ActivityActionsOptions {
  snapshot: AppSnapshot | null;
  project: Project | null;
  conversationId: string | null;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  run: (key: string, command: CommandWithoutId) => Promise<ServerEvent>;
  setActiveTool: (tool: WorkspacePanelTab | null) => void;
  setActivityOpen: (open: boolean) => void;
  setActionError: (message: string | null) => void;
  activateContext: (
    activity: WorkspaceRun,
    tool?: WorkspacePanelTab,
  ) => void;
  openProjectPath: (
    request: Parameters<typeof window.inertia.openProjectPath>[0],
  ) => void;
  navigatePreview: (url: string) => void;
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
  snapshot,
  project,
  conversationId,
  request,
  run,
  setActiveTool,
  setActivityOpen,
  setActionError,
  activateContext,
  openProjectPath,
  navigatePreview,
}: ActivityActionsOptions) {
  const [pendingAction, setPendingAction] =
    useState<PendingProjectAction | null>(null);
  const [pendingResume, setPendingResume] =
    useState<PendingResumeRequest | null>(null);
  const [pendingActivityAction, setPendingActivityAction] =
    useState<WorkspaceRun | null>(null);
  const [pendingPreviewActivity, setPendingPreviewActivity] =
    useState<WorkspaceRun | null>(null);

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

  useEffect(() => {
    if (
      !pendingActivityAction?.actionId
      || project?.id !== pendingActivityAction.projectId
    ) return;
    if (
      pendingActivityAction.conversationId
      && conversationId !== pendingActivityAction.conversationId
    ) return;
    setPendingAction({
      actionId: pendingActivityAction.actionId,
      projectId: pendingActivityAction.projectId,
      conversationId: pendingActivityAction.conversationId,
    });
    setPendingActivityAction(null);
  }, [conversationId, pendingActivityAction, project?.id]);

  useEffect(() => {
    if (
      !pendingPreviewActivity?.port
      || project?.id !== pendingPreviewActivity.projectId
    ) return;
    if (
      pendingPreviewActivity.conversationId
      && conversationId !== pendingPreviewActivity.conversationId
    ) return;
    navigatePreview(`http://127.0.0.1:${pendingPreviewActivity.port}`);
    setPendingPreviewActivity(null);
  }, [
    conversationId,
    navigatePreview,
    pendingPreviewActivity,
    project?.id,
  ]);

  const runProjectAction = useCallback((action: ProjectAction) => {
    if (!project) return;
    setPendingAction({
      actionId: action.id,
      projectId: project.id,
      conversationId,
    });
    setActiveTool("terminal");
  }, [conversationId, project, setActiveTool]);

  const openActivityLocation = useCallback((activity: WorkspaceRun) => {
    const targetProject = snapshot?.projects.find(
      ({ id }) => id === activity.projectId,
    );
    const targetConversation = snapshot?.conversations.find(
      ({ id }) => id === activity.conversationId,
    );
    if (!targetProject) return;
    openProjectPath({
      projectId: targetProject.id,
      ...(targetConversation
        ? { conversationId: targetConversation.id }
        : {}),
      relativePath: ".",
      action: "open-externally",
    });
  }, [openProjectPath, snapshot?.conversations, snapshot?.projects]);

  const openActivityPreview = useCallback((activity: WorkspaceRun) => {
    if (!activity.port) return;
    setPendingPreviewActivity(activity);
    activateContext(activity, "preview");
    setActivityOpen(false);
  }, [activateContext, setActivityOpen]);

  const stopActivity = useCallback((activity: WorkspaceRun) => {
    void run(`activity.stop:${activity.id}`, {
      type: "activity.stop",
      payload: { runId: activity.id },
    }).catch((error) => {
      const detail = error instanceof Error
        ? error.message
        : "The run could not be stopped.";
      setActionError(`Could not stop ${activity.label}: ${detail}`);
    });
  }, [run, setActionError]);

  const rerunActivity = useCallback((activity: WorkspaceRun) => {
    if (!activity.actionId) return;
    setPendingActivityAction(activity);
    activateContext(activity, "terminal");
    setActivityOpen(false);
  }, [activateContext, setActivityOpen]);

  const markActivitySeen = useCallback((activity: WorkspaceRun) => {
    void request({
      type: "activity.mark-seen",
      payload: { runId: activity.id },
    }).catch(() => undefined);
  }, [request]);

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
    openActivityLocation,
    openActivityPreview,
    stopActivity,
    rerunActivity,
    markActivitySeen,
    acknowledgeActivity,
    dismissActivity,
  }), [
    acknowledgeActivity,
    dismissActivity,
    markActivitySeen,
    openActivityLocation,
    openActivityPreview,
    pendingActionId,
    pendingResumeConversationId,
    project,
    rerunActivity,
    runProjectAction,
    stopActivity,
  ]);
}
