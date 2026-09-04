import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  Conversation,
  Project,
  ServerEvent,
} from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { useWorkspaceTools } from "../../src/renderer/src/hooks/useWorkspaceTools";
import { useWorkspaceFiles } from "../../src/renderer/src/hooks/workspace-tools/useWorkspaceFiles";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import {
  consumeWorkspaceFileOpenEdit,
  markWorkspaceFileSearchEdit,
} from "../../src/renderer/src/utils/workspaceFileReference";

vi.mock(
  "../../src/renderer/src/hooks/workspace-tools/openWorkspaceEntry",
  () => {
    throw new Error("Could not load /private/app/open-workspace.js");
  },
);
vi.mock(
  "../../src/renderer/src/hooks/workspace-tools/selectWorkspaceFile",
  () => {
    throw new Error("Could not load /private/app/select-workspace.js");
  },
);

function owner(name: string): {
  project: Project;
  conversation: Conversation;
} {
  const projectId = `${name === "Alpha" ? "1" : "2"}`.repeat(8)
    + "-1111-4111-8111-111111111111";
  const project: Project = {
    id: projectId,
    name,
    path: `/${name.toLowerCase()}`,
    normalizedPath: `/${name.toLowerCase()}`,
    repositoryIdentity: null,
    repositoryRoot: null,
    repositoryRelativePath: ".",
    groupingMode: null,
    gitRepositoryLimit: 64,
    color: "#5555ff",
    status: "ready",
    createdAt: "2026-08-13T12:00:00.000Z",
    updatedAt: "2026-08-13T12:00:00.000Z",
  };
  return {
    project,
    conversation: {
      id: `${name === "Alpha" ? "3" : "4"}`.repeat(8)
        + "-3333-4333-8333-333333333333",
      projectId,
      title: `${name} chat`,
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
      worktreePath: null,
      providerSessionId: null,
      archivedAt: null,
      settledAt: null,
      completedAt: null,
      lastViewedAt: null,
      createdAt: "2026-08-13T12:00:00.000Z",
      updatedAt: "2026-08-13T12:00:00.000Z",
    },
  };
}

const alpha = owner("Alpha");
const beta = owner("Beta");
const request = vi.fn((_command: CommandWithoutId): Promise<ServerEvent> =>
  Promise.reject(new Error("Unexpected request"))
);

describe("workspace file action chunk failures", () => {
  it("shows a stable file-preview error for the active owner", async () => {
    const setActionError = vi.fn();
    const hook = renderHook(() => useWorkspaceFiles({
      ...alpha,
      enabled: true,
      loadOnMount: false,
      online: false,
      request,
      setActionError,
    }));

    act(() => hook.result.current.selectWorkspaceFile("src/App.java"));

    await waitFor(() => {
      expect(hook.result.current.filePreviewError)
        .toBe("File open failed.");
    });
    expect(hook.result.current.selectedFile).toBeNull();
    expect(hook.result.current.filePreviewLoading).toBe(false);
    expect(setActionError).toHaveBeenCalledWith(
      "File open failed.",
    );
    expect(setActionError.mock.calls.flat().join(" ")).not.toContain("/private/");
  });

  it("suppresses a file-preview chunk failure after owner change", async () => {
    const setActionError = vi.fn();
    const hook = renderHook((current: typeof alpha) => useWorkspaceFiles({
      ...current,
      enabled: true,
      loadOnMount: false,
      online: false,
      request,
      setActionError,
    }), { initialProps: alpha });
    const staleSelection = hook.result.current.selectWorkspaceFile;

    act(() => {
      staleSelection("src/Private.java");
      hook.rerender(beta);
    });
    await act(async () => await Promise.resolve());

    expect(setActionError).not.toHaveBeenCalled();
    expect(hook.result.current.selectedFile).toBeNull();
    expect(hook.result.current.filePreviewError).toBeNull();
  });

  it("reports an active link action chunk failure but not a stale one", async () => {
    const activeError = vi.fn();
    const baseOptions = {
      enabled: false,
      loadGitStatusOnMount: false,
      loadGitOnMount: false,
      loadFilesOnMount: false,
      detail: null,
      online: false,
      ignoreWhitespace: false,
      confirmDestructiveActions: true,
      refreshVersion: 0,
      request,
      run: vi.fn((_key: string, command: CommandWithoutId) =>
        request(command)
      ),
      subscribe: () => () => undefined,
      setActiveTool: vi.fn(),
    };
    const active = renderHook(() => useWorkspaceTools({
      ...baseOptions,
      ...alpha,
      setActionError: activeError,
    }));

    act(() => active.result.current.openTurnFile("src/App.java"));
    markWorkspaceFileSearchEdit(alpha.project.id, alpha.conversation.id);
    expect(consumeWorkspaceFileOpenEdit(
      alpha.project.id,
      alpha.conversation.id,
      "src/App.java",
      "src/App.java",
    )).toBe(true);
    await waitFor(() => {
      expect(activeError).toHaveBeenCalledWith(
        "File open failed.",
      );
    });
    expect(activeError.mock.calls.flat().join(" ")).not.toContain("/private/");

    const staleError = vi.fn();
    const stale = renderHook((current: typeof alpha) => useWorkspaceTools({
      ...baseOptions,
      ...current,
      setActionError: staleError,
    }), { initialProps: alpha });
    const staleOpen = stale.result.current.openTurnFile;
    act(() => {
      stale.rerender(beta);
      staleOpen("src/Private.java");
    });
    await act(async () => await Promise.resolve());

    expect(staleError).not.toHaveBeenCalled();
  });
});
