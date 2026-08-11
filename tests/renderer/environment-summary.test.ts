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
  it("uses truthful workspace-wide changes and current passive work", () => {
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
        run({
          id: "old",
          status: "succeeded",
          canStop: false,
          finishedAt: now,
        }),
        run({ id: "other", projectId: "project-2", canStop: false }),
        run({
          id: "failed",
          status: "failed",
          attentionState: "unseen",
          canStop: false,
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
    });

    expect(summary.runtime).toEqual({ status: "online", label: "Ready" });
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
    expect(summary.checks).toHaveLength(2);
    expect(summary.checks.map(({ id }) => id)).toContain("failed");
    expect(summary.checks.find(({ id }) => id === "failed")?.canStop)
      .toBe(false);
    expect(summary.checks.find(({ id }) => id === "failed"))
      .toMatchObject({ canAcknowledge: true, canDismiss: true });
    expect(summary.subagents).toHaveLength(1);
    expect(summary.attachments.map(({ name }) => name))
      .toEqual(["notes.pdf", "old.png"]);
    expect(JSON.stringify(summary)).not.toContain("/private/");
  });

  it("keeps every stoppable run globally while bounding visible passive rows", () => {
    const summary = buildEnvironmentSummary({
      projectId: "project-1",
      projectName: "Inertia",
      conversationId: "conversation-1",
      connectionStatus: "online",
      gitStatus: null,
      workspaceGitStatus: null,
      runs: [
        run({
          id: "passive-1",
          canStop: false,
          startedAt: "2026-07-28T12:06:00.000Z",
        }),
        run({
          id: "passive-2",
          canStop: false,
          startedAt: "2026-07-28T12:05:00.000Z",
        }),
        run({
          id: "passive-3",
          canStop: false,
          startedAt: "2026-07-28T12:04:00.000Z",
        }),
        run({
          id: "passive-hidden",
          canStop: false,
          startedAt: "2026-07-28T12:03:00.000Z",
        }),
        run({
          id: "service-1",
          canStop: true,
          startedAt: "2026-07-28T12:02:00.000Z",
        }),
        run({
          id: "service-2",
          canStop: true,
          startedAt: "2026-07-28T12:01:00.000Z",
        }),
        run({
          id: "split-service",
          kind: "service",
          projectId: "project-2",
          conversationId: "conversation-2",
          label: "Docs preview",
          detail: "npm run preview",
          canStop: true,
          port: 4173,
          startedAt: "2026-07-28T12:00:00.000Z",
        }),
        run({
          id: "unrelated-service",
          kind: "service",
          projectId: "project-3",
          conversationId: null,
          canStop: true,
          port: 3000,
          startedAt: "2026-07-28T12:07:00.000Z",
        }),
        run({
          id: "unknown-service",
          kind: "service",
          projectId: "removed-project",
          conversationId: null,
          canStop: true,
          port: 8080,
          startedAt: "2026-07-28T12:08:00.000Z",
        }),
      ],
      subagents: [],
      messages: [],
      projects: [
        { id: "project-1", name: "Inertia" },
        { id: "project-2", name: "Docs" },
        { id: "project-3", name: "Website" },
      ],
      conversations: [
        { id: "conversation-1", projectId: "project-1" },
        { id: "conversation-2", projectId: "project-2" },
      ],
      visibleProjectIds: ["project-2"],
    });

    expect(summary.checks.map(({ id }) => id)).toEqual([
      "unknown-service",
      "unrelated-service",
      "passive-1",
      "passive-2",
      "passive-3",
      "service-1",
      "service-2",
      "split-service",
    ]);
    expect(summary.checks.filter(({ canStop }) => canStop).map(({ id }) => id))
      .toEqual([
        "unknown-service",
        "unrelated-service",
        "service-1",
        "service-2",
        "split-service",
      ]);
    expect(summary.checks.find(({ id }) => id === "split-service")?.contextLabel)
      .toBe("Docs · npm run preview");
    expect(summary.checks.find(({ id }) => id === "split-service")?.canOpenPreview)
      .toBe(true);
    expect(summary.checks.find(({ id }) => id === "unrelated-service")?.contextLabel)
      .toBe("Website");
    expect(summary.checks.find(({ id }) => id === "unknown-service"))
      .toMatchObject({
        contextLabel: "Unavailable project",
        canOpenPreview: false,
      });
  });

  it("offers previews only for live, safely routed service ports", () => {
    const summary = buildEnvironmentSummary({
      projectId: "project-1",
      projectName: "Inertia",
      conversationId: "conversation-1",
      connectionStatus: "online",
      gitStatus: null,
      workspaceGitStatus: null,
      runs: [
        run({ id: "valid", kind: "service", port: 4173 }),
        run({ id: "invalid-port", kind: "service", port: 70_000 }),
        run({
          id: "settled",
          kind: "service",
          port: 3000,
          status: "succeeded",
          canStop: false,
          finishedAt: now,
        }),
        run({
          id: "missing-conversation",
          kind: "service",
          port: 8080,
          conversationId: "missing",
        }),
      ],
      subagents: [],
      messages: [],
      projects: [{ id: "project-1", name: "Inertia" }],
      conversations: [{
        id: "conversation-1",
        projectId: "project-1",
      }],
    });

    expect(summary.checks.find(({ id }) => id === "valid")?.canOpenPreview)
      .toBe(true);
    expect(summary.checks.find(({ id }) => id === "invalid-port")?.canOpenPreview)
      .toBe(false);
    expect(summary.checks.find(({ id }) => id === "settled"))
      .toBeUndefined();
    expect(summary.checks.find(({ id }) => id === "missing-conversation")?.canOpenPreview)
      .toBe(false);
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
      runtime: { status: "connecting", label: "Connecting" },
      changes: null,
      branch: null,
      checks: [],
      subagents: [],
      attachments: [],
    });
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
