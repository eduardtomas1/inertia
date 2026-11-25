import type {
  GitStatusSnapshot,
  ProjectAction,
} from "@shared/contracts";
import type { DetectedEditor, EditorId, PreferredEditor } from "@shared/editor-ids";

import type { WorkspaceRunsModel } from "../../utils/workspaceRuns";
import { FocusFirstMenuItem } from "./FocusFirstMenuItem";
import { GitActionsControl } from "./GitActionsControl";
import { OpenInControl } from "./OpenInControl";
import {
  ProjectActionsControl,
  type HeaderControlPresentation,
} from "./ProjectActionsControl";

export interface WorkspaceHeaderActionsProps {
  presentation: HeaderControlPresentation;
  focusMenuId: string | null;
  projectId: string;
  projectName: string;
  actions: readonly ProjectAction[];
  runs: WorkspaceRunsModel | null;
  checkoutPath: string | null;
  filesAvailable: boolean;
  preferredEditor?: PreferredEditor;
  detectedEditors?: readonly DetectedEditor[];
  gitStatus: GitStatusSnapshot | null;
  busy: boolean;
  gitNotice: string | null;
  onRunAction: (action: ProjectAction) => void;
  onAddAction?: () => void;
  onOpenFolder: () => void;
  onRevealFolder: () => void;
  onOpenFiles: () => void;
  onOpenInEditor?: (editor: EditorId) => void;
  onCommit: () => void;
  onPush: () => void;
  onPull: () => void;
  onFetch?: () => void;
  onOpenPullRequest: () => void;
  onPushAndCreatePullRequest: () => void;
  onOpenBranches: () => void;
  onOpenGitHistory?: () => void;
  onRefreshGitStatus?: () => void;
  onRequestMenuClose: () => void;
}

export function WorkspaceHeaderActions({
  presentation,
  focusMenuId,
  projectId,
  projectName,
  actions,
  runs,
  checkoutPath,
  filesAvailable,
  preferredEditor,
  detectedEditors,
  gitStatus,
  busy,
  gitNotice,
  onRunAction,
  onAddAction,
  onOpenFolder,
  onRevealFolder,
  onOpenFiles,
  onOpenInEditor,
  onCommit,
  onPush,
  onPull,
  onFetch,
  onOpenPullRequest,
  onPushAndCreatePullRequest,
  onOpenBranches,
  onOpenGitHistory,
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
        {...(preferredEditor ? { preferredEditor } : {})}
        {...(detectedEditors ? { detectedEditors } : {})}
        onOpenFolder={onOpenFolder}
        onRevealFolder={onRevealFolder}
        onOpenFiles={onOpenFiles}
        {...(onOpenInEditor ? { onOpenInEditor } : {})}
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
          {...(onOpenGitHistory ? { onOpenHistory: onOpenGitHistory } : {})}
          {...(onRefreshGitStatus ? { onRefreshStatus: onRefreshGitStatus } : {})}
          onRequestMenuClose={onRequestMenuClose}
        />
      )}
      {focusMenuId && <FocusFirstMenuItem menuId={focusMenuId} />}
    </>
  );
}
