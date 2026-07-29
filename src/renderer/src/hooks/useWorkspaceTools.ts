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
  setActionError: (message: string | null) => void;
  setActiveTool: (tool: WorkspacePanelTab | null) => void;
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
    setActionError: options.setActionError,
    enabled,
    loadOnMount: options.loadGitOnMount ?? true,
  });
  const files = useWorkspaceFiles({
    project: options.project,
    conversation: options.conversation,
    online: options.online,
    request: options.request,
    setActionError: options.setActionError,
    enabled,
    loadOnMount: options.loadFilesOnMount ?? true,
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
    loadGit: git.loadGit,
  });
  const selectWorkspaceFile = files.selectWorkspaceFile;
  const setActiveTool = options.setActiveTool;
  const openWorkspaceFile = useCallback((path: string): void => {
    selectWorkspaceFile(path);
    setActiveTool("files");
  }, [selectWorkspaceFile, setActiveTool]);
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
    toolsLoading: git.loading || artifacts.loading,
  };
}
