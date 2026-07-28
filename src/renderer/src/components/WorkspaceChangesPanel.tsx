import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  ExternalLink,
  FileCode2,
  FolderGit2,
  GitBranch,
} from "lucide-react";

import type {
  ChangedFile,
  DiffReviewNote,
  DiffReviewState,
  WorkspaceGitDiffSnapshot,
  WorkspaceGitRepositorySnapshot,
  WorkspaceGitSnapshot,
} from "@shared/contracts";
import {
  firstWorkspaceGitFile,
  parseWorkspaceGitIdentity,
  workspaceGitFile,
  workspaceGitFilePath,
  workspaceGitIdentity,
  workspaceGitRepositoryLabel,
  workspaceGitRepositoryPresentation,
  type WorkspaceGitFileIdentity,
} from "../utils/workspaceGit";
import {
  ChangesPanel,
  type ChangesPanelProps,
  type DiffSelection,
} from "./ChangesPanel";
import { IconButton } from "./ui";

type ForwardedChangesProps = Omit<
  ChangesPanelProps,
  | "files"
  | "diff"
  | "selectedPath"
  | "loading"
  | "fileNavigator"
  | "compactFileNavigator"
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
  ) => Promise<WorkspaceGitDiffSnapshot>;
  onOpenWorkspaceFile: (path: string) => void;
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
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [diff, setDiff] = useState<WorkspaceGitDiffSnapshot | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const selectedEntry = snapshot ? workspaceGitFile(snapshot, selected) : null;
  const firstSelection = snapshot ? firstWorkspaceGitFile(snapshot) : null;
  const effectiveSelection = selectedEntry ? selected : firstSelection;
  const effectiveEntry = snapshot ? workspaceGitFile(snapshot, effectiveSelection) : null;
  const activeRepository = effectiveEntry?.repository ?? null;
  const activeRepositoryPath = activeRepository?.repositoryPath ?? null;
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

  useEffect(() => {
    if (!effectiveSelection) {
      setDiff(null);
      setDiffError(null);
      return;
    }
    if (selected === null || workspaceGitIdentity(selected) !== workspaceGitIdentity(effectiveSelection)) {
      setSelected(effectiveSelection);
    }
    setExpanded((current) => {
      if (current.has(effectiveSelection.repositoryPath)) return current;
      const next = new Set(current);
      next.add(effectiveSelection.repositoryPath);
      return next;
    });
  }, [effectiveSelection, selected]);

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
      return;
    }
    let cancelled = false;
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

  const navigator = useMemo(() => {
    if (!snapshot || snapshot.repositories.length === 0) return undefined;
    return (
      <nav className="changes-file-list workspace-repository-list" aria-label="Git repositories and changed files">
        <ul role="list">
          {snapshot.repositories.map((repository) => {
            const label = workspaceGitRepositoryLabel(projectName, repository.repositoryPath);
            const presentation = workspaceGitRepositoryPresentation(
              projectName,
              repository.repositoryPath,
            );
            const isExpanded = expanded.has(repository.repositoryPath);
            return (
              <li className={clsx("workspace-repository-group", repository.state === "error" && "has-error")} key={repository.repositoryPath}>
                <details
                  aria-label={`${label} repository`}
                  open={isExpanded}
                  onToggle={(event) => {
                    const open = event.currentTarget.open;
                    setExpanded((current) => {
                      const next = new Set(current);
                      if (open) next.add(repository.repositoryPath);
                      else next.delete(repository.repositoryPath);
                      return next;
                    });
                  }}
                >
                  <summary>
                    <span className="workspace-repository-name">
                      <FolderGit2 size={15} aria-hidden="true" />
                      <span>
                        <strong className="workspace-repository-title" title={label}>
                          {presentation.prefix && (
                            <span className="workspace-repository-title-prefix">
                              {presentation.prefix}
                            </span>
                          )}
                          <span className="workspace-repository-title-suffix">
                            {presentation.suffix}
                          </span>
                        </strong>
                        <small title={presentation.location}>{presentation.location}</small>
                      </span>
                    </span>
                    <span className="workspace-repository-summary">
                      {repository.branch && <span><GitBranch size={11} aria-hidden="true" />{repository.branch}</span>}
                      <span>{repositoryStatus(repository)}</span>
                      {!repository.clean && repository.state === "ready" && (
                        <span aria-label={`${repository.insertions} insertions and ${repository.deletions} deletions`}>
                          <b>+{repository.insertions}</b><i>−{repository.deletions}</i>
                        </span>
                      )}
                    </span>
                  </summary>
                  {repository.state === "error" ? (
                    <p className="workspace-repository-error"><AlertTriangle size={13} />{repository.error}</p>
                  ) : repository.files.length === 0 ? (
                    <p className="workspace-repository-clean">No local changes</p>
                  ) : (
                    <ul className="workspace-repository-files" role="list">
                      {repository.files.map((file) => {
                        const identity = { repositoryPath: repository.repositoryPath, filePath: file.path };
                        const identityKey = workspaceGitIdentity(identity);
                        const isSelected = effectiveSelection
                          ? workspaceGitIdentity(effectiveSelection) === identityKey
                          : false;
                        return (
                          <li key={file.path}>
                            <button
                              type="button"
                              className={clsx("workspace-repository-file", isSelected && "is-selected")}
                              aria-current={isSelected ? "true" : undefined}
                              onClick={() => setSelected(identity)}
                            >
                              <span className="change-file-leading"><FileCode2 size={14} /><span className="change-file-status">{fileStatus(file)}</span></span>
                              <span className="workspace-repository-file-copy"><strong title={file.path}>{file.path.split("/").at(-1)}</strong><small>{file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : label}</small></span>
                              <span className="workspace-repository-file-stats"><b>+{file.insertions}</b><i>−{file.deletions}</i></span>
                            </button>
                            <IconButton
                              label={`Open ${file.path} from ${label}`}
                              onClick={() => onOpenWorkspaceFile(workspaceGitFilePath(identity))}
                            >
                              <ExternalLink size={12} />
                            </IconButton>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {repository.truncated && <p className="workspace-repository-warning">Status is truncated; some changed files are not shown.</p>}
                </details>
              </li>
            );
          })}
        </ul>
      </nav>
    );
  }, [effectiveSelection, expanded, onOpenWorkspaceFile, projectName, snapshot]);

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
          {snapshot.repositories.flatMap((repository) => repository.files.map((file) => {
            const identity = { repositoryPath: repository.repositoryPath, filePath: file.path };
            return (
              <option value={workspaceGitIdentity(identity)} key={workspaceGitIdentity(identity)}>
                {workspaceGitRepositoryLabel(projectName, repository.repositoryPath)} — {fileStatus(file)} · {file.path}
              </option>
            );
          }))}
        </select>
      </div>
    );
  }, [effectiveSelection, projectName, snapshot]);

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
      {nestedRepository && (
        <div className="panel-notice workspace-repository-notice">
          <FolderGit2 size={14} />
          <span><strong>Reviewing {activeRepositoryPath}.</strong> Questions, prompt references, review marks, local notes, and selective revert keep this repository identity. Agent summaries and revisions remain available only for the project-root repository because their recovery checkpoints cover that root.</span>
        </div>
      )}
    </>
  );

  const identify = (selection: DiffSelection): DiffSelection => selectionWithRepository(
    selection,
    activeRepositoryPath ?? ".",
  );
  const emptyState = !snapshot
    ? { title: "Loading repositories", detail: "Looking for Git repositories inside this workspace." }
    : snapshot.repositories.length === 0
      ? { title: "No Git repositories found", detail: "No Git root was found at the project root or within the bounded module scan." }
      : { title: "No local changes", detail: "The discovered repositories are clean." };
  const allRepositoriesClean = Boolean(
    snapshot?.repositories.length
    && snapshot.repositories.every(
      (repository) => repository.state === "ready" && repository.clean,
    ),
  );

  return (
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
  );
}
