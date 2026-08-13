import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  Download,
  ExternalLink,
  FileCode2,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Info,
  Upload,
} from "lucide-react";

import type {
  ChangedFile,
  DiffReviewNote,
  DiffReviewState,
  GitForge,
  WorkspaceGitDiffSnapshot,
  WorkspaceGitRepositorySnapshot,
  WorkspaceGitSnapshot,
  ServerEvent,
} from "@shared/contracts";
import { useParsedUnifiedDiff } from "../hooks/useParsedUnifiedDiff";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { headerGitActions } from "../utils/headerGitActions";
import { fileLanguageFromPath } from "../utils/fileLanguage";
import {
  parseWorkspaceGitIdentity,
  workspaceGitFile,
  workspaceGitFilePath,
  workspaceGitIdentity,
  workspaceGitRepositoryLabel,
  type WorkspaceChangesRequest,
  type WorkspaceGitFileIdentity,
} from "../utils/workspaceGit";
import {
  ChangesPanel,
  type ChangesPanelProps,
  type DiffSelection,
} from "./ChangesPanel";
import { IconButton } from "./ui";
import { CommitDialog } from "./CommitDialog";
import PullRequestDialog from "./PullRequestDialog";

type ForwardedChangesProps = Omit<
  ChangesPanelProps,
  | "files"
  | "diff"
  | "selectedPath"
  | "loading"
  | "fileNavigator"
  | "compactFileNavigator"
  | "scopeNavigator"
  | "notice"
  | "headerMetrics"
  | "emptyState"
  | "diffEmptyState"
  | "capabilities"
  | "repositoryPath"
  | "onSelectFile"
  | "onOpenFile"
  | "onRefresh"
>;

export interface WorkspaceChangesPanelProps extends ForwardedChangesProps {
  projectName: string;
  snapshot: WorkspaceGitSnapshot | null;
  loading?: boolean;
  onRefresh: () => void;
  onLoadRepositoryDiff: (
    repositoryPath: string,
    filePath?: string,
    commitReview?: boolean,
  ) => Promise<WorkspaceGitDiffSnapshot>;
  onOpenWorkspaceFile: (path: string) => void;
  projectId?: string;
  conversationId?: string;
  busyAction?: string | null;
  run?: (key: string, command: CommandWithoutId) => Promise<ServerEvent>;
  onActionError?: (message: string) => void;
  changesRequest?: WorkspaceChangesRequest | null;
  onChangesRequestHandled?: (revision: number) => void;
}

interface PullRequestDialogScope {
  projectId: string;
  conversationId?: string;
  repositoryPath: string;
  actionRevision: string;
  authorityRef: string;
  initialTitle: string;
  forge: GitForge;
}

function fileStatus(file: ChangedFile): string {
  if (file.untracked || file.status.toLocaleLowerCase("en-US") === "untracked") return "U";
  if (file.status.toLocaleLowerCase("en-US") === "deleted") return "D";
  if (file.status.toLocaleLowerCase("en-US") === "added") return "A";
  if (file.status.toLocaleLowerCase("en-US") === "renamed") return "R";
  if (file.status.toLocaleLowerCase("en-US") === "unmerged") return "!";
  return "M";
}

function repositoryStatus(repository: WorkspaceGitRepositorySnapshot): string {
  if (repository.state === "error") return "Unavailable";
  if (repository.clean) return "Clean";
  return `${repository.files.length} ${repository.files.length === 1 ? "file" : "files"}`;
}

function fileWorkingState(file: ChangedFile): string {
  if (file.untracked) return "untracked";
  if (file.staged && file.unstaged) return "staged + unstaged";
  if (file.staged) return "staged";
  return "unstaged";
}

function pullRequestActionRevision(
  repository: WorkspaceGitRepositorySnapshot | null,
): string | null {
  if (!repository) return null;
  return JSON.stringify([
    repository.repositoryPath,
    repository.state,
    repository.truncated,
    repository.branch,
    repository.upstream,
    repository.ahead,
    repository.behind,
    repository.hasRemote,
    repository.pullRequest?.available ?? null,
    repository.pullRequest?.remoteName ?? null,
    repository.pullRequest?.forge ?? null,
    repository.pullRequest?.unavailableReason ?? null,
  ]);
}

function selectionWithRepository(
  selection: DiffSelection,
  repositoryPath: string,
): DiffSelection {
  return { ...selection, repositoryPath };
}

