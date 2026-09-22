import type {
  GitStatusSnapshot,
  ProjectAction,
} from "@shared/contracts";

import type { WorkspaceRunsModel } from "../../utils/workspaceRuns";
import { GitActionsControl } from "./GitActionsControl";
import { OpenInControl } from "./OpenInControl";
import {
  ProjectActionsControl,
  type HeaderControlPresentation,
} from "./ProjectActionsControl";

export interface WorkspaceHeaderActionsProps {
  presentation: HeaderControlPresentation;
  projectId: string;
  projectName: string;
  actions: readonly ProjectAction[];
  runs: WorkspaceRunsModel | null;
  checkoutPath: string | null;
  filesAvailable: boolean;
  gitStatus: GitStatusSnapshot | null;
  busy: boolean;
  gitNotice: string | null;
  onRunAction: (action: ProjectAction) => void;
  onAddAction?: () => void;
  onOpenFolder: () => void;
  onRevealFolder: () => void;
  onOpenFiles: () => void;
  onCommit: () => void;
  onPush: () => void;
  onPull: () => void;
  onFetch?: () => void;
  onOpenPullRequest: () => void;
  onPushAndCreatePullRequest: () => void;
  onOpenBranches: () => void;
  onRefreshGitStatus?: () => void;
  onRequestMenuClose: () => void;
}

export function WorkspaceHeaderActions({
  presentation,
  projectId,
  projectName,
  actions,
  runs,
  checkoutPath,
  filesAvailable,
  gitStatus,
  busy,
  gitNotice,
  onRunAction,
  onAddAction,
  onOpenFolder,
  onRevealFolder,
  onOpenFiles,
  onCommit,
  onPush,
  onPull,
  onFetch,
  onOpenPullRequest,
  onPushAndCreatePullRequest,
  onOpenBranches,
  onRefreshGitStatus,
  onRequestMenuClose,
}: WorkspaceHeaderActionsProps): React.JSX.Element {
  const collapsed = presentation === "menu";
  const showGit = gitStatus?.isRepository === true;
  return (
    <>
      <ProjectActionsControl
        presentation={presentation}
        projectId={projectId}
        actions={actions}
        runs={runs}
        onRunAction={onRunAction}
        {...(onAddAction ? { onAddAction } : {})}
        onRequestMenuClose={onRequestMenuClose}
      />
      {collapsed && <div role="separator" className="header-menu-separator" />}
      <OpenInControl
        presentation={presentation}
        checkoutName={projectName}
        checkoutPath={checkoutPath}
        filesAvailable={filesAvailable}
        onOpenFolder={onOpenFolder}
        onRevealFolder={onRevealFolder}
        onOpenFiles={onOpenFiles}
        onRequestMenuClose={onRequestMenuClose}
      />
      {showGit && collapsed && <div role="separator" className="header-menu-separator" />}
      {showGit && gitStatus && (
        <GitActionsControl
          presentation={presentation}
          status={gitStatus}
          busy={busy}
          notice={gitNotice}
          onCommit={onCommit}
          onPush={onPush}
          onPull={onPull}
          {...(onFetch ? { onFetch } : {})}
          onOpenPullRequest={onOpenPullRequest}
          onPushAndCreatePullRequest={onPushAndCreatePullRequest}
          onOpenBranches={onOpenBranches}
          {...(onRefreshGitStatus ? { onRefreshStatus: onRefreshGitStatus } : {})}
          onRequestMenuClose={onRequestMenuClose}
        />
      )}
    </>
  );
}
