import { describe, expect, it } from "vitest";

import {
  buildEnvironmentSummary,
} from "../../src/renderer/src/utils/environmentSummary";
import type {
  ChatMessage,
  SubagentTrace,
  WorkspaceGitSnapshot,
  WorkspaceRun,
} from "../../src/shared/contracts";

const now = "2026-07-28T12:00:00.000Z";

function run(
  update: Partial<WorkspaceRun> = {},
): WorkspaceRun {
  return {
    id: crypto.randomUUID(),
    kind: "check",
    projectId: "project-1",
    conversationId: "conversation-1",
    actionId: null,
    label: "Typecheck",
    detail: null,
    status: "running",
    attentionState: "acknowledged",
    canStop: true,
    port: null,
    startedAt: now,
    finishedAt: null,
    ...update,
  };
}

function subagent(
  update: Partial<SubagentTrace> = {},
): SubagentTrace {
  const status = update.status ?? "running";
  return {
    id: crypto.randomUUID(),
    conversationId: "conversation-1",
    runId: "run-1",
    turnId: "turn-1",
    providerId: "codex",
    providerTaskId: "task-1",
    providerAgentId: null,
    parentTraceId: null,
    parentProviderAgentId: null,
    parentProviderToolUseId: null,
    providerToolUseId: null,
    providerRole: "reviewer",
    providerName: "Review",
    providerStatus: null,
    status,
    isLive: update.isLive ?? [
      "queued", "spawned", "running", "waiting",
    ].includes(status),
    description: null,
    progress: null,
    result: null,
    sequence: 1,
    createdAt: now,
    updatedAt: now,
    ...update,
  };
}

function message(
  id: string,
  name: string,
  createdAt: string,
): ChatMessage {
  return {
    id,
    conversationId: "conversation-1",
    turnId: `turn-${id}`,
    role: "user",
    content: "Review this.",
    attachments: [{
      id: `attachment-${id}`,
      name,
      path: `/private/${name}`,
      mimeType: name.endsWith(".pdf") ? "application/pdf" : "image/png",
      size: 128,
    }],
    createdAt,
  };
}

