import {
  useCallback,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";

import type {
  ChatAttachment,
  Project,
  ServerEvent,
  TurnRequestContext,
} from "@shared/contracts";
import type { ProjectImportInput } from "../../../shared/project-import";
import type { AppView } from "../appView";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import type { TranscriptMessageSendAcceptance } from "../utils/transcriptNavigation";
import type { WorkspaceStartupSurface } from "../utils/workspaceStartup";

type DraftConversationNavigation = {
  discard: () => void;
  importProject: (input?: ProjectImportInput) => Promise<boolean>;
  sendFromComposer: (
    content: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
  ) => Promise<TranscriptMessageSendAcceptance | null>;
  start: (projectId: string) => void;
};

type SelectionCommandQueue = (
  key: string,
  command: CommandWithoutId,
) => Promise<ServerEvent>;

export function useProjectChatNavigation({
  project,
  projects,
  busyAction,
  draftConversation,
  selectionCommandQueue,
  conversationSelectionGenerationRef,
  startupSurface,
  showStartupSurface,
  updateSplitConversationId,
  setActionError,
  setSidebarOpen,
  setView,
}: {
  project: Project | null;
  projects: Project[];
  busyAction: string | null;
  draftConversation: DraftConversationNavigation;
  selectionCommandQueue: SelectionCommandQueue;
  conversationSelectionGenerationRef: MutableRefObject<number>;
  startupSurface: WorkspaceStartupSurface;
  showStartupSurface: (surface: WorkspaceStartupSurface) => void;
  updateSplitConversationId: (conversationId: string | null) => void;
  setActionError: Dispatch<SetStateAction<string | null>>;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  setView: Dispatch<SetStateAction<AppView>>;
}) {
  const [globalChatActive, setGlobalChatActive] = useState(false);
  const [globalProjectChangeId, setGlobalProjectChangeId] =
    useState<string | null>(null);

  const deactivateGlobalChat = useCallback(() => {
    conversationSelectionGenerationRef.current += 1;
    setGlobalChatActive(false);
    setGlobalProjectChangeId(null);
  }, [conversationSelectionGenerationRef]);
  const exitGlobalChat = useCallback(() => {
    deactivateGlobalChat();
    draftConversation.discard();
  }, [deactivateGlobalChat, draftConversation]);

  const navigateToView = useCallback((nextView: AppView) => {
    if (nextView !== "workspace") {
      conversationSelectionGenerationRef.current += 1;
    }
    if (nextView !== "home") {
      if (globalChatActive) exitGlobalChat();
      else deactivateGlobalChat();
    }
    setView(nextView);
  }, [
    conversationSelectionGenerationRef,
    deactivateGlobalChat,
    exitGlobalChat,
    globalChatActive,
    setView,
  ]);

  const sendMessage = useCallback(async (
    ...args: Parameters<DraftConversationNavigation["sendFromComposer"]>
  ): ReturnType<DraftConversationNavigation["sendFromComposer"]> => {
    const acceptance = await draftConversation.sendFromComposer(...args);
    if (acceptance && globalChatActive) {
      setGlobalChatActive(false);
      setView("workspace");
    }
    return acceptance;
  }, [draftConversation, globalChatActive, setView]);

  const openGlobalChat = useCallback((): void => {
    conversationSelectionGenerationRef.current += 1;
    const targetProject = project ?? projects[0] ?? null;
    setGlobalProjectChangeId(null);
    setView("home");
    setSidebarOpen(false);
    if (!targetProject) {
      setGlobalChatActive(false);
      return;
    }
    draftConversation.start(targetProject.id);
    setGlobalChatActive(true);
  }, [
    conversationSelectionGenerationRef,
    draftConversation,
    project,
    projects,
    setSidebarOpen,
    setView,
  ]);

  const selectGlobalChatProject = useCallback((nextProject: Project): void => {
    if (nextProject.id === project?.id || globalProjectChangeId) return;
    const selectionGeneration =
      conversationSelectionGenerationRef.current + 1;
    conversationSelectionGenerationRef.current = selectionGeneration;
    setGlobalProjectChangeId(nextProject.id);
    void selectionCommandQueue("project.select:global-chat", {
      type: "project.select",
      payload: { projectId: nextProject.id },
    }).then(() => {
      if (selectionGeneration !== conversationSelectionGenerationRef.current) {
        return;
      }
      draftConversation.start(nextProject.id);
      setGlobalChatActive(true);
      setView("home");
      setSidebarOpen(false);
    }).catch((error: unknown) => {
      if (selectionGeneration === conversationSelectionGenerationRef.current) {
        setActionError(error instanceof Error
          ? error.message
          : "The project could not be selected.");
      }
    }).finally(() => {
      if (selectionGeneration === conversationSelectionGenerationRef.current) {
        setGlobalProjectChangeId(null);
      }
    });
  }, [
    conversationSelectionGenerationRef,
    draftConversation,
    globalProjectChangeId,
    project?.id,
    selectionCommandQueue,
    setActionError,
    setSidebarOpen,
    setView,
  ]);

  const importProject = useCallback(async (input?: ProjectImportInput) => {
    if (busyAction) {
      if (input) throw new Error("Wait for the current action to finish before adding a project.");
      return;
    }
    deactivateGlobalChat();
    try {
      if (!await draftConversation.importProject(input)) return;
      setView("workspace");
      setSidebarOpen(false);
      showStartupSurface(startupSurface);
    } catch (error) { if (input) throw error; /* Native callers receive the existing error toast. */ }
  }, [
    busyAction,
    deactivateGlobalChat,
    draftConversation,
    setSidebarOpen,
    setView,
    showStartupSurface,
    startupSurface,
  ]);

  const selectProject = useCallback((nextProject: Project) => {
    if (nextProject.id === project?.id) {
      if (globalChatActive) {
        exitGlobalChat();
        setView("workspace");
      }
      return;
    }
    exitGlobalChat();
    conversationSelectionGenerationRef.current += 1;
    void selectionCommandQueue("project.select", {
      type: "project.select",
      payload: { projectId: nextProject.id },
    }).then(() => updateSplitConversationId(null)).catch(() => undefined);
  }, [
    conversationSelectionGenerationRef,
    exitGlobalChat,
    globalChatActive,
    project?.id,
    selectionCommandQueue,
    setView,
    updateSplitConversationId,
  ]);

  return {
    globalChatActive,
    globalProjectChangeId,
    deactivateGlobalChat,
    exitGlobalChat,
    importProject,
    navigateToView,
    openGlobalChat,
    selectGlobalChatProject,
    selectProject,
    sendMessage,
  };
}
