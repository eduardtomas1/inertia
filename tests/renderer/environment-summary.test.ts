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
    status: "running",
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
      runtime: { status: "connecting", label: "Connecting" },
      changes: null,
      branch: null,
      checks: [],
      subagents: [],
      attachments: [],
    });
  });
});
