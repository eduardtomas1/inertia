import { describe, expect, it } from "vitest";

import { buildEnvironmentSummary } from "../../src/renderer/src/utils/environmentSummary";
import type {
  ChatMessage,
  ProviderInfo,
  SubagentTrace,
  ThreadUsageSnapshot,
  WorkspaceGitSnapshot,
  WorkspaceRun,
} from "../../src/shared/contracts";

const now = "2026-08-12T12:00:00.000Z";

function run(update: Partial<WorkspaceRun> = {}): WorkspaceRun {
  return {
    id: "check-1",
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

function subagent(update: Partial<SubagentTrace> = {}): SubagentTrace {
  const status = update.status ?? "running";
  return {
    id: "trace-1",
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
    isLive: update.isLive ?? ["queued", "spawned", "running", "waiting"].includes(status),
    description: null,
    progress: null,
    result: null,
    sequence: 1,
    createdAt: now,
    updatedAt: now,
    ...update,
  };
}

function message(id: string, name: string): ChatMessage {
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
    createdAt: now,
  };
}

function provider(
  update: Partial<ProviderInfo> = {},
): ProviderInfo {
  return {
    id: "codex",
    label: "Codex",
    command: "codex",
    available: true,
    version: "1.0.0",
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    statusMessage: null,
    models: [],
    rateLimits: [{
      id: "five-hour",
      label: "Five-hour limit",
      usedPercent: 36,
      remainingPercent: 64,
      windowMinutes: 300,
      resetsAt: "2026-08-12T15:00:00.000Z",
    }],
    metadataState: {
      models: {
        freshness: "fresh",
        provenance: "provider",
        updatedAt: now,
        lastAttemptedAt: now,
        refreshing: false,
      },
      rateLimits: {
        freshness: "fresh",
        provenance: "provider",
        updatedAt: now,
        lastAttemptedAt: now,
        refreshing: false,
      },
    },
    ...update,
  };
}

function usage(update: Partial<ThreadUsageSnapshot> = {}): ThreadUsageSnapshot {
  return {
    conversationId: "conversation-1",
    turnId: "turn-1",
    usedTokens: 28_000,
    totalProcessedTokens: 42_000,
    totalProcessedScope: "thread",
    maxTokens: 100_000,
    inputTokens: 20_000,
    cachedInputTokens: 4_000,
    cacheWriteInputTokens: null,
    outputTokens: 4_000,
    reasoningOutputTokens: null,
    compactsAutomatically: true,
    updatedAt: now,
    ...update,
  };
}

function workspaceGit(
  update: Partial<WorkspaceGitSnapshot> = {},
): WorkspaceGitSnapshot {
  return {
    repositories: [{
      repositoryPath: ".",
      authorityRef: "root-authority",
      state: "ready",
      error: null,
      branch: "codex/environment",
      upstream: "origin/codex/environment",
      ahead: 1,
      behind: 0,
      hasRemote: true,
      pullRequest: {
        available: true,
        remoteName: "origin",
        forge: "github",
        unavailableReason: null,
      },
      files: [{
        path: "src/App.tsx",
        status: "modified",
        insertions: 9,
        deletions: 4,
        untracked: false,
        staged: false,
        unstaged: true,
        indexStatus: " ",
        worktreeStatus: "M",
      }],
      insertions: 9,
      deletions: 4,
      clean: false,
      truncated: false,
    }],
    files: 1,
    insertions: 9,
    deletions: 4,
    scannedDirectories: 1,
    skippedDirectories: 0,
    discoveredRepositories: 1,
    repositoryLimit: 128,
    partial: false,
    truncated: false,
    issues: [],
    ...update,
  };
}

const owners = {
  projects: [
    { id: "project-1", name: "Inertia", path: "/workspace/inertia" },
    { id: "project-2", name: "Docs", path: "/workspace/docs" },
  ],
  conversations: [
    {
      id: "conversation-1",
      projectId: "project-1",
      title: "Primary chat",
      branch: "main",
      worktreePath: null,
    },
    {
      id: "conversation-2",
      projectId: "project-2",
      title: "Docs chat",
      branch: "docs/preview",
      worktreePath: "/workspace/.inertia/worktrees/docs-preview",
    },
  ],
};

describe("environment summary projection", () => {
  it("projects real workspace, Git, attachments, active work, and validated services", () => {
    const summary = buildEnvironmentSummary({
      projectId: "project-1",
      projectName: "Inertia",
      conversationId: "conversation-1",
      connectionStatus: "online",
      gitStatus: null,
      workspaceGitStatus: workspaceGit(),
      runs: [
        run(),
        run({
          id: "preview",
          kind: "service",
          label: "Preview",
          port: 4173,
        }),
        run({
          id: "settled",
          status: "succeeded",
          canStop: false,
          finishedAt: now,
        }),
      ],
      subagents: [subagent(), subagent({ id: "done", status: "completed" })],
      messages: [message("old", "old.png"), message("new", "notes.pdf")],
      projectPath: "/workspace/inertia",
      worktreePath: "/workspace/worktrees/environment-panel",
      ...owners,
    });

    expect(summary.runtime).toEqual({ status: "online" });
    expect(summary.changes).toEqual({
      files: 1,
      insertions: 9,
      deletions: 4,
      repositories: 1,
    });
    expect(summary.branch).toEqual({
      label: "Branch",
      value: "codex/environment",
    });
    expect(summary.workspace).toEqual({
      label: "Worktree",
      value: "environment-panel",
      path: "/workspace/worktrees/environment-panel",
    });
    expect(summary.checks.map(({ id }) => id)).toEqual(["check-1"]);
    expect(summary.localServers).toMatchObject([{
      id: "preview",
      url: "http://127.0.0.1:4173",
      canOpenPreview: true,
    }]);
    expect(summary.subagents).toHaveLength(1);
    expect(summary.attachments.map(({ name }) => name))
      .toEqual(["notes.pdf", "old.png"]);
    expect(JSON.stringify(summary)).not.toContain("/private/");
  });

  it("never derives Local Servers from remembered URLs or invalid service ports", () => {
    const summary = buildEnvironmentSummary({
      projectId: "project-1",
      projectName: "Inertia",
      conversationId: "conversation-1",
      connectionStatus: "online",
      gitStatus: null,
      workspaceGitStatus: null,
      runs: [
        run({ id: "valid", kind: "service", port: 4173 }),
        run({ id: "invalid", kind: "service", port: 70_000 }),
        run({
          id: "finished",
          kind: "service",
          port: 3000,
          status: "succeeded",
          canStop: false,
          finishedAt: now,
        }),
        run({
          id: "missing-owner",
          kind: "service",
          conversationId: "missing",
          port: 8080,
        }),
      ],
      subagents: [],
      messages: [],
      ...owners,
    });

    expect(summary.localServers.map(({ id }) => id))
      .toEqual(["valid", "missing-owner"]);
    expect(summary.localServers.find(({ id }) => id === "valid")?.canOpenPreview)
      .toBe(true);
    expect(summary.localServers.find(({ id }) => id === "missing-owner")?.canOpenPreview)
      .toBe(false);
    expect(summary.checks.find(({ id }) => id === "invalid")?.canOpenPreview)
      .toBe(false);
  });

  it("suppresses cached run and service state while the runtime is reconnecting or offline", () => {
    for (const connectionStatus of ["connecting", "offline"] as const) {
      const summary = buildEnvironmentSummary({
        projectId: "project-1",
        projectName: "Inertia",
        conversationId: "conversation-1",
        connectionStatus,
        gitStatus: null,
        workspaceGitStatus: null,
        runs: [
          run({ id: "cached-check" }),
          run({ id: "cached-service", kind: "service", port: 4173 }),
        ],
        subagents: [],
        messages: [],
        ...owners,
      });

      expect(summary.runtime.status).toBe(connectionStatus);
      expect(summary.checks).toEqual([]);
      expect(summary.localServers).toEqual([]);
    }
  });

  it("keeps every stoppable owner visible while bounding passive work", () => {
    const summary = buildEnvironmentSummary({
      projectId: "project-1",
      projectName: "Inertia",
      conversationId: "conversation-1",
      connectionStatus: "online",
      gitStatus: null,
      workspaceGitStatus: null,
      runs: [
        ...[1, 2, 3, 4].map((value) => run({
          id: `passive-${value}`,
          canStop: false,
          startedAt: `2026-08-12T12:0${7 - value}:00.000Z`,
        })),
        run({
          id: "split-service",
          kind: "service",
          projectId: "project-2",
          conversationId: "conversation-2",
          label: "Docs preview",
          detail: "npm run preview",
          port: 4173,
          canStop: true,
          startedAt: "2026-08-12T12:01:00.000Z",
        }),
        run({
          id: "unknown",
          projectId: "removed-project",
          conversationId: null,
          canStop: true,
          startedAt: "2026-08-12T12:00:00.000Z",
        }),
      ],
      subagents: [],
      messages: [],
      ...owners,
      visibleProjectIds: ["project-2"],
    });

    expect(summary.checks.map(({ id }) => id)).toEqual([
      "passive-1",
      "passive-2",
      "passive-3",
      "unknown",
    ]);
    expect(summary.checks.find(({ id }) => id === "unknown"))
      .toMatchObject({ contextLabel: "Unavailable project", canStop: true });
    expect(summary.localServers[0]).toMatchObject({
      id: "split-service",
      contextLabel: "Docs · Docs chat (docs/preview) · npm run preview",
      canOpenPreview: true,
    });
  });

  it("disambiguates duplicate project names and sibling chat attention", () => {
    const summary = buildEnvironmentSummary({
      projectId: "project-1",
      projectName: "Inertia",
      conversationId: "conversation-1",
      connectionStatus: "online",
      gitStatus: null,
      workspaceGitStatus: null,
      runs: [
        run({
          id: "docs-alpha",
          projectId: "docs-alpha",
          conversationId: "docs-alpha-chat",
          detail: "npm run check",
        }),
        run({
          id: "sibling-failure",
          conversationId: "conversation-2",
          status: "failed",
          attentionState: "unseen",
          canStop: false,
          finishedAt: now,
        }),
      ],
      subagents: [],
      messages: [],
      projects: [
        { id: "project-1", name: "Inertia", path: "/workspace/inertia" },
        { id: "docs-alpha", name: "Docs", path: "/workspace/docs-alpha" },
        { id: "docs-beta", name: "Docs", path: "/workspace/docs-beta" },
      ],
      conversations: [
        ...owners.conversations,
        {
          id: "docs-alpha-chat",
          projectId: "docs-alpha",
          title: "Checks",
          branch: "codex/checks",
          worktreePath: "/workspace/docs-alpha/.inertia/checks",
        },
      ],
    });

    expect(summary.checks.find(({ id }) => id === "docs-alpha")?.contextLabel)
      .toBe("Docs (/workspace/docs-alpha) · Checks (codex/checks) · npm run check");
    expect(summary.checks.find(({ id }) => id === "sibling-failure"))
      .toMatchObject({
        contextLabel: "Docs chat (docs/preview)",
        canAcknowledge: true,
        canDismiss: true,
      });
  });

  it("projects root and nested repository identities with scoped action state", () => {
    const root = workspaceGit().repositories[0]!;
    const nested = {
      ...root,
      repositoryPath: "packages/docs",
      authorityRef: "docs-authority",
      branch: null,
      upstream: null,
      ahead: 0,
      hasRemote: false,
      files: [],
      insertions: 0,
      deletions: 0,
      clean: true,
      pullRequest: undefined,
    };
    const summary = buildEnvironmentSummary({
      projectId: "project-1",
      projectName: "Inertia",
      conversationId: "conversation-1",
      connectionStatus: "online",
      gitStatus: null,
      workspaceGitStatus: workspaceGit({
        repositories: [root, nested],
        files: 1,
        discoveredRepositories: 2,
      }),
      runs: [],
      subagents: [],
      messages: [],
    });

    expect(summary.branch).toEqual({ label: "Branches", value: "2 repositories" });
    expect(summary.repositories).toMatchObject([{
      repositoryPath: ".",
      authorityRef: "root-authority",
      branch: "codex/environment",
      commitAction: { label: "Commit", disabled: false },
      pushAction: { label: "Push 1", disabled: true },
    }, {
      repositoryPath: "packages/docs",
      authorityRef: "docs-authority",
      branch: null,
      commitAction: { disabled: true },
      pushAction: { disabled: true },
    }]);
  });

  it("disables repository mutations when scoped Git authority is unavailable", () => {
    const repository = {
      ...workspaceGit().repositories[0]!,
      authorityRef: null,
    };
    const summary = buildEnvironmentSummary({
      projectId: "project-1",
      projectName: "Inertia",
      conversationId: "conversation-1",
      connectionStatus: "online",
      gitStatus: null,
      workspaceGitStatus: workspaceGit({ repositories: [repository] }),
      runs: [],
      subagents: [],
      messages: [],
    });

    expect(summary.repositories[0]).toMatchObject({
      authorityRef: null,
      commitAction: {
        disabled: true,
        detail: expect.stringContaining("Scoped Git access is unavailable"),
      },
      pushAction: {
        disabled: true,
        detail: expect.stringContaining("Scoped Git access is unavailable"),
      },
    });
  });

  it("projects current, stale, refreshing, unavailable, and isolated Usage truthfully", () => {
    const input = {
      projectId: "project-1",
      projectName: "Inertia",
      conversationId: "conversation-1",
      connectionStatus: "online" as const,
      gitStatus: null,
      workspaceGitStatus: null,
      runs: [],
      subagents: [],
      messages: [],
      latestTurnId: "turn-1",
      usage: usage(),
      usageProvider: provider(),
      usageIdentity: { providerId: "codex", label: "Codex" },
      usageQuotaSource: "selected-route" as const,
    };
    const current = buildEnvironmentSummary(input);
    expect(current.usage).toMatchObject({
      providerId: "codex",
      context: {
        quality: "current",
        remainingPercent: 72,
        valueLabel: "72%",
      },
      quota: {
        freshness: "current",
        source: "selected-route",
        limits: [{ remainingPercent: 64 }],
      },
    });

    const stale = buildEnvironmentSummary({
      ...input,
      latestTurnId: "turn-2",
      usageProvider: provider({
        metadataState: {
          ...provider().metadataState,
          rateLimits: {
            ...provider().metadataState.rateLimits,
            freshness: "stale",
          },
        },
      }),
    });
    expect(stale.usage).toMatchObject({
      context: { quality: "stale", valueLabel: "72% · stale" },
      quota: { freshness: "stale" },
    });

    const refreshing = buildEnvironmentSummary({
      ...input,
      usageProvider: provider({
        metadataState: {
          ...provider().metadataState,
          rateLimits: {
            ...provider().metadataState.rateLimits,
            freshness: "stale",
            refreshing: true,
          },
        },
      }),
    });
    expect(refreshing.usage?.quota.freshness).toBe("refreshing");

    const unavailable = buildEnvironmentSummary({
      ...input,
      usage: usage({ usedTokens: null, maxTokens: null }),
      usageProvider: null,
    });
    expect(unavailable.usage).toMatchObject({
      context: { quality: "unavailable", remainingPercent: null },
      quota: { freshness: "unavailable", limits: [] },
    });

    const isolated = buildEnvironmentSummary({
      ...input,
      usageIdentity: { providerId: null, label: "Kimi gateway" },
      usageQuotaSource: "isolated",
    });
    expect(isolated.usage).toMatchObject({
      providerId: null,
      providerLabel: "Kimi gateway",
    });
    expect(isolated.usage?.quota).toMatchObject({
      freshness: "unavailable",
      source: "isolated",
      limits: [],
    });
  });

  it("keeps empty, detached, loading, and failed states explicit", () => {
    const empty = buildEnvironmentSummary({
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
    expect(empty).toMatchObject({
      workspace: null,
      changes: null,
      branch: null,
      repositories: [],
      checks: [],
      localServers: [],
      usage: null,
      gitState: "unknown",
    });

    const detached = buildEnvironmentSummary({
      projectId: "project-1",
      projectName: "Notes",
      conversationId: null,
      connectionStatus: "online",
      gitStatus: {
        isRepository: true,
        authorityRef: "root-authority",
        root: "/workspace/notes",
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
      projectPath: "/workspace/notes",
    });
    expect(detached.workspace).toMatchObject({
      label: "Project directory",
      value: "notes",
    });
    expect(detached.branch).toEqual({ label: "Branch", value: "Detached HEAD" });

    const loading = buildEnvironmentSummary({
      ...owners,
      projectId: "project-1",
      projectName: "Inertia",
      conversationId: "conversation-1",
      connectionStatus: "online",
      gitStatus: null,
      workspaceGitStatus: workspaceGit(),
      runs: [],
      subagents: [],
      messages: [],
      gitLoading: true,
    });
    expect(loading.gitState).toBe("loading");
    expect(loading.repositories[0]).toMatchObject({
      commitAction: {
        disabled: true,
        detail: expect.stringContaining("Git data is refreshing"),
      },
      pushAction: {
        disabled: true,
        detail: expect.stringContaining("Git data is refreshing"),
      },
    });

    const failed = buildEnvironmentSummary({
      ...owners,
      projectId: "project-1",
      projectName: "Inertia",
      conversationId: "conversation-1",
      connectionStatus: "online",
      gitStatus: null,
      workspaceGitStatus: workspaceGit(),
      runs: [],
      subagents: [],
      messages: [],
      gitError: "Workspace scan timed out.",
    });
    expect(failed.gitState).toBe("error");
    expect(failed.gitNotice).toBe("Workspace scan timed out.");
    expect(failed.repositories[0]).toMatchObject({
      commitAction: {
        disabled: true,
        detail: expect.stringContaining("Git data is unavailable"),
      },
      pushAction: {
        disabled: true,
        detail: expect.stringContaining("Git data is unavailable"),
      },
    });
  });

  it("does not call an empty or failed repository scan clean", () => {
    const noRepository = buildEnvironmentSummary({
      projectId: "project-1",
      projectName: "Inertia",
      conversationId: "conversation-1",
      connectionStatus: "online",
      gitStatus: null,
      workspaceGitStatus: workspaceGit({
        repositories: [],
        files: 0,
        insertions: 0,
        deletions: 0,
        discoveredRepositories: 0,
      }),
      runs: [],
      subagents: [],
      messages: [],
    });
    expect(noRepository.changes).toBeNull();
    expect(noRepository.gitState).toBe("unavailable");

    const failedRepository = buildEnvironmentSummary({
      projectId: "project-1",
      projectName: "Inertia",
      conversationId: "conversation-1",
      connectionStatus: "online",
      gitStatus: null,
      workspaceGitStatus: workspaceGit({
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
        partial: true,
      }),
      runs: [],
      subagents: [],
      messages: [],
    });
    expect(failedRepository.changes).toBeNull();
    expect(failedRepository.gitState).toBe("error");
    expect(failedRepository.gitNotice).toBe("Permission denied.");
  });
});
