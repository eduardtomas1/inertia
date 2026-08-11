import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Conversation,
  GitBranchInfo,
  GitDiffSnapshot,
  GitStatusSnapshot,
  Project,
  ServerEvent,
  WorkspaceGitDiffSnapshot,
  WorkspaceGitSnapshot,
} from "@shared/contracts";
import {
  resultEvent,
  type CommandWithoutId,
} from "../../lib/runtimeCommands";
import {
  rootGitMutationScope,
  type RootGitMutationScope,
  workspaceGitRefreshIdentity,
} from "../../utils/workspaceGit";

interface WorkspaceGitOptions {
  enabled: boolean;
  loadStatusOnMount: boolean;
  loadWorkspaceOnMount: boolean;
  project: Project | null;
  conversation: Conversation | null;
  online: boolean;
  ignoreWhitespace: boolean;
  refreshVersion: number;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  run: (key: string, command: CommandWithoutId) => Promise<ServerEvent>;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  setActionError: (message: string | null) => void;
}

export interface WorkspaceGitLoadOptions {
  authoritative?: boolean;
  scope?: "status" | "workspace";
}

export type LoadWorkspaceGit = (
  options?: WorkspaceGitLoadOptions,
) => Promise<void>;

export function useWorkspaceGit({
  project,
  conversation,
  online,
  ignoreWhitespace,
  refreshVersion,
  request,
  run,
  subscribe,
  setActionError,
  enabled,
  loadStatusOnMount,
  loadWorkspaceOnMount,
}: WorkspaceGitOptions) {
  const [gitStatus, setGitStatus] = useState<GitStatusSnapshot | null>(null);
  const [gitDiff, setGitDiff] = useState<GitDiffSnapshot | null>(null);
  const [workspaceGitStatus, setWorkspaceGitStatus] =
    useState<WorkspaceGitSnapshot | null>(null);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [commitReviewRevision, setCommitReviewRevision] = useState(0);
  const projectRefreshIdentity = workspaceGitRefreshIdentity(project);
  const authority = `${project?.id ?? ""}:${conversation?.id ?? ""}`;
  const authorityRef = useRef(authority);
  const requestGenerationRef = useRef(0);
  const commitReviewRef = useRef<{
    diff: GitDiffSnapshot;
    scope: RootGitMutationScope;
  } | null>(null);
  const loadGitInFlightRef = useRef<{
    identity: string;
    generation: number;
    scope: "status" | "workspace";
    promise: Promise<void>;
  } | null>(null);
  const trailingGitLoadRef = useRef<{
    identity: string;
    generation: number;
    scope: "status" | "workspace";
    promise: Promise<void>;
  } | null>(null);
  authorityRef.current = authority;

  const loadGit = useCallback((
    options?: WorkspaceGitLoadOptions,
  ): Promise<void> => {
    if (!project?.id) return Promise.resolve();
    const scope = options?.scope ?? "workspace";
    if (options?.authoritative) requestGenerationRef.current += 1;
    const owner = `${project.id}:${conversation?.id ?? ""}`;
    const identity = `${owner}:${ignoreWhitespace ? "ignore" : "exact"}`;
    const generation = requestGenerationRef.current;
    const active = loadGitInFlightRef.current;
    if (active?.identity === identity) {
      if (
        active.generation === generation
        && (active.scope === "workspace" || scope === "status")
      ) {
        return active.promise;
      }

      const bypassStaleWorkspaceScan = scope === "status"
        && active.scope === "workspace"
        && active.generation !== generation;
      if (bypassStaleWorkspaceScan) {
        loadGitInFlightRef.current = null;
      } else {
        const queued = trailingGitLoadRef.current;
        if (queued?.identity === identity) {
          queued.generation = generation;
          if (scope === "workspace") queued.scope = scope;
          return queued.promise;
        }

        const trailing = {
          identity,
          generation,
          scope,
          promise: Promise.resolve(),
        };
        trailing.promise = active.promise.catch(() => undefined).then(() => {
          if (trailingGitLoadRef.current !== trailing) return;
          trailingGitLoadRef.current = null;
          if (
            authorityRef.current !== owner
            || requestGenerationRef.current !== trailing.generation
          ) {
            return;
          }
          return loadGit({ scope: trailing.scope });
        });
        trailingGitLoadRef.current = trailing;
        return trailing.promise;
      }
    }

    let promise: Promise<void>;
    promise = (async () => {
      const ownsResponse = (): boolean => (
        authorityRef.current === owner
        && requestGenerationRef.current === generation
      );
      const statusRequest = request({
        type: "git.refresh",
        payload: {
          projectId: project.id,
          conversationId: conversation?.id,
        },
      }).then(resultEvent).then((event) => {
        if (event.result.kind !== "git.status") {
          throw new Error("Unexpected Git response.");
        }
        const status = event.result.status;
        if (ownsResponse()) {
          setGitStatus(status);
          if (!status.isRepository) {
            setGitDiff(null);
            setBranches([]);
          }
        }
        return status;
      });
      const workspaceRequest = scope === "workspace"
        ? request({
            type: "git.workspace.refresh",
            payload: {
              projectId: project.id,
              conversationId: conversation?.id,
            },
          }).then(resultEvent)
        : null;
      const [status, workspaceEvent] = workspaceRequest
        ? await Promise.all([statusRequest, workspaceRequest])
        : [await statusRequest, null];
      if (!ownsResponse()) return;
      if (scope === "status") return;
      if (workspaceEvent?.result.kind !== "git.workspace.status") {
        throw new Error("Unexpected workspace Git response.");
      }
      if (!ownsResponse()) return;
      setWorkspaceGitStatus(workspaceEvent.result.status);
      if (!status.isRepository) return;
      if (!status.authorityRef) {
        throw new Error("The Git status authorization is unavailable.");
      }
      const diffEvent = resultEvent(await request({
        type: "git.diff",
        payload: {
          projectId: project.id,
          conversationId: conversation?.id,
          authorityRef: status.authorityRef,
          ignoreWhitespace,
        },
      }));
      if (ownsResponse() && diffEvent.result.kind === "git.diff") {
        setGitDiff(diffEvent.result.diff);
      }
    })().finally(() => {
      if (loadGitInFlightRef.current?.promise === promise) {
        loadGitInFlightRef.current = null;
      }
    });
    loadGitInFlightRef.current = { identity, generation, scope, promise };
    return promise;
  }, [
    conversation?.id,
    ignoreWhitespace,
    project?.id,
    request,
  ]);

  useEffect(() => {
    requestGenerationRef.current += 1;
    setGitStatus(null);
    setGitDiff(null);
    commitReviewRef.current = null;
    setWorkspaceGitStatus(null);
    setBranches([]);
    setLoading(false);
    setLoadError(null);
  }, [authority, enabled, projectRefreshIdentity]);

  useEffect(() => {
    requestGenerationRef.current += 1;
    if (
      !enabled
      || (!loadStatusOnMount && !loadWorkspaceOnMount)
      || !projectRefreshIdentity
      || !project?.id
      || !online
    ) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void loadGit({
      scope: loadWorkspaceOnMount ? "workspace" : "status",
    }).catch((error) => {
      if (!cancelled) {
        const message = error instanceof Error && error.message.trim()
          ? error.message
          : "Git changes could not be loaded.";
        setLoadError(message);
        setActionError(message);
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    loadGit,
    online,
    loadStatusOnMount,
    loadWorkspaceOnMount,
    project?.id,
    projectRefreshIdentity,
    refreshVersion,
    setActionError,
  ]);

  const loadWorkspaceRepositoryDiff = useCallback(async (
    repositoryPath: string,
    filePath?: string,
    commitReview = false,
  ): Promise<WorkspaceGitDiffSnapshot> => {
    if (!project?.id) {
      throw new Error("Select a project before loading changes.");
    }
    const repository = workspaceGitStatus?.repositories.find(
      (candidate) => candidate.repositoryPath === repositoryPath,
    );
    if (!repository?.authorityRef) {
      throw new Error("Refresh repository status before loading its diff.");
    }
    const event = resultEvent(await run("git.workspace.diff", {
      type: "git.workspace.diff",
      payload: {
        projectId: project.id,
        conversationId: conversation?.id,
        repositoryPath,
        authorityRef: repository.authorityRef,
        ...(filePath ? { path: filePath } : {}),
        ignoreWhitespace,
        ...(commitReview ? { commitReview: true } : {}),
      },
    }));
    if (event.result.kind !== "git.workspace.diff") {
      throw new Error("Unexpected workspace diff response.");
    }
    return event.result.diff;
  }, [
    conversation?.id,
    ignoreWhitespace,
    project?.id,
    run,
    workspaceGitStatus?.repositories,
  ]);

  const loadCommitReview = useCallback(async (): Promise<GitDiffSnapshot | null> => {
    if (!project?.id) {
      throw new Error("Select a project before committing changes.");
    }
    const owner = `${project.id}:${conversation?.id ?? ""}`;
    const generation = requestGenerationRef.current;
    const { requestRootCommitReview } = await import("../../components/CommitDialog");
    const { status, diff } = await requestRootCommitReview({
      projectId: project.id,
      conversationId: conversation?.id,
      ignoreWhitespace,
      request,
    });
    if (
      authorityRef.current !== owner
      || requestGenerationRef.current !== generation
    ) return null;
    setGitStatus(status);
    const scope = rootGitMutationScope(status);
    if (!scope) {
      throw new Error("Refresh repository status before committing changes.");
    }
    commitReviewRef.current = { diff, scope };
    return diff;
  }, [conversation?.id, ignoreWhitespace, project?.id, request]);

  const discardCommitReview = useCallback((): void => {
    commitReviewRef.current = null;
  }, []);

  const loadBranches = useCallback(() => {
    if (!project || !gitStatus?.isRepository) return;
    const owner = `${project.id}:${conversation?.id ?? ""}`;
    void request({
      type: "git.branches",
      payload: {
        projectId: project.id,
        conversationId: conversation?.id,
      },
    }).then(resultEvent).then((event) => {
      if (
        authorityRef.current === owner
        && event.result.kind === "git.branches"
      ) {
        setBranches(event.result.branches);
      }
    }).catch((error) => {
      setActionError(
        error instanceof Error
          ? error.message
          : "Branches could not be loaded.",
      );
    });
  }, [
    conversation?.id,
    gitStatus?.isRepository,
    project,
    request,
    setActionError,
  ]);

  useEffect(() => subscribe((event) => {
    if (
      event.type !== "workspace.git.invalidated"
      || !enabled
      || !online
      || !project?.id
      || event.projectId !== project.id
      || event.conversationId !== (conversation?.id ?? null)
    ) return;
    commitReviewRef.current = null;
    setCommitReviewRevision((current) => current + 1);
    setLoading(true);
    setLoadError(null);
    const owner = `${project.id}:${conversation?.id ?? ""}`;
    const refresh = loadGit({
      authoritative: true,
      scope: loadWorkspaceOnMount ? "workspace" : "status",
    });
    const generation = requestGenerationRef.current;
    void refresh.then(() => {
      if (
        authorityRef.current !== owner
        || requestGenerationRef.current !== generation
      ) return;
      loadBranches();
    }).catch((error) => {
      if (
        authorityRef.current !== owner
        || requestGenerationRef.current !== generation
      ) return;
      const message = error instanceof Error && error.message.trim()
        ? error.message
        : "Git changes could not be reconciled.";
      setLoadError(message);
      setActionError(message);
    }).finally(() => {
      if (
        authorityRef.current === owner
        && requestGenerationRef.current === generation
      ) setLoading(false);
    });
  }), [
    conversation?.id,
    enabled,
    loadBranches,
    loadGit,
    loadWorkspaceOnMount,
    online,
    project?.id,
    setActionError,
    subscribe,
  ]);

  const mutateBranch = useCallback((
    type: "git.branch.create" | "git.branch.switch",
    name: string,
  ) => {
    if (!project) return;
    const repository = rootGitMutationScope(gitStatus);
    if (!repository) {
      setActionError("Refresh repository status before changing branches.");
      return;
    }
    void run(type, {
      type,
      payload: {
        projectId: project.id,
        conversationId: conversation?.id,
        ...repository,
        name,
      },
    } as CommandWithoutId).catch(() => undefined);
  }, [conversation?.id, gitStatus, project, run, setActionError]);

  const commit = useCallback(async (
    message: string,
    push: boolean,
    paths: string[],
  ) => {
    if (!project) return;
    if (paths.length === 0) {
      throw new Error("Select at least one path to commit.");
    }
    const reviewed = commitReviewRef.current;
    if (reviewed?.diff.truncated || !reviewed?.diff.commitReview) {
      throw new Error(
        "The complete reviewed repository state is unavailable. Refresh the diff before committing.",
      );
    }
    commitReviewRef.current = null;
    await run("git.commit", {
      type: "git.commit",
      payload: {
        projectId: project.id,
        conversationId: conversation?.id,
        ...reviewed.scope,
        message,
        paths,
        reviewReceipt: reviewed.diff.commitReview,
      },
    });
    if (push) {
      try {
        const owner = `${project.id}:${conversation?.id ?? ""}`;
        const refreshed = resultEvent(await request({
          type: "git.refresh",
          payload: {
            projectId: project.id,
            conversationId: conversation?.id,
          },
        }));
        if (
          authorityRef.current !== owner
          || refreshed.result.kind !== "git.status"
        ) {
          throw new Error("Repository status changed before push.");
        }
        const pushRepository = rootGitMutationScope(refreshed.result.status);
        if (!pushRepository) {
          throw new Error("A fresh repository status is unavailable.");
        }
        setGitStatus(refreshed.result.status);
        await run("git.push", {
          type: "git.push",
          payload: {
            projectId: project.id,
            conversationId: conversation?.id,
            ...pushRepository,
          },
        });
      } catch (error) {
        setActionError(
          `The commit was created, but push failed. ${error instanceof Error && error.message.trim()
            ? error.message
            : "Refresh Git status before retrying the push."}`,
        );
      }
    }
  }, [conversation?.id, project, request, run, setActionError]);

  return {
    gitStatus,
    gitDiff,
    setGitDiff,
    workspaceGitStatus,
    branches,
    loading,
    loadError,
    loadGit,
    loadWorkspaceRepositoryDiff,
    loadCommitReview,
    discardCommitReview,
    commitReviewRevision,
    loadBranches,
    mutateBranch,
    commit,
  };
}
