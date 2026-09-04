import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  Conversation,
  Project,
  ServerEvent,
} from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import {
  useTurnArtifacts,
} from "../../src/renderer/src/hooks/workspace-tools/useTurnArtifacts";
import type {
  CommandWithoutId,
} from "../../src/renderer/src/lib/runtimeCommands";

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
  projectId: string,
  title: string,
): Conversation {
  return {
  ...primaryConversation,
  id,
  projectId,
  title,
  worktreePath: `/workspace-${title.toLowerCase()}`,
  };
}

const primaryConversation: Conversation = {
  id: "22222222-2222-4222-8222-222222222222",
  projectId: project.id,
  title: "Primary",
  providerId: "codex",
  modelSelection: providerNativeModelSelection({
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
  worktreePath: "/workspace-primary",
  providerSessionId: null,
  archivedAt: null,
  settledAt: null,
  completedAt: null,
  lastViewedAt: null,
  createdAt: "2026-07-28T12:00:00.000Z",
  updatedAt: "2026-07-28T12:00:00.000Z",
};

function turnDiffResult(): ServerEvent {
  return {
    type: "request.result",
    requestId: "55555555-5555-4555-8555-555555555555",
    result: {
      kind: "git.turn.diff",
      diff: {
        artifactId: "artifact",
        turnId: "turn",
        title: "Turn changes",
        completeness: "complete",
        patchState: "available",
        patch: "",
        truncated: false,
        files: [],
      },
    },
  };
}

describe("useTurnArtifacts", () => {
  it("binds every artifact action to the owning project and conversation", async () => {
    const splitProject = {
      ...project,
      id: "33333333-3333-4333-8333-333333333333",
      name: "Split workspace",
      path: "/split-workspace",
      normalizedPath: "/split-workspace",
    };
    const splitConversation = conversation(
      "44444444-4444-4444-8444-444444444444",
      splitProject.id,
      "Split",
    );
    const request = vi.fn(async (
      _command: CommandWithoutId,
    ): Promise<ServerEvent> => turnDiffResult());
    const openWorkspaceFile = vi.fn();
    const setActiveTool = vi.fn();
    const hook = renderHook((owner: {
      project: Project;
      conversation: Conversation;
    }) => useTurnArtifacts({
      ...owner,
      request,
      setActionError: vi.fn(),
      setActiveTool,
      openWorkspaceFile,
      loadGit: vi.fn(async () => undefined),
    }), {
      initialProps: {
        project: splitProject,
        conversation: splitConversation,
      },
    });

    await act(async () => {
      await hook.result.current.openTurnDiff(
        "turn-split",
        "src/split.ts",
      );
      await hook.result.current.compareTurnArtifacts(
        "turn-before",
        "turn-after",
      );
    });
    act(() => {
      hook.result.current.openTurnFile("src/split.ts");
    });

    expect(request.mock.calls[0]?.[0]).toMatchObject({
      type: "git.turn.diff",
      payload: {
        projectId: splitProject.id,
        conversationId: splitConversation.id,
        turnId: "turn-split",
        path: "src/split.ts",
      },
    });
    expect(request.mock.calls[1]?.[0]).toMatchObject({
      type: "git.turn.compare",
      payload: {
        projectId: splitProject.id,
        conversationId: splitConversation.id,
        earlierTurnId: "turn-before",
        laterTurnId: "turn-after",
      },
    });
    expect(openWorkspaceFile).toHaveBeenCalledWith(
      "src/split.ts",
      undefined,
      undefined,
    );
    expect(setActiveTool).toHaveBeenCalledWith("changes");
  });

  it("discards a delayed artifact response after the pane changes owner", async () => {
    let settleRequest: ((event: ServerEvent) => void) | null = null;
    const request = vi.fn(() => new Promise<ServerEvent>((resolve) => {
      settleRequest = resolve;
    }));
    const hook = renderHook((owner: {
      project: Project;
      conversation: Conversation;
    }) => useTurnArtifacts({
      ...owner,
      request,
      setActionError: vi.fn(),
      setActiveTool: vi.fn(),
      openWorkspaceFile: vi.fn(),
      loadGit: vi.fn(async () => undefined),
    }), {
      initialProps: {
        project,
        conversation: primaryConversation,
      },
    });
    let pending!: Promise<void>;
    act(() => {
      pending = hook.result.current.openTurnDiff("turn-primary");
    });
    const nextProject = {
      ...project,
      id: "66666666-6666-4666-8666-666666666666",
    };
    hook.rerender({
      project: nextProject,
      conversation: conversation(
        "77777777-7777-4777-8777-777777777777",
        nextProject.id,
        "Next",
      ),
    });

    await act(async () => {
      settleRequest?.(turnDiffResult());
      await pending;
    });

    expect(hook.result.current.historicalDiff).toBeNull();
    expect(hook.result.current.loading).toBe(false);
  });
});