export function workspaceGitSelectedFileRevision(
  snapshot: WorkspaceGitSnapshot | null,
  selection: WorkspaceGitFileIdentity | null,
): string | null {
  if (!snapshot || !selection) return null;
  const entry = workspaceGitFile(snapshot, selection);
  if (!entry) return null;
  const { file, repository } = entry;
  return JSON.stringify([
    repository.repositoryPath,
    repository.state,
    repository.truncated,
    file.path,
    file.status,
    file.indexStatus,
    file.worktreeStatus,
    file.staged,
    file.unstaged,
    file.untracked,
    file.insertions,
    file.deletions,
  ]);
}

export function workspaceGitRepositoriesWithMissingReviewTargets(
  snapshot: WorkspaceGitSnapshot | null,
  reviewStates: readonly DiffReviewState[],
  notes: readonly DiffReviewNote[],
): string[] {
  if (!snapshot) return [];
  const activePathsByRepository = new Map<string, Set<string>>();
  for (const targets of [reviewStates, notes]) {
    for (const target of targets) {
      const repositoryPath = target.repositoryPath ?? ".";
      if (target.stale || repositoryPath === ".") continue;
      const paths = activePathsByRepository.get(repositoryPath)
        ?? new Set<string>();
      paths.add(target.path);
      activePathsByRepository.set(repositoryPath, paths);
    }
  }
  return snapshot.repositories
    .filter((repository) => {
      const activePaths = activePathsByRepository.get(
        repository.repositoryPath,
      );
      if (
        !activePaths
        || repository.state !== "ready"
        || repository.truncated
      ) {
        return false;
      }
      const changedPaths = new Set(repository.files.map((file) => file.path));
      for (const path of activePaths) {
        if (!changedPaths.has(path)) return true;
      }
      return false;
    })
    .map((repository) => repository.repositoryPath);
}

