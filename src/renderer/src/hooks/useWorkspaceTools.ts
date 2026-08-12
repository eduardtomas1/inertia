import { useCallback } from "react";
import type {
  Conversation,
  ConversationDetail,
  Project,
  ServerEvent,
} from "@shared/contracts";
import type { WorkspacePanelTab } from "../components/WorkspacePanel";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { useTurnArtifacts } from "./workspace-tools/useTurnArtifacts";
import { useWorkspaceFiles } from "./workspace-tools/useWorkspaceFiles";
import { useWorkspaceGit } from "./workspace-tools/useWorkspaceGit";
import { useWorkspaceReview } from "./workspace-tools/useWorkspaceReview";

interface WorkspaceToolsOptions {
  enabled?: boolean;
  loadGitStatusOnMount?: boolean;
  loadGitOnMount?: boolean;
  loadFilesOnMount?: boolean;
  project: Project | null;
  conversation: Conversation | null;
  detail: ConversationDetail | null;
  online: boolean;
  ignoreWhitespace: boolean;
  confirmDestructiveActions: boolean;
  refreshVersion: number;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  run: (key: string, command: CommandWithoutId) => Promise<ServerEvent>;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  setActionError: (message: string | null) => void;
  setActiveTool: (tool: WorkspacePanelTab | null) => void;
}

export async function openWorkspaceEntry(
  path: string,
  actions: {
    inspectDirectory: (path: string) => Promise<unknown>;
    openDirectory: (path: string) => Promise<unknown>;
    openFile: (path: string) => void;
  },
): Promise<"directory" | "file"> {
  try {
    await actions.inspectDirectory(path);
  } catch {
    actions.openFile(path);
    return "file";
  }
  await actions.openDirectory(path);
  return "directory";
}

export function useWorkspaceTools(options: WorkspaceToolsOptions) {
  const enabled = options.enabled ?? true;
  const git = useWorkspaceGit({
    project: options.project,
    conversation: options.conversation,
    online: options.online,
    ignoreWhitespace: options.ignoreWhitespace,
    refreshVersion: options.refreshVersion,
    request: options.request,
    run: options.run,
    subscribe: options.subscribe,
    setActionError: options.setActionError,
    enabled,
    loadStatusOnMount: options.loadGitStatusOnMount ?? true,
    loadWorkspaceOnMount: options.loadGitOnMount ?? false,
  });
  const files = useWorkspaceFiles({
    project: options.project,
    conversation: options.conversation,
    online: options.online,
    request: options.request,
    setActionError: options.setActionError,
    enabled,
    loadOnMount: options.loadFilesOnMount ?? false,
  });
  const review = useWorkspaceReview({
    project: options.project,
    conversation: options.conversation,
    detail: options.detail,
    gitDiff: git.gitDiff,
    ignoreWhitespace: options.ignoreWhitespace,
    confirmDestructiveActions: options.confirmDestructiveActions,
    request: options.request,
    run: options.run,
    setGitDiff: git.setGitDiff,
  });
  const selectWorkspaceFile = files.selectWorkspaceFile;
  const requestWorkspaceEntries = files.requestWorkspaceEntries;
  const setActiveTool = options.setActiveTool;
  const openWorkspaceFile = useCallback((path: string): void => {
    const projectId = options.project?.id;
    if (!projectId) return;
    void openWorkspaceEntry(path, {
      inspectDirectory: async (directory) =>
        await requestWorkspaceEntries({ directory }),
      openDirectory: async (directory) =>
        await window.inertia.openProjectPath({
            projectId,
            ...(options.conversation?.id
              ? { conversationId: options.conversation.id }
              : {}),
            relativePath: directory,
            action: "reveal",
        }),
      openFile: (file) => {
        selectWorkspaceFile(file);
        setActiveTool("files");
      },
    }).catch(() => undefined);
  }, [
    options.conversation?.id,
    options.project?.id,
    requestWorkspaceEntries,
    selectWorkspaceFile,
    setActiveTool,
  ]);
  const artifacts = useTurnArtifacts({
    project: options.project,
    conversation: options.conversation,
    request: options.request,
    setActionError: options.setActionError,
    setActiveTool: options.setActiveTool,
    openWorkspaceFile,
    loadGit: git.loadGit,
  });

  return {
    ...git,
    ...files,
    ...review,
    ...artifacts,
    gitLoading: git.loading,
    gitError: git.loadError,
    toolsLoading: git.loading || artifacts.loading,
  };
}