describe("environment summary projection", () => {
  it("uses truthful workspace-wide changes and only current active work", () => {
    const workspaceGitStatus: WorkspaceGitSnapshot = {
      repositories: [{
        repositoryPath: ".",
        state: "ready",
        error: null,
        branch: "codex/summary",
        upstream: null,
        ahead: 0,
        behind: 0,
        hasRemote: true,
        files: [],
        insertions: 9,
        deletions: 4,
        clean: false,
        truncated: false,
      }],
      files: 2,
      insertions: 9,
      deletions: 4,
      scannedDirectories: 1,
      skippedDirectories: 0,
      discoveredRepositories: 1,
      repositoryLimit: 128,
      partial: false,
      truncated: false,
      issues: [],
    };

    const summary = buildEnvironmentSummary({
      projectId: "project-1",
      projectName: "Inertia",
      conversationId: "conversation-1",
      connectionStatus: "online",
      gitStatus: null,
      workspaceGitStatus,
      runs: [
        run(),
        run({ id: "old", status: "succeeded", finishedAt: now }),
        run({ id: "other", projectId: "project-2" }),
        run({
          id: "failed",
          status: "failed",
          attentionState: "unseen",
          finishedAt: now,
        }),
      ],
      subagents: [
        subagent(),
        subagent({ id: "done", status: "completed" }),
        subagent({ id: "other-agent", conversationId: "conversation-2" }),
      ],
      messages: [
        message("old", "old.png", "2026-07-28T10:00:00.000Z"),
        message("new", "notes.pdf", "2026-07-28T11:00:00.000Z"),
      ],
      projectPath: "/workspace/inertia",
      repositoryRoot: "/workspace/inertia",
      worktreePath: "/workspace/worktrees/environment-panel",
      localServerUrl: "http://localhost:4173/app",
    });

    expect(summary.runtime).toEqual({ status: "online" });
    expect(summary.changes).toEqual({
      files: 2,
      insertions: 9,
      deletions: 4,
      repositories: 1,
    });
    expect(summary.branch).toEqual({
      label: "Branch",
      value: "codex/summary",
    });
    expect(summary.workspace).toEqual({
      label: "Worktree",
      value: "environment-panel",
      path: "/workspace/worktrees/environment-panel",
    });
    expect(summary.repository).toEqual({
      name: "inertia",
      path: "/workspace/inertia",
    });
    expect(summary.localServers).toEqual([{
      url: "http://localhost:4173",
    }]);
    expect(summary.checks).toHaveLength(2);
    expect(summary.checks.map(({ id }) => id)).toContain("failed");
    expect(summary.subagents).toHaveLength(1);
    expect(summary.attachments.map(({ name }) => name))
      .toEqual(["notes.pdf", "old.png"]);
    expect(JSON.stringify(summary)).not.toContain("/private/");
  });

  it("does not invent workspace details before they are available", () => {
    const summary = buildEnvironmentSummary({
      projectId: null,
      projectName: null,
      conversationId: null,
      connectionStatus: "connecting",
      gitStatus: null,
      workspaceGitStatus: null,
      runs: [],
      subagents: [],
      messages: [],
    });

    expect(summary).toMatchObject({
      projectName: null,
      runtime: { status: "connecting" },
      changes: null,
      branch: null,
      checks: [],
      subagents: [],
      attachments: [],
      workspace: null,
      repository: null,
      localServers: [],
      gitState: "unavailable",
    });
  });

  it("identifies a detached repository without inventing a branch name", () => {
    const summary = buildEnvironmentSummary({
      projectId: "project-1",
      projectName: "Inertia",
      conversationId: "conversation-1",
      connectionStatus: "online",
      gitStatus: {
        isRepository: true,
        root: "/workspace/inertia",
        branch: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        hasRemote: false,
        files: [],
        insertions: 0,
        deletions: 0,
      },
      workspaceGitStatus: null,
      runs: [],
      subagents: [],
      messages: [],
    });

    expect(summary.branch).toEqual({ label: "Branch", value: "Detached HEAD" });
  });

  it("keeps mixed multi-repository branch state explicit", () => {
    const summary = buildEnvironmentSummary({
      projectId: "project-1",
      projectName: "Inertia",
      conversationId: "conversation-1",
      connectionStatus: "online",
      gitStatus: null,
      workspaceGitStatus: {
        repositories: [{
          repositoryPath: ".",
          state: "ready",
          error: null,
          branch: "main",
          upstream: null,
          ahead: 0,
          behind: 0,
          hasRemote: false,
          files: [],
          insertions: 0,
          deletions: 0,
          clean: true,
          truncated: false,
        }, {
          repositoryPath: "packages/feature",
          state: "ready",
          error: null,
          branch: null,
          upstream: null,
          ahead: 0,
          behind: 0,
          hasRemote: false,
          files: [],
          insertions: 0,
          deletions: 0,
          clean: true,
          truncated: false,
        }],
        files: 0,
        insertions: 0,
        deletions: 0,
        scannedDirectories: 2,
        skippedDirectories: 0,
        discoveredRepositories: 2,
        repositoryLimit: 128,
        partial: false,
        truncated: false,
        issues: [],
      },
      runs: [],
      subagents: [],
      messages: [],
    });

    expect(summary.branch).toEqual({
      label: "Branches",
      value: "2 repositories",
    });
  });

  it("keeps provisional root changes loading and preserves refresh failures", () => {
    const input = {
      projectId: "project-1",
      projectName: "Inertia",
      conversationId: "conversation-1",
      connectionStatus: "online" as const,
      gitStatus: {
        isRepository: true,
        root: "/workspace/inertia",
        branch: "main",
        upstream: null,
        ahead: 0,
        behind: 0,
        hasRemote: false,
        files: [],
        insertions: 0,
        deletions: 0,
      },
      workspaceGitStatus: null,
      runs: [],
      subagents: [],
      messages: [],
    };

    const loading = buildEnvironmentSummary({ ...input, gitLoading: true });
    expect(loading.changes).toMatchObject({ files: 0, repositories: 1 });
    expect(loading.gitState).toBe("loading");

    const failed = buildEnvironmentSummary({
      ...input,
      gitError: "Workspace scan timed out.",
    });
    expect(failed.changes).toMatchObject({ files: 0, repositories: 1 });
    expect(failed.gitState).toBe("error");
    expect(failed.gitNotice).toBe("Workspace scan timed out.");
  });

  it("does not present remote preview URLs as local servers", () => {
    const summary = buildEnvironmentSummary({
      projectId: "project-1",
      projectName: "Inertia",
      conversationId: "conversation-1",
      connectionStatus: "online",
      gitStatus: null,
      workspaceGitStatus: null,
      runs: [],
      subagents: [],
      messages: [],
      localServerUrl: "https://preview.example.com/app",
    });

    expect(summary.localServers).toEqual([]);
  });

  it("does not report a clean tree when no repository was discovered", () => {
    const summary = buildEnvironmentSummary({
      projectId: "project-1",
      projectName: "Inertia",
      conversationId: "conversation-1",
      connectionStatus: "online",
      gitStatus: null,
      workspaceGitStatus: {
        repositories: [],
        files: 0,
        insertions: 0,
        deletions: 0,
        scannedDirectories: 1,
        skippedDirectories: 0,
        discoveredRepositories: 0,
        repositoryLimit: 128,
        partial: false,
        truncated: false,
        issues: [],
      },
      runs: [],
      subagents: [],
      messages: [],
    });

    expect(summary.changes).toBeNull();
    expect(summary.gitState).toBe("unavailable");
  });

  it("reports an unavailable repository scan as an error instead of a clean tree", () => {
    const summary = buildEnvironmentSummary({
      projectId: "project-1",
      projectName: "Inertia",
      conversationId: "conversation-1",
      connectionStatus: "online",
      gitStatus: null,
      workspaceGitStatus: {
        repositories: [{
          repositoryPath: ".",
          state: "error",
          error: "Permission denied.",
          branch: null,
          upstream: null,
          ahead: 0,
          behind: 0,
          hasRemote: false,
          files: [],
          insertions: 0,
          deletions: 0,
          clean: false,
          truncated: false,
        }],
        files: 0,
        insertions: 0,
        deletions: 0,
        scannedDirectories: 1,
        skippedDirectories: 0,
        discoveredRepositories: 1,
        repositoryLimit: 128,
        partial: true,
        truncated: false,
        issues: [],
      },
      runs: [],
      subagents: [],
      messages: [],
    });

    expect(summary.changes).toBeNull();
    expect(summary.gitState).toBe("error");
    expect(summary.gitNotice).toBe("Permission denied.");
  });

  it("counts only successfully inspected repositories in a partial scan", () => {
    const summary = buildEnvironmentSummary({
      projectId: "project-1",
      projectName: "Inertia",
      conversationId: "conversation-1",
      connectionStatus: "online",
      gitStatus: null,
      workspaceGitStatus: {
        repositories: [{
          repositoryPath: ".",
          state: "ready",
          error: null,
          branch: "main",
          upstream: null,
          ahead: 0,
          behind: 0,
          hasRemote: false,
          files: [],
          insertions: 0,
          deletions: 0,
          clean: true,
          truncated: false,
        }, {
          repositoryPath: "modules/private",
          state: "error",
          error: "Permission denied.",
          branch: null,
          upstream: null,
          ahead: 0,
          behind: 0,
          hasRemote: false,
          files: [],
          insertions: 0,
          deletions: 0,
          clean: false,
          truncated: false,
        }],
        files: 0,
        insertions: 0,
        deletions: 0,
        scannedDirectories: 2,
        skippedDirectories: 0,
        discoveredRepositories: 2,
        repositoryLimit: 128,
        partial: true,
        truncated: false,
        issues: [],
      },
      runs: [],
      subagents: [],
      messages: [],
    });

    expect(summary.changes).toMatchObject({ repositories: 1, files: 0 });
    expect(summary.gitState).toBe("ready");
    expect(summary.gitNotice).toBe("Permission denied.");
  });

  it("keeps a message-less repository failure distinct from no repository", () => {
    const summary = buildEnvironmentSummary({
      projectId: "project-1",
      projectName: "Inertia",
      conversationId: "conversation-1",
      connectionStatus: "online",
      gitStatus: null,
      workspaceGitStatus: {
        repositories: [{
          repositoryPath: ".",
          state: "error",
          error: null,
          branch: null,
          upstream: null,
          ahead: 0,
          behind: 0,
          hasRemote: false,
          files: [],
          insertions: 0,
          deletions: 0,
          clean: false,
          truncated: false,
        }],
        files: 0,
        insertions: 0,
        deletions: 0,
        scannedDirectories: 1,
        skippedDirectories: 0,
        discoveredRepositories: 1,
        repositoryLimit: 128,
        partial: true,
        truncated: false,
        issues: [],
      },
      runs: [],
      subagents: [],
      messages: [],
    });

    expect(summary.changes).toBeNull();
    expect(summary.gitState).toBe("error");
    expect(summary.gitNotice).toBeNull();
  });

  it("treats a workspace scan issue without a repository result as an error", () => {
    const summary = buildEnvironmentSummary({
      projectId: "project-1",
      projectName: "Inertia",
      conversationId: "conversation-1",
      connectionStatus: "online",
      gitStatus: null,
      workspaceGitStatus: {
        repositories: [],
        files: 0,
        insertions: 0,
        deletions: 0,
        scannedDirectories: 0,
        skippedDirectories: 1,
        discoveredRepositories: 0,
        repositoryLimit: 128,
        partial: true,
        truncated: false,
        issues: [{
          repositoryPath: ".",
          message: "Directory could not be read.",
        }],
      },
      runs: [],
      subagents: [],
      messages: [],
    });

    expect(summary.changes).toBeNull();
    expect(summary.gitState).toBe("error");
    expect(summary.gitNotice).toBe("Directory could not be read.");
  });

  it("recognizes an IPv6 loopback preview without exposing its path", () => {
    const summary = buildEnvironmentSummary({
      projectId: "project-1",
      projectName: "Inertia",
      conversationId: "conversation-1",
      connectionStatus: "online",
      gitStatus: null,
      workspaceGitStatus: null,
      runs: [],
      subagents: [],
      messages: [],
      localServerUrl: "http://[::1]:3000/private?token=hidden",
    });

    expect(summary.localServers).toEqual([{
      url: "http://[::1]:3000",
    }]);
  });

  it("derives compact workspace labels from Windows paths", () => {
    const summary = buildEnvironmentSummary({
      projectId: "project-1",
      projectName: "Inertia",
      conversationId: "conversation-1",
      connectionStatus: "online",
      gitStatus: null,
      workspaceGitStatus: null,
      runs: [],
      subagents: [],
      messages: [],
      projectPath: "C:\\Users\\Ada\\Inertia\\",
      repositoryRoot: "C:\\Users\\Ada\\Inertia\\",
      worktreePath: "C:\\Users\\Ada\\worktrees\\environment-panel\\",
    });

    expect(summary.workspace).toMatchObject({
      label: "Worktree",
      value: "environment-panel",
    });
    expect(summary.repository).toMatchObject({ name: "Inertia" });
  });

  it("uses the authoritative live bit for queued and future provider states", () => {
    const summary = buildEnvironmentSummary({
      projectId: "project-1",
      projectName: "Inertia",
      conversationId: "conversation-1",
      connectionStatus: "online",
      gitStatus: null,
      workspaceGitStatus: null,
      runs: [],
      subagents: [
        subagent({ id: "queued", status: "queued", isLive: true }),
        subagent({ id: "future", status: "unknown", isLive: true }),
        subagent({ id: "stale-running", status: "running", isLive: false }),
      ],
      messages: [],
    });

    expect(summary.subagents.map(({ id }) => id)).toEqual([
      "queued",
      "future",
    ]);
  });
});
