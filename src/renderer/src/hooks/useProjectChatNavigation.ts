import {
  useCallback,
  useRef,
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
  changeProject: (projectId: string) => void;
  discard: () => void;
  clear: () => void;
  importProject: (input?: ProjectImportInput) => Promise<boolean>;
  sendFromComposer: (
    content: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
  ) => Promise<TranscriptMessageSendAcceptance | null>;
  start: (projectId: string, independent?: boolean, resume?: boolean) => void;
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
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  setView: Dispatch<SetStateAction<AppView>>;
}) {
  const [globalChatActive, setGlobalChatActive] = useState(false);
  const globalChatGenerationRef = useRef(0);
  const resumeSearchDraftRef = useRef(false);

  const deactivateGlobalChat = useCallback(() => {
    globalChatGenerationRef.current += 1;
    conversationSelectionGenerationRef.current += 1;
    setGlobalChatActive(false);
  }, [conversationSelectionGenerationRef]);
  const exitGlobalChat = useCallback((preserveDraft = false) => {
    deactivateGlobalChat();
    resumeSearchDraftRef.current = preserveDraft;
    if (preserveDraft) draftConversation.clear();
    else draftConversation.discard();
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
    const generation = globalChatGenerationRef.current;
    const acceptance = await draftConversation.sendFromComposer(...args);
    if (acceptance && globalChatActive
      && generation === globalChatGenerationRef.current) {
      setGlobalChatActive(false);
      setView("workspace");
    }
    return acceptance;
  }, [draftConversation, globalChatActive, setView]);

  const openGlobalChat = useCallback((): void => {
    globalChatGenerationRef.current += 1;
    conversationSelectionGenerationRef.current += 1;
    const targetProject = project ?? projects[0] ?? null;
    updateSplitConversationId(null);
    setView("home");
    setSidebarOpen(false);
    if (!targetProject) {
      setGlobalChatActive(false);
      return;
    }
    if (resumeSearchDraftRef.current) draftConversation.start(targetProject.id, true, true);
    else draftConversation.start(targetProject.id, true);
    resumeSearchDraftRef.current = false;
    setGlobalChatActive(true);
  }, [
    conversationSelectionGenerationRef,
    draftConversation,
    project,
    projects,
    setSidebarOpen,
    setView,
    updateSplitConversationId,
  ]);

  const selectGlobalChatProject = useCallback((nextProject: Project): void => {
    draftConversation.changeProject(nextProject.id);
  }, [draftConversation]);

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
