import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  Conversation,
  Project,
  ServerEvent,
} from "../../src/shared/contracts";
import { nativeModelSelection } from "../../src/shared/model-routing";
import {
  useWorkspaceMentions,
} from "../../src/renderer/src/hooks/workspace-tools/useWorkspaceMentions";

const project: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Workspace",
  path: "/workspace",
  normalizedPath: "/workspace",
  repositoryIdentity: null,
  repositoryRoot: null,
  repositoryRelativePath: ".",
  groupingMode: null,
  gitRepositoryLimit: 64,
  color: "#5555ff",
  status: "ready",
  createdAt: "2026-07-28T12:00:00.000Z",
  updatedAt: "2026-07-28T12:00:00.000Z",
};

function conversation(
  id: string,
  owner: Project,
  worktreePath: string,
): Conversation {
  return {
    id,
    projectId: owner.id,
    title: id,
    providerId: "codex",
    modelSelection: nativeModelSelection({
      providerId: "codex",
      modelId: "default",
      reasoningEffort: "medium",
    }),
    continuationIdentity: null,
    model: "default",
    reasoningEffort: "medium",
    interactionMode: "build",
    accessMode: "supervised",
    status: "idle",
    attentionKind: null,
    branch: "main",
    worktreePath,
    providerSessionId: null,
    archivedAt: null,
    settledAt: null,
    completedAt: null,
    lastViewedAt: null,
    createdAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
  };
}

describe("useWorkspaceMentions", () => {
  it("keeps simultaneous pane searches scoped to their conversation IDs", async () => {
    const primary = conversation(
      "22222222-2222-4222-8222-222222222222",
      project,
      "/workspace-primary",
    );
    const secondaryProject = {
      ...project,
      id: "55555555-5555-4555-8555-555555555555",
      name: "Secondary",
      path: "/secondary",
      normalizedPath: "/secondary",
    };
    const secondary = conversation(
      "33333333-3333-4333-8333-333333333333",
      secondaryProject,
      "/workspace-secondary",
    );
    const request = vi.fn(async (command): Promise<ServerEvent> => ({
      type: "request.result",
      requestId: "44444444-4444-4444-8444-444444444444",
      result: {
        kind: "workspace.entries",
        entries: [{
          path: `${command.payload.conversationId}/result.ts`,
          kind: "file",
        }],
        truncated: false,
        directory: "",
      },
    }));
    const primaryHook = renderHook(() => useWorkspaceMentions({
      project,
      conversation: primary,
      request,
    }));
    const secondaryHook = renderHook(() => useWorkspaceMentions({
      project: secondaryProject,
      conversation: secondary,
      request,
    }));

    act(() => {
      primaryHook.result.current.searchMentions("result");
      secondaryHook.result.current.searchMentions("result");
    });

    await waitFor(() => {
      expect(primaryHook.result.current.mentionResults[0]?.path)
        .toContain(primary.id);
      expect(secondaryHook.result.current.mentionResults[0]?.path)
        .toContain(secondary.id);
    });
    expect(request.mock.calls.map(([command]) => ({
      projectId: command.payload.projectId,
      conversationId: command.payload.conversationId,
    }))).toEqual([
      { projectId: project.id, conversationId: primary.id },
      {
        projectId: secondaryProject.id,
        conversationId: secondary.id,
      },
    ]);
  });
});
