import { useEffect, useState } from "react";
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
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [pendingActivityAction, setPendingActivityAction] =
    useState<WorkspaceRun | null>(null);

  useEffect(() => {
    if (
      !pendingActivityAction?.actionId
      || project?.id !== pendingActivityAction.projectId
    ) return;
    if (
      pendingActivityAction.conversationId
      && conversationId !== pendingActivityAction.conversationId
    ) return;
    setPendingActionId(pendingActivityAction.actionId);
    setPendingActivityAction(null);
  }, [conversationId, pendingActivityAction, project?.id]);

  const runProjectAction = (action: ProjectAction) => {
    setPendingActionId(action.id);
    setActiveTool("terminal");
  };

  const openActivityLocation = (activity: WorkspaceRun) => {
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
  };

  const openActivityPreview = (activity: WorkspaceRun) => {
    if (!activity.port) return;
    activateContext(activity, "preview");
    navigatePreview(`http://127.0.0.1:${activity.port}`);
    setActivityOpen(false);
  };

  const stopActivity = (activity: WorkspaceRun) => {
    void run(`activity.stop:${activity.id}`, {
      type: "activity.stop",
      payload: { runId: activity.id },
    }).catch((error) => {
      const detail = error instanceof Error
        ? error.message
        : "The run could not be stopped.";
      setActionError(`Could not stop ${activity.label}: ${detail}`);
    });
  };

  const rerunActivity = (activity: WorkspaceRun) => {
    if (!activity.actionId) return;
    setPendingActivityAction(activity);
    activateContext(activity, "terminal");
    setActivityOpen(false);
  };

  const markActivitySeen = (activity: WorkspaceRun) => {
    void request({
      type: "activity.mark-seen",
      payload: { runId: activity.id },
    }).catch(() => undefined);
  };

  const acknowledgeActivity = (activity: WorkspaceRun) => {
    void run(`activity.acknowledge:${activity.id}`, {
      type: "activity.acknowledge",
      payload: { runId: activity.id },
    }).catch((error) => {
      const detail = error instanceof Error
        ? error.message
        : "The run could not be acknowledged.";
      setActionError(`Could not acknowledge ${activity.label}: ${detail}`);
    });
  };

  const dismissActivity = (activity: WorkspaceRun) => {
    void run(`activity.dismiss:${activity.id}`, {
      type: "activity.dismiss",
      payload: { runId: activity.id },
    }).catch((error) => {
      const detail = error instanceof Error
        ? error.message
        : "The run could not be dismissed.";
      setActionError(`Could not dismiss ${activity.label}: ${detail}`);
    });
  };

  return {
    pendingActionId,
    clearPendingAction: () => setPendingActionId(null),
    runProjectAction,
    openActivityLocation,
    openActivityPreview,
    stopActivity,
    rerunActivity,
    markActivitySeen,
    acknowledgeActivity,
    dismissActivity,
  };
}
