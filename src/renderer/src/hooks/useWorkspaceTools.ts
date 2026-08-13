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

export function useWorkspaceTools(options: WorkspaceToolsOptions) {
  const enabled = options.enabled ?? true;
  const workspaceAuthority = `${enabled}${options.project?.id}${options.conversation?.id}`;
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
  const { setActionError, setActiveTool } = options;
  const openWorkspaceFile = useCallback((
    path: string,
    location?: WorkspaceFileLocation,
    literalPath?: boolean,
  ): void => {
    const projectId = options.project?.id;
    if (!projectId) return;
    void import("./workspace-tools/openWorkspaceEntry").then(
      ({ openWorkspaceFile }) => openWorkspaceFile([
        path,
        location,
        literalPath,
        workspaceAuthorityRef,
        workspaceAuthority,
        requestWorkspaceEntries,
        projectId,
        options.conversation?.id,
        selectWorkspaceFile,
        setActiveTool,
      ]),
    ).catch(() => {
      if (workspaceAuthorityRef.current === workspaceAuthority) {
        setActionError("File open failed.");
      }
    });
  }, [
    options.conversation?.id,
    options.project?.id,
    requestWorkspaceEntries,
    selectWorkspaceFile,
    setActiveTool,
    workspaceAuthority,
    setActionError,
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
