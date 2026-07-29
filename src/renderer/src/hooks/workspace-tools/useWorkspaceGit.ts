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
import { workspaceGitRefreshIdentity } from "../../utils/workspaceGit";

interface WorkspaceGitOptions {
  enabled: boolean;
  loadOnMount: boolean;
  project: Project | null;
  conversation: Conversation | null;
  online: boolean;
  ignoreWhitespace: boolean;
  refreshVersion: number;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  run: (key: string, command: CommandWithoutId) => Promise<ServerEvent>;
  setActionError: (message: string | null) => void;
}

export function useWorkspaceGit({
  project,
  conversation,
  online,
  ignoreWhitespace,
  refreshVersion,
  request,
  run,
  setActionError,
  enabled,
  loadOnMount,
}: WorkspaceGitOptions) {
  const [gitStatus, setGitStatus] = useState<GitStatusSnapshot | null>(null);
  const [gitDiff, setGitDiff] = useState<GitDiffSnapshot | null>(null);
  const [workspaceGitStatus, setWorkspaceGitStatus] =
    useState<WorkspaceGitSnapshot | null>(null);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const projectRefreshIdentity = workspaceGitRefreshIdentity(project);
  const authority = `${project?.id ?? ""}:${conversation?.id ?? ""}`;
  const authorityRef = useRef(authority);
  const requestGenerationRef = useRef(0);
  authorityRef.current = authority;

  const loadGit = useCallback(async () => {
    if (!project?.id) return;
    const owner = `${project.id}:${conversation?.id ?? ""}`;
    const generation = ++requestGenerationRef.current;
    const ownsResponse = (): boolean => (
      authorityRef.current === owner
      && requestGenerationRef.current === generation
    );
    const [event, workspaceEvent] = await Promise.all([
      request({
        type: "git.refresh",
        payload: {
          projectId: project.id,
          conversationId: conversation?.id,
        },
      }).then(resultEvent),
      request({
        type: "git.workspace.refresh",
        payload: {
          projectId: project.id,
          conversationId: conversation?.id,
        },
      }).then(resultEvent),
    ]);
    if (event.result.kind !== "git.status") {
      throw new Error("Unexpected Git response.");
    }
    if (workspaceEvent.result.kind !== "git.workspace.status") {
      throw new Error("Unexpected workspace Git response.");
    }
    if (!ownsResponse()) return;
    setGitStatus(event.result.status);
    setWorkspaceGitStatus(workspaceEvent.result.status);
    if (!event.result.status.isRepository) {
      setGitDiff(null);
      setBranches([]);
      return;
    }
    if (!event.result.status.authorityRef) {
      throw new Error("The Git status authorization is unavailable.");
    }
    const diffEvent = resultEvent(await request({
      type: "git.diff",
      payload: {
        projectId: project.id,
        conversationId: conversation?.id,
        authorityRef: event.result.status.authorityRef,
        ignoreWhitespace,
      },
    }));
    if (ownsResponse() && diffEvent.result.kind === "git.diff") {
      setGitDiff(diffEvent.result.diff);
    }
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
    setWorkspaceGitStatus(null);
    setBranches([]);
    if (
      !enabled
      || !loadOnMount
      || !projectRefreshIdentity
      || !project?.id
      || !online
    ) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void loadGit().catch((error) => {
      if (!cancelled) {
        setActionError(
          error instanceof Error && error.message.trim()
            ? error.message
            : "Git changes could not be loaded.",
        );
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [
    conversation?.id,
    enabled,
    loadGit,
    online,
    loadOnMount,
    project?.id,
    projectRefreshIdentity,
    refreshVersion,
    setActionError,
  ]);

  const loadWorkspaceRepositoryDiff = useCallback(async (
    repositoryPath: string,
    filePath?: string,
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

  const loadBranches = useCallback(() => {
    if (!project || !gitStatus?.isRepository) return;
    const owner = `${project.id}:${conversation?.id ?? ""}`;
    void request({
      type: "git.branches",
      payload: { projectId: project.id },
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

  const mutateBranch = useCallback((
    type: "git.branch.create" | "git.branch.switch",
    name: string,
  ) => {
    if (!project) return;
    void run(type, {
      type,
      payload: { projectId: project.id, name },
    } as CommandWithoutId).then(() =>
      Promise.all([loadGit(), Promise.resolve(loadBranches())])
    ).catch(() => undefined);
  }, [loadBranches, loadGit, project, run]);

  const commit = useCallback(async (
    message: string,
    push: boolean,
    paths: string[],
  ) => {
    if (!project) return;
    if (paths.length === 0) {
      throw new Error("Select at least one path to commit.");
    }
    await run("git.commit", {
      type: "git.commit",
      payload: {
        projectId: project.id,
        conversationId: conversation?.id,
        message,
        paths,
      },
    });
    if (push) {
      await run("git.push", {
        type: "git.push",
        payload: {
          projectId: project.id,
          conversationId: conversation?.id,
        },
      });
    }
    await loadGit();
  }, [conversation?.id, loadGit, project, run]);

  return {
    gitStatus,
    gitDiff,
    setGitDiff,
    workspaceGitStatus,
    branches,
    loading,
    loadGit,
    loadWorkspaceRepositoryDiff,
    loadBranches,
    mutateBranch,
    commit,
  };
}
