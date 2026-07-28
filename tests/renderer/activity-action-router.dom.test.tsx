import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  Project,
  ServerEvent,
  WorkspaceRun,
} from "../../src/shared/contracts";
import { useActivityActions } from "../../src/renderer/src/hooks/useActivityActions";
import {
  useActivityActionRouter,
  type PaneActivityActions,
} from "../../src/renderer/src/hooks/useActivityActionRouter";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";

function actions(): PaneActivityActions {
  return {
    activateContext: vi.fn(),
    openActivityPreview: vi.fn(),
    rerunActivity: vi.fn(),
  };
}

const secondaryRun: WorkspaceRun = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "service",
  projectId: "22222222-2222-4222-8222-222222222222",
  conversationId: "33333333-3333-4333-8333-333333333333",
  actionId: "preview",
  label: "Preview",
  detail: "npm run preview",
  status: "running",
  attentionState: "acknowledged",
  canStop: true,
  port: 4173,
  startedAt: "2026-07-28T12:00:00.000Z",
  finishedAt: null,
};

function project(id: string, name: string): Project {
  return {
    id,
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
    createdAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
  };
}

describe("useActivityActionRouter", () => {
  it("routes terminal, preview, and rerun controls to the matching split pane", () => {
    const primary = actions();
    const secondary = actions();
    const hook = renderHook(
      ({ secondaryConversationId }: {
        secondaryConversationId: string | null;
      }) => useActivityActionRouter({
        primary,
        secondary,
        secondaryConversationId,
      }),
      {
        initialProps: {
          secondaryConversationId: secondaryRun.conversationId,
        },
      },
    );

    act(() => {
      hook.result.current.activateContext(secondaryRun, "terminal");
      hook.result.current.openActivityPreview(secondaryRun);
      hook.result.current.rerunActivity(secondaryRun);
    });

    expect(secondary.activateContext).toHaveBeenCalledWith(
      secondaryRun,
      "terminal",
    );
    expect(secondary.openActivityPreview).toHaveBeenCalledWith(secondaryRun);
    expect(secondary.rerunActivity).toHaveBeenCalledWith(secondaryRun);
    expect(primary.activateContext).not.toHaveBeenCalled();
    expect(primary.openActivityPreview).not.toHaveBeenCalled();
    expect(primary.rerunActivity).not.toHaveBeenCalled();

    hook.rerender({ secondaryConversationId: null });
    act(() => hook.result.current.openActivityPreview(secondaryRun));
    expect(primary.openActivityPreview).toHaveBeenCalledWith(secondaryRun);
  });

  it("settles secondary preview and rerun actions in the secondary controller", async () => {
    const primaryProject = project(
      "44444444-4444-4444-8444-444444444444",
      "Primary",
    );
    const secondaryProject = project(
      secondaryRun.projectId,
      "Secondary",
    );
    const primaryConversationId =
      "55555555-5555-4555-8555-555555555555";
    const primaryActivate = vi.fn();
    const secondaryActivate = vi.fn();
    const primaryPreview = vi.fn();
    const secondaryPreview = vi.fn();
    const request = vi.fn(
      async (_command: CommandWithoutId): Promise<ServerEvent> => ({
        type: "request.ok",
        requestId: "request",
      }),
    );
    const hook = renderHook(() => {
      const primary = useActivityActions({
        snapshot: null,
        project: primaryProject,
        conversationId: primaryConversationId,
        request,
        run: vi.fn(),
        setActiveTool: vi.fn(),
        setActivityOpen: vi.fn(),
        setActionError: vi.fn(),
        activateContext: primaryActivate,
        openProjectPath: vi.fn(),
        navigatePreview: primaryPreview,
      });
      const secondary = useActivityActions({
        snapshot: null,
        project: secondaryProject,
        conversationId: secondaryRun.conversationId,
        request,
        run: vi.fn(),
        setActiveTool: vi.fn(),
        setActivityOpen: vi.fn(),
        setActionError: vi.fn(),
        activateContext: secondaryActivate,
        openProjectPath: vi.fn(),
        navigatePreview: secondaryPreview,
      });
      const routed = useActivityActionRouter({
        primary: {
          activateContext: primaryActivate,
          openActivityPreview: primary.openActivityPreview,
          rerunActivity: primary.rerunActivity,
        },
        secondary: {
          activateContext: secondaryActivate,
          openActivityPreview: secondary.openActivityPreview,
          rerunActivity: secondary.rerunActivity,
        },
        secondaryConversationId: secondaryRun.conversationId,
      });
      return { primary, secondary, routed };
    });

    act(() => {
      hook.result.current.routed.activateContext(
        secondaryRun,
        "terminal",
      );
      hook.result.current.routed.openActivityPreview(secondaryRun);
      hook.result.current.routed.rerunActivity(secondaryRun);
    });

    await waitFor(() => {
      expect(secondaryPreview).toHaveBeenCalledWith(
        "http://127.0.0.1:4173",
      );
      expect(hook.result.current.secondary.pendingActionId)
        .toBe(secondaryRun.actionId);
    });
    expect(secondaryActivate).toHaveBeenCalledWith(
      secondaryRun,
      "terminal",
    );
    expect(secondaryActivate).toHaveBeenCalledWith(
      secondaryRun,
      "preview",
    );
    expect(primaryActivate).not.toHaveBeenCalled();
    expect(primaryPreview).not.toHaveBeenCalled();
    expect(hook.result.current.primary.pendingActionId).toBeNull();
  });
});