export function WorkspaceChangesPanel({
  projectName,
  snapshot,
  loading = false,
  onRefresh,
  onLoadRepositoryDiff,
  onOpenWorkspaceFile,
  projectId,
  conversationId,
  busyAction = null,
  run,
  onActionError,
  changesRequest = null,
  onChangesRequestHandled,
  summary,
  selectionAnswer,
  reviewStates = [],
  notes = [],
  lastReversal,
  onGenerateSummary,
  onCancelSummary,
  onAsk,
  onRequestRevision,
  onRevert,
  onAddToPrompt,
  ...changesProps
}: WorkspaceChangesPanelProps): React.JSX.Element {
  const [selected, setSelected] = useState<WorkspaceGitFileIdentity | null>(null);
  const [selectedRepositoryPath, setSelectedRepositoryPath] = useState<string | null>(null);
  const [diff, setDiff] = useState<WorkspaceGitDiffSnapshot | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [pullRequestDialogScope, setPullRequestDialogScope] = useState<
    PullRequestDialogScope | null
  >(null);
  const [commitDiff, setCommitDiff] = useState<WorkspaceGitDiffSnapshot | null>(null);
  const [commitDiffLoading, setCommitDiffLoading] = useState(false);
  const [commitDiffError, setCommitDiffError] = useState<string | null>(null);
  const commitDiffRequestRef = useRef(0);
  const handledChangesRequestRef = useRef(0);
  const parsedCommitDiff = useParsedUnifiedDiff(
    commitDiff?.patch ?? "",
    commitDiff,
  );

  useEffect(() => {
    handledChangesRequestRef.current = 0;
  }, [conversationId, projectId]);

  const selectedEntry = useMemo(
    () => snapshot ? workspaceGitFile(snapshot, selected) : null,
    [selected, snapshot],
  );
  const requestedRepository = snapshot?.repositories.find(
    (repository) => repository.repositoryPath === selectedRepositoryPath,
  ) ?? null;
  const activeRepository = requestedRepository
    ?? selectedEntry?.repository
    ?? snapshot?.repositories.find((repository) => repository.files.length > 0)
    ?? snapshot?.repositories[0]
    ?? null;
  const activeRepositoryPath = activeRepository?.repositoryPath ?? null;
  const activeRepositoryAuthorityRef = activeRepository?.authorityRef ?? undefined;
  const activePullRequestActionRevision = pullRequestActionRevision(
    activeRepository,
  );
  const activeRepositoryActionRevision = activeRepository
    ? JSON.stringify([
        activeRepository.repositoryPath,
        activeRepository.authorityRef ?? null,
        activeRepository.state,
        activeRepository.truncated,
        activeRepository.branch,
        activeRepository.upstream,
        activeRepository.ahead,
        activeRepository.behind,
        activeRepository.files.map((file) => [
          file.path,
          file.status,
          file.indexStatus,
          file.worktreeStatus,
          file.staged,
          file.unstaged,
          file.untracked,
          file.insertions,
          file.deletions,
        ]),
      ])
    : null;
  const effectiveSelection = useMemo<WorkspaceGitFileIdentity | null>(
    () => selectedEntry
      && selectedEntry.repository.repositoryPath === activeRepositoryPath
      ? selected
      : activeRepository?.files[0]
        ? {
            repositoryPath: activeRepository.repositoryPath,
            filePath: activeRepository.files[0].path,
          }
        : null,
    [activeRepository, activeRepositoryPath, selected, selectedEntry],
  );
  const nestedRepository = activeRepositoryPath !== null && activeRepositoryPath !== ".";
  const activeFiles = activeRepository?.files ?? [];
  const activeReviewStates = reviewStates.filter(
    (state) => (state.repositoryPath ?? ".") === (activeRepositoryPath ?? "."),
  );
  const activeNotes = notes.filter(
    (note) => (note.repositoryPath ?? ".") === (activeRepositoryPath ?? "."),
  );
  const selectedFileRevision = workspaceGitSelectedFileRevision(
    snapshot,
    effectiveSelection,
  );
  const missingReviewRepositories = useMemo(
    () => workspaceGitRepositoriesWithMissingReviewTargets(
      snapshot,
      reviewStates,
      notes,
    ),
    [notes, reviewStates, snapshot],
  );
  const activeGitStatus = useMemo(() => activeRepository?.state === "ready"
    ? {
        isRepository: true,
        authorityRef: activeRepository.authorityRef,
        root: null,
        branch: activeRepository.branch,
        upstream: activeRepository.upstream,
        ahead: activeRepository.ahead,
        behind: activeRepository.behind,
        hasRemote: activeRepository.hasRemote,
        pullRequest: activeRepository.pullRequest,
        files: activeRepository.files,
        insertions: activeRepository.insertions,
        deletions: activeRepository.deletions,
      }
    : null, [activeRepository]);
  const nestedGitActions = useMemo(
    () => headerGitActions(activeGitStatus, Boolean(busyAction)),
    [activeGitStatus, busyAction],
  );
  const commitGitStatus = useMemo(() => activeGitStatus && commitDiff
    ? {
        ...activeGitStatus,
        files: commitDiff.files,
        insertions: commitDiff.files.reduce(
          (total, file) => total + file.insertions,
          0,
        ),
        deletions: commitDiff.files.reduce(
          (total, file) => total + file.deletions,
          0,
        ),
      }
    : activeGitStatus, [activeGitStatus, commitDiff]);

  useEffect(() => {
    commitDiffRequestRef.current += 1;
    setCommitDialogOpen(false);
    setCommitDiff(null);
    setCommitDiffLoading(false);
    setCommitDiffError(null);
  }, [activeRepositoryActionRevision, activeRepositoryPath]);

  useEffect(() => {
    setPullRequestDialogScope((current) => current
      && current.projectId === projectId
      && current.conversationId === conversationId
      && current.repositoryPath === activeRepositoryPath
      && current.actionRevision === activePullRequestActionRevision
      ? current
      : null);
  }, [
    activePullRequestActionRevision,
    activeRepositoryPath,
    conversationId,
    projectId,
  ]);

  useEffect(() => {
    if (!changesRequest || !snapshot) return;
    const repository = snapshot.repositories.find(
      (candidate) => candidate.repositoryPath === changesRequest.repositoryPath,
    );
    if (!repository) return;
    setSelectedRepositoryPath(repository.repositoryPath);
    setSelected(repository.files[0]
      ? {
          repositoryPath: repository.repositoryPath,
          filePath: repository.files[0].path,
        }
      : null);
  }, [changesRequest, snapshot]);

  useEffect(() => {
    if (!activeRepositoryPath) {
      if (selectedRepositoryPath !== null) setSelectedRepositoryPath(null);
      if (selected !== null) setSelected(null);
    } else {
      if (selectedRepositoryPath !== activeRepositoryPath) {
        setSelectedRepositoryPath(activeRepositoryPath);
      }
      if (!effectiveSelection) {
        if (selected !== null) setSelected(null);
      } else if (
        selected === null
        || workspaceGitIdentity(selected) !== workspaceGitIdentity(effectiveSelection)
      ) {
        setSelected(effectiveSelection);
      }
    }
  }, [activeRepositoryPath, effectiveSelection, selected, selectedRepositoryPath]);

  useEffect(() => {
    for (const repositoryPath of missingReviewRepositories) {
      void onLoadRepositoryDiff(repositoryPath).catch(() => undefined);
    }
  }, [
    missingReviewRepositories,
    onLoadRepositoryDiff,
  ]);

  useEffect(() => {
    if (
      !activeRepositoryPath
      || !effectiveSelection
      || activeRepository?.state !== "ready"
      || activeFiles.length === 0
    ) {
      setDiff(null);
      setDiffError(null);
      setDiffLoading(false);
      return;
    }
    let cancelled = false;
    setDiff(null);
    setDiffLoading(true);
    setDiffError(null);
    void onLoadRepositoryDiff(
      activeRepositoryPath,
      effectiveSelection.filePath,
    )
      .then((nextDiff) => {
        if (cancelled) return;
        if (nextDiff.repositoryPath !== activeRepositoryPath) {
          setDiff(null);
          setDiffError("The repository changed while its diff was loading. Refresh and try again.");
          return;
        }
        setDiff(nextDiff);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setDiff(null);
        setDiffError(error instanceof Error ? error.message : "This repository diff could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeFiles.length,
    activeRepository?.state,
    activeRepositoryPath,
    effectiveSelection,
    onLoadRepositoryDiff,
    selectedFileRevision,
    snapshot,
  ]);

  const prepareActiveCommit = useCallback((): void => {
    if (!activeRepository || !activeRepositoryAuthorityRef || commitDiffLoading) {
      return;
    }
    const commitAction = nestedGitActions.find(({ id }) => id === "commit");
    if (commitAction?.disabled || activeRepository.truncated) {
      onActionError?.(activeRepository.truncated
        ? "Refresh this repository before committing its complete change set."
        : commitAction?.detail ?? "This repository cannot be committed right now.");
      return;
    }
    const request = ++commitDiffRequestRef.current;
    setCommitDiff(null);
    setCommitDiffError(null);
    setCommitDiffLoading(true);
    setCommitDialogOpen(true);
    void onLoadRepositoryDiff(
      activeRepository.repositoryPath,
      undefined,
      true,
    )
      .then((repositoryDiff) => {
        if (request !== commitDiffRequestRef.current) return;
        if (repositoryDiff.repositoryPath !== activeRepository.repositoryPath) {
          throw new Error("The repository changed while its complete diff was loading.");
        }
        if (repositoryDiff.truncated) {
          throw new Error("The complete repository diff was truncated. Refresh this repository and try again before committing.");
        }
        if (!repositoryDiff.commitReview) {
          throw new Error("The complete reviewed repository state is unavailable. Refresh this repository and try again before committing.");
        }
        setCommitDiff(repositoryDiff);
      })
      .catch((error: unknown) => {
        if (request !== commitDiffRequestRef.current) return;
        setCommitDiffError(error instanceof Error
          ? error.message
          : "The complete repository diff could not be loaded.");
      })
      .finally(() => {
        if (request === commitDiffRequestRef.current) {
          setCommitDiffLoading(false);
        }
      });
  }, [
    activeRepository,
    activeRepositoryAuthorityRef,
    commitDiffLoading,
    nestedGitActions,
    onActionError,
    onLoadRepositoryDiff,
  ]);

  const pushActiveRepository = useCallback((): void => {
    if (!activeRepository || !activeRepositoryAuthorityRef || !projectId || !run) {
      return;
    }
    const pushAction = nestedGitActions.find(({ id }) => id === "push");
    if (pushAction?.disabled) {
      onActionError?.(pushAction.detail);
      return;
    }
    void run("git.push", {
      type: "git.push",
      payload: {
        projectId,
        conversationId,
        repositoryPath: activeRepository.repositoryPath,
        authorityRef: activeRepositoryAuthorityRef,
      },
    }).then(onRefresh).catch(() => undefined);
  }, [
    activeRepository,
    activeRepositoryAuthorityRef,
    conversationId,
    nestedGitActions,
    onActionError,
    onRefresh,
    projectId,
    run,
  ]);

  useEffect(() => {
    if (
      !changesRequest
      || !snapshot
      || handledChangesRequestRef.current === changesRequest.revision
    ) return;
    const repository = snapshot.repositories.find(
      (candidate) => candidate.repositoryPath === changesRequest.repositoryPath,
    );
    if (!repository) {
      handledChangesRequestRef.current = changesRequest.revision;
      onActionError?.("The requested repository is no longer available. Refresh changes and try again.");
      onChangesRequestHandled?.(changesRequest.revision);
      return;
    }
    if (activeRepositoryPath !== repository.repositoryPath) return;
    handledChangesRequestRef.current = changesRequest.revision;
    if (changesRequest.action === "commit") prepareActiveCommit();
    if (changesRequest.action === "push") pushActiveRepository();
    onChangesRequestHandled?.(changesRequest.revision);
  }, [
    activeRepositoryPath,
    changesRequest,
    onActionError,
    onChangesRequestHandled,
    prepareActiveCommit,
    pushActiveRepository,
    snapshot,
  ]);

  const scopeNavigator = useMemo(() => {
    if (!snapshot || !activeRepository) return undefined;
    const label = workspaceGitRepositoryLabel(
      projectName,
      activeRepository.repositoryPath,
    );
    const nested = activeRepository.repositoryPath !== ".";
    const canRunRepositoryActions = activeRepository.state === "ready"
      && projectId
      && run;
    const authorityRef = activeRepository.authorityRef ?? undefined;
    const commitAction = nestedGitActions.find(({ id }) => id === "commit");
    const pullAction = nestedGitActions.find(({ id }) => id === "pull");
    const pushAction = nestedGitActions.find(({ id }) => id === "push");
    const pullRequestAction = nestedGitActions.find(
      ({ id }) => id === "pull-request",
    );
    return (
      <div className="workspace-repository-scope" aria-label="Git repository scope">
        <span className="workspace-repository-scope-leading">
          <FolderGit2 size={14} aria-hidden="true" />
          {snapshot.repositories.length > 1 ? (
            <select
              aria-label="Repository scope"
              value={activeRepository.repositoryPath}
              onChange={(event) => {
                const repository = snapshot.repositories.find(
                  (candidate) => candidate.repositoryPath === event.currentTarget.value,
                );
                if (!repository) return;
                setSelectedRepositoryPath(repository.repositoryPath);
                setSelected(repository.files[0]
                  ? {
                      repositoryPath: repository.repositoryPath,
                      filePath: repository.files[0].path,
                    }
                  : null);
              }}
            >
              {snapshot.repositories.map((repository) => (
                <option value={repository.repositoryPath} key={repository.repositoryPath}>
                  {workspaceGitRepositoryLabel(projectName, repository.repositoryPath)} · {repositoryStatus(repository)}
                </option>
              ))}
            </select>
          ) : (
            <strong title={label}>{label}</strong>
          )}
        </span>
        <span className="workspace-repository-scope-meta">
          {activeRepository.branch && (
            <span className="workspace-repository-scope-branch" title={activeRepository.branch}>
              <GitBranch size={11} aria-hidden="true" />{activeRepository.branch}
            </span>
          )}
          <span className="workspace-repository-scope-status">
            {repositoryStatus(activeRepository)}
          </span>
          {!activeRepository.clean && activeRepository.state === "ready" && (
            <span
              className="workspace-repository-scope-stats"
              aria-label={`${activeRepository.insertions} insertions and ${activeRepository.deletions} deletions`}
            >
              <b>+{activeRepository.insertions}</b><i>−{activeRepository.deletions}</i>
            </span>
          )}
          {nested && (
            <span
              className="workspace-repository-scope-boundary"
              title="Review marks, notes, questions, prompt references, and selective revert stay with this nested repository. Agent summaries and revisions remain limited to the project-root checkout because recovery checkpoints cover that root."
            >
              <Info size={11} aria-hidden="true" />Nested repo
              <span className="sr-only">Review marks, local notes, questions, prompt references, and selective revert keep this repository identity. Agent summaries and revisions remain available only for the project-root repository because their recovery checkpoints cover that root.</span>
            </span>
          )}
        </span>
        {canRunRepositoryActions && (
          <span className="workspace-repository-scope-actions" aria-label={`Actions for ${label}`}>
            <button
              type="button"
              disabled={
                commitDiffLoading
                || !authorityRef
                || Boolean(commitAction?.disabled)
                || activeRepository.truncated
              }
              title={!authorityRef
                ? "Refresh this repository before changing it."
                : activeRepository.truncated
                ? "Refresh this repository before committing its complete change set."
                : commitAction?.detail}
              onClick={prepareActiveCommit}
            >
              <GitCommitHorizontal size={12} aria-hidden="true" /><span>{commitDiffLoading ? "Preparing…" : commitAction?.label ?? "Commit"}</span>
            </button>
            <button
              type="button"
              disabled={!authorityRef || (pullAction?.disabled ?? true)}
              title={!authorityRef ? "Refresh this repository before changing it." : pullAction?.detail}
              onClick={() => {
                void run("git.pull", {
                  type: "git.pull",
                  payload: {
                    projectId,
                    conversationId,
                    repositoryPath: activeRepository.repositoryPath,
                    authorityRef,
                  },
                }).then(onRefresh).catch(() => undefined);
              }}
            >
              <Download size={12} aria-hidden="true" /><span>{pullAction?.label ?? "Pull"}</span>
            </button>
            <button
              type="button"
              disabled={!authorityRef || (pushAction?.disabled ?? true)}
              title={!authorityRef ? "Refresh this repository before changing it." : pushAction?.detail}
              onClick={pushActiveRepository}
            >
              <Upload size={12} aria-hidden="true" /><span>{pushAction?.label ?? "Push"}</span>
            </button>
            <button
              type="button"
              disabled={!authorityRef || (pullRequestAction?.disabled ?? true)}
              title={!authorityRef ? "Refresh this repository before changing it." : pullRequestAction?.detail}
              onClick={() => {
                if (!authorityRef) return;
                setPullRequestDialogScope({
                  projectId,
                  conversationId,
                  repositoryPath: activeRepository.repositoryPath,
                  actionRevision: pullRequestActionRevision(activeRepository)!,
                  authorityRef,
                  initialTitle: activeRepository.branch ?? "Pull request",
                  forge: activeRepository.pullRequest?.forge ?? "github",
                });
              }}
            >
              <GitPullRequest size={12} aria-hidden="true" /><span>PR</span>
            </button>
          </span>
        )}
      </div>
    );
  }, [
    activeRepository,
    commitDiffLoading,
    conversationId,
    nestedGitActions,
    onRefresh,
    prepareActiveCommit,
    projectId,
    projectName,
    pushActiveRepository,
    run,
    snapshot,
  ]);

  const navigator = useMemo(() => {
    if (
      !snapshot
      || !activeRepository
      || activeRepository.state === "error"
      || activeRepository.files.length === 0
    ) {
      return undefined;
    }
    const label = workspaceGitRepositoryLabel(
      projectName,
      activeRepository.repositoryPath,
    );
    const stagedFiles = activeRepository.files.filter(
      (file) => file.staged && !file.unstaged,
    );
    const workingFiles = activeRepository.files.filter(
      (file) => !file.staged || file.unstaged,
    );
    const groups = stagedFiles.length > 0
      ? [
          { label: "Staged", files: stagedFiles },
          { label: "Changes", files: workingFiles },
        ]
      : [{ label: null, files: workingFiles }];
    return (
      <nav className="changes-file-list workspace-repository-list" aria-label="Git repositories and changed files">
        <ul className="workspace-repository-files workspace-repository-flat-files" role="list">
          {groups.flatMap((group) => [
            ...(group.label && group.files.length > 0
              ? [<li className="workspace-change-section-heading" key={`heading:${group.label}`}>{group.label}<span>{group.files.length}</span></li>]
              : []),
            ...group.files.map((file) => {
              const language = fileLanguageFromPath(file.path);
              const identity = {
                repositoryPath: activeRepository.repositoryPath,
                filePath: file.path,
              };
              const isSelected = effectiveSelection
                ? workspaceGitIdentity(effectiveSelection) === workspaceGitIdentity(identity)
                : false;
              const parent = file.path.includes("/")
                ? file.path.slice(0, file.path.lastIndexOf("/"))
                : "";
              return (
                <li key={file.path}>
                  <button
                    type="button"
                    className={clsx("workspace-repository-file", isSelected && "is-selected")}
                    aria-current={isSelected ? "true" : undefined}
                    data-language={language.id}
                    data-language-accent={language.accent}
                    onClick={() => setSelected(identity)}
                  >
                    <span className="change-file-leading"><FileCode2 size={14} /><span className="change-file-status">{fileStatus(file)}</span></span>
                    <span className="workspace-repository-file-copy"><strong title={file.path}>{file.path.split("/").at(-1)}</strong>{parent && <small>{parent}</small>}</span>
                    <span className="workspace-repository-file-stats"><small>{fileWorkingState(file)}</small><span><b>+{file.insertions}</b><i>−{file.deletions}</i></span></span>
                  </button>
                  <IconButton
                    label={`Open ${file.path} from ${label}`}
                    onClick={() => onOpenWorkspaceFile(workspaceGitFilePath(identity))}
                  >
                    <ExternalLink size={12} />
                  </IconButton>
                </li>
              );
            }),
          ])}
        </ul>
        {activeRepository.truncated && <p className="workspace-repository-warning">Status is truncated; some changed files are not shown.</p>}
      </nav>
    );
  }, [activeRepository, effectiveSelection, onOpenWorkspaceFile, projectName, snapshot]);

  const compactNavigator = useMemo(() => {
    if (!snapshot || snapshot.files === 0 || !effectiveSelection) return undefined;
    return (
      <div className="changes-file-picker workspace-repository-picker">
        <span>Reviewing</span>
        <select
          aria-label="Repository and changed file"
          value={workspaceGitIdentity(effectiveSelection)}
          onChange={(event) => {
            const identity = parseWorkspaceGitIdentity(event.currentTarget.value, snapshot);
            if (identity) setSelected(identity);
          }}
        >
          {activeRepository?.files.map((file) => {
            const identity = { repositoryPath: activeRepository.repositoryPath, filePath: file.path };
            return (
              <option value={workspaceGitIdentity(identity)} key={workspaceGitIdentity(identity)}>
                {fileStatus(file)} · {file.path}
              </option>
            );
          })}
        </select>
      </div>
    );
  }, [activeRepository, effectiveSelection, snapshot]);

  const notice = (
    <>
      {snapshot?.partial && (
        <div className="panel-notice workspace-repository-notice" role="status">
          <AlertTriangle size={14} />
          <span>
            <strong>{snapshot.truncated ? "Repository discovery was bounded." : "Some repositories could not be read."}</strong>
            {snapshot.discoveredRepositories > snapshot.repositories.length
              ? ` Showing ${snapshot.repositories.length} of ${snapshot.discoveredRepositories} repository roots after scanning ${snapshot.scannedDirectories} folders. Increase this project's repository display limit from its project menu to show more.`
              : snapshot.truncated
                ? ` Scanned ${snapshot.scannedDirectories} folders; depth or directory safety limits left part of the workspace uninspected.`
              : " Available repository changes are still shown."}
          </span>
        </div>
      )}
      {diffError && (
        <div className="panel-notice workspace-repository-notice is-error" role="alert">
          <AlertTriangle size={14} /><span><strong>Diff unavailable.</strong> {diffError}</span>
        </div>
      )}
    </>
  );

  const identify = (selection: DiffSelection): DiffSelection => selectionWithRepository(
    selection,
    activeRepositoryPath ?? ".",
  );
  const allRepositoriesClean = Boolean(
    snapshot?.repositories.length
    && snapshot.repositories.every(
      (repository) => repository.state === "ready" && repository.clean,
    ),
  );
  const activeRepositoryLabel = activeRepository
    ? workspaceGitRepositoryLabel(projectName, activeRepository.repositoryPath)
    : null;
  const emptyState = !snapshot
    ? { title: "Loading repositories", detail: "Looking for Git repositories inside this workspace." }
    : snapshot.repositories.length === 0
      ? { title: "No Git repositories found", detail: "No Git root was found at the project root or within the bounded module scan." }
      : activeRepository?.state === "error"
        ? { title: "Repository unavailable", detail: activeRepository.error ?? "This repository could not be inspected." }
        : activeRepository?.clean && !allRepositoriesClean
          ? { title: `${activeRepositoryLabel ?? "Repository"} is clean`, detail: "Choose another repository scope to inspect its local changes." }
          : { title: "No local changes", detail: "The discovered repositories are clean." };

  return (
    <>
      <ChangesPanel
      {...changesProps}
      files={activeFiles}
      diff={diff}
      selectedPath={effectiveSelection?.filePath ?? null}
      repositoryPath={activeRepositoryPath ?? "."}
      summary={nestedRepository ? null : summary}
      selectionAnswer={selectionAnswer}
      reviewStates={activeReviewStates}
      notes={activeNotes}
      loading={loading || diffLoading}
      lastReversal={
        (lastReversal?.repositoryPath ?? ".") === (activeRepositoryPath ?? ".")
          ? lastReversal
          : null
      }
      fileNavigator={navigator}
      compactFileNavigator={compactNavigator}
      scopeNavigator={scopeNavigator}
      notice={notice}
      headerMetrics={{
        files: snapshot?.files ?? 0,
        repositories: snapshot?.repositories.length ?? 0,
        insertions: snapshot?.insertions ?? 0,
        deletions: snapshot?.deletions ?? 0,
      }}
      emptyState={emptyState}
      diffEmptyState={{
        title: allRepositoriesClean ? "Repositories are clean" : emptyState.title,
        detail: allRepositoriesClean
          ? "There are no modified files to inspect in the discovered repositories."
          : emptyState.detail,
      }}
      capabilities={{
        persistentReview: true,
        agentRevision: !nestedRepository,
        selectiveRevert: true,
      }}
      onSelectFile={(filePath) => {
        if (activeRepositoryPath) setSelected({ repositoryPath: activeRepositoryPath, filePath });
      }}
      onOpenFile={(filePath) => {
        if (activeRepositoryPath) onOpenWorkspaceFile(workspaceGitFilePath({ repositoryPath: activeRepositoryPath, filePath }));
      }}
      onRefresh={onRefresh}
      onGenerateSummary={nestedRepository ? undefined : onGenerateSummary}
      onCancelSummary={nestedRepository ? undefined : onCancelSummary}
      onAsk={(selection, comment) => onAsk(identify(selection), comment)}
      onRequestRevision={(selection, comment) => onRequestRevision(identify(selection), comment)}
      onRevert={(selection, comment) => onRevert(identify(selection), comment)}
      onAddToPrompt={(selection) => {
        const identified = identify(selection);
        const label = workspaceGitRepositoryLabel(projectName, identified.repositoryPath ?? ".");
        onAddToPrompt({ ...identified, reference: `Repository: ${label}\n${identified.reference}` });
      }}
      />
      {commitDialogOpen && activeRepositoryPath && activeRepositoryAuthorityRef && commitGitStatus && run && projectId && (
        <CommitDialog
          open
          repositoryPath={activeRepositoryPath}
          status={commitGitStatus}
          reviewStates={activeReviewStates}
          diff={parsedCommitDiff.structured}
          diffParsing={commitDiffLoading || parsedCommitDiff.parsing}
          diffError={commitDiffError ?? parsedCommitDiff.error}
          busy={busyAction === "git.commit" || busyAction === "git.push"}
          onClose={() => {
            commitDiffRequestRef.current += 1;
            setCommitDialogOpen(false);
            setCommitDiff(null);
            setCommitDiffLoading(false);
            setCommitDiffError(null);
          }}
          onCommit={async (message, push, paths) => {
            if (!commitDiff?.commitReview) {
              throw new Error("The complete reviewed repository state is unavailable. Refresh before committing.");
            }
            const reviewReceipt = commitDiff.commitReview;
            setCommitDiff(null);
            try {
              await run("git.commit", {
                type: "git.commit",
                payload: {
                  projectId,
                  conversationId,
                  repositoryPath: activeRepositoryPath,
                  authorityRef: activeRepositoryAuthorityRef,
                  message,
                  paths,
                  reviewReceipt,
                },
              });
            } catch (error) {
              setCommitDialogOpen(false);
              setCommitDiffError(null);
              throw error;
            }
            if (push) {
              try {
                await run("git.push", {
                  type: "git.push",
                  payload: {
                    projectId,
                    conversationId,
                    repositoryPath: activeRepositoryPath,
                    authorityRef: activeRepositoryAuthorityRef,
                  },
                });
              } catch (error) {
                const partialSuccess = "The commit was created, but push failed. Refresh the repository before retrying the push.";
                setCommitDialogOpen(false);
                setCommitDiffError(null);
                onRefresh();
                if (onActionError) {
                  onActionError(partialSuccess);
                  return;
                }
                throw new Error(partialSuccess, { cause: error });
              }
            }
            setCommitDialogOpen(false);
            setCommitDiffError(null);
            onRefresh();
          }}
        />
      )}
      {pullRequestDialogScope
        && pullRequestDialogScope.projectId === projectId
        && pullRequestDialogScope.conversationId === conversationId
        && pullRequestDialogScope.repositoryPath === activeRepositoryPath
        && pullRequestDialogScope.actionRevision === activePullRequestActionRevision
        && run && (
        <PullRequestDialog
          open
          initialTitle={pullRequestDialogScope.initialTitle}
          busy={busyAction === "git.pr.create" || busyAction === "git.pr.open"}
          projectId={pullRequestDialogScope.projectId}
          conversationId={pullRequestDialogScope.conversationId}
          repositoryPath={pullRequestDialogScope.repositoryPath}
          authorityRef={pullRequestDialogScope.authorityRef}
          forge={pullRequestDialogScope.forge}
          run={run}
          onClose={() => setPullRequestDialogScope(null)}
        />
      )}
    </>
  );
}
