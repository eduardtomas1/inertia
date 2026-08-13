import { useCallback, useRef } from "react";
import type {
  Conversation,
  ConversationDetail,
  Project,
  ServerEvent,
} from "@shared/contracts";
import type { WorkspacePanelTab } from "../components/WorkspacePanel";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import type { WorkspaceFileLocation } from "../utils/workspaceFileReference";
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
    openFile: (
      path: string,
      location?: WorkspaceFileLocation,
      literalPath?: boolean,
    ) => void;
    isCurrent?: () => boolean;
  },
  location?: WorkspaceFileLocation,
  literalPath?: boolean,
): Promise<"directory" | "file" | "stale"> {
  if (actions.isCurrent && !actions.isCurrent()) return "stale";
  try {
    await actions.inspectDirectory(path);
  } catch {
    if (actions.isCurrent && !actions.isCurrent()) return "stale";
    if (location || literalPath) {
      actions.openFile(path, location, literalPath);
    }
    else actions.openFile(path);
    return "file";
  }
  if (actions.isCurrent && !actions.isCurrent()) return "stale";
  await actions.openDirectory(path);
  return "directory";
}

export function useWorkspaceTools(options: WorkspaceToolsOptions) {
  const enabled = options.enabled ?? true;
  const workspaceAuthority = [
    enabled ? "enabled" : "disabled",
    options.project?.id ?? "",
    options.conversation?.id ?? "",
  ].join("\0");
  const workspaceAuthorityRef = useRef(workspaceAuthority);
  workspaceAuthorityRef.current = workspaceAuthority;
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
  const openWorkspaceFile = useCallback((
    path: string,
    location?: WorkspaceFileLocation,
    literalPath?: boolean,
  ): void => {
    const projectId = options.project?.id;
    if (!projectId) return;
    void openWorkspaceEntry(path, {
      isCurrent: () => workspaceAuthorityRef.current === workspaceAuthority,
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
      openFile: (file, fileLocation, exactPath) => {
        selectWorkspaceFile(file, fileLocation, exactPath);
        setActiveTool("files");
      },
    }, location, literalPath).catch(() => undefined);
  }, [
    options.conversation?.id,
    options.project?.id,
    requestWorkspaceEntries,
    selectWorkspaceFile,
    setActiveTool,
    workspaceAuthority,
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
