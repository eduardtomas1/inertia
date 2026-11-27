import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { buildWorkspaceMediaPreviewTarget, type WorkspaceMediaPreviewTarget } from "../../src/shared/workspace-media-preview";

vi.mock("../../src/renderer/src/components/ChatWorkspace", () => ({
  ChatWorkspace: ({
    conversation,
    onPreviewMedia,
  }: {
    conversation?: { id: string } | null;
    onPreviewMedia?: (target: WorkspaceMediaPreviewTarget) => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() => {
          const target = buildWorkspaceMediaPreviewTarget({
            projectId: "11111111-1111-4111-8111-111111111111",
            conversationId: conversation?.id,
            relativePath: "docs/report.pdf",
          });
          if (target) onPreviewMedia?.(target);
        }}
      >
        Trigger {conversation?.id ?? "primary"}
      </button>
      <button
        type="button"
        onClick={() => {
          const target = buildWorkspaceMediaPreviewTarget({
            projectId: "11111111-1111-4111-8111-111111111111",
            relativePath: "docs/base.pdf",
          });
          if (target) onPreviewMedia?.(target);
        }}
      >
        Trigger base {conversation?.id ?? "primary"}
      </button>
    </div>
  ),
}));

vi.mock("../../src/renderer/src/components/ConversationSplitView", () => ({
  ConversationSplitView: ({ panes }: { panes: { owner: string; content: ReactNode }[] }) => (
    <div>
      {panes.map((pane) => (
        <div key={pane.owner} data-pane={pane.owner}>
          {pane.content}
        </div>
      ))}
    </div>
  ),
}));

vi.mock("../../src/renderer/src/components/ConversationDetailState", () => ({
  ConversationDetailState: () => <div>Detail loading</div>,
}));

vi.mock("../../src/renderer/src/components/DetachedConversationPlaceholder", () => ({
  DetachedConversationPlaceholder: () => <div>Detached placeholder</div>,
}));

vi.mock("../../src/renderer/src/components/watcher/WatcherDockHost", () => ({
  WatcherDockHost: () => null,
}));

vi.mock("../../src/renderer/src/hooks/useChatMinimumHeight", () => ({
  useChatMinimumHeight: () => undefined,
}));

vi.mock("../../src/renderer/src/hooks/useNativePreviewSuspension", () => ({
  useNativePreviewSuspension: () => undefined,
}));

vi.mock("../../src/renderer/src/components/media/WorkspaceMediaViewer", () => ({
  WorkspaceMediaViewer: ({ target }: { target: WorkspaceMediaPreviewTarget }) => (
    <div>Viewer {target.name}</div>
  ),
}));

import { WorkspaceScene } from "../../src/renderer/src/components/WorkspaceScene";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PRIMARY_CONV = "22222222-2222-4222-8222-222222222222";
const SECONDARY_CONV = "33333333-3333-4333-8333-333333333333";

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "inertia");
});

describe("WorkspaceScene media preview lifecycle", () => {
  it("keeps a healthy secondary split pane preview open when primary has detailState and surfaces resolved openProjectPath error strings", async () => {
    const openProjectPath = vi.fn(async () => "No application is associated with this file.");
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { openProjectPath },
    });

    const primaryChat = {
      project: { id: PROJECT_ID, normalizedPath: "/work/repo" },
      conversation: { id: PRIMARY_CONV },
      onOpenTurnFile: vi.fn(),
    };
    const secondaryChat = {
      project: { id: PROJECT_ID, normalizedPath: "/work/repo" },
      conversation: { id: SECONDARY_CONV },
      onOpenTurnFile: vi.fn(),
    };

    render(
      <WorkspaceScene
        view="workspace"
        settings={{} as never}
        detailState={{ state: "loading" } as never}
        chat={primaryChat as never}
        resizeHandle={null}
        tools={null}
        splitScene={{
          layout: "split-horizontal" as never,
          onLayoutChange: vi.fn(),
          onClosePane: vi.fn(),
          panes: [
            {
              owner: "primary",
              conversationId: PRIMARY_CONV,
              title: "Primary",
              projectName: "Repo",
              project: primaryChat.project as never,
              toolsOpen: false,
              onToggleTools: vi.fn(),
              terminalOpen: false,
              onToggleTerminal: vi.fn(),
              scene: null,
            },
            {
              owner: "secondary",
              conversationId: SECONDARY_CONV,
              title: "Secondary",
              projectName: "Repo",
              project: secondaryChat.project as never,
              toolsOpen: false,
              onToggleTools: vi.fn(),
              terminalOpen: false,
              onToggleTerminal: vi.fn(),
              scene: {
                detailState: null,
                chat: secondaryChat as never,
                resizeHandle: null,
                tools: null,
              },
            },
          ],
        }}
      />,
    );

    const secondaryTrigger = await screen.findByRole("button", { name: `Trigger ${SECONDARY_CONV}` });
    fireEvent.click(secondaryTrigger);

    const dialog = await screen.findByRole("dialog", { name: "report.pdf" });
    expect(dialog).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open externally" }));
    expect(openProjectPath).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      conversationId: SECONDARY_CONV,
      relativePath: "docs/report.pdf",
      action: "open-externally",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not open report.pdf externally.");
  });

  it("dismisses a project-root preview when the initiating split pane switches conversation even if a sibling hosts the same project", async () => {
    const primaryChat = {
      project: { id: PROJECT_ID, normalizedPath: "/work/repo" },
      conversation: { id: PRIMARY_CONV },
      onOpenTurnFile: vi.fn(),
    };
    const secondaryChat = {
      project: { id: PROJECT_ID, normalizedPath: "/work/repo" },
      conversation: { id: SECONDARY_CONV },
      onOpenTurnFile: vi.fn(),
    };
    const makeSplit = (secondaryConversationId: string) => ({
      layout: "split-horizontal" as never,
      onLayoutChange: vi.fn(),
      onClosePane: vi.fn(),
      panes: [
        {
          owner: "primary" as const,
          conversationId: PRIMARY_CONV,
          title: "Primary",
          projectName: "Repo",
          project: primaryChat.project as never,
          toolsOpen: false,
          onToggleTools: vi.fn(),
          terminalOpen: false,
          onToggleTerminal: vi.fn(),
          scene: null,
        },
        {
          owner: "secondary" as const,
          conversationId: secondaryConversationId,
          title: "Secondary",
          projectName: "Repo",
          project: secondaryChat.project as never,
          toolsOpen: false,
          onToggleTools: vi.fn(),
          terminalOpen: false,
          onToggleTerminal: vi.fn(),
          scene: {
            detailState: null,
            chat: { ...secondaryChat, conversation: { id: secondaryConversationId } } as never,
            resizeHandle: null,
            tools: null,
          },
        },
      ],
    });

    const { rerender } = render(
      <WorkspaceScene
        view="workspace"
        settings={{} as never}
        detailState={null}
        chat={primaryChat as never}
        resizeHandle={null}
        tools={null}
        splitScene={makeSplit(SECONDARY_CONV)}
      />,
    );

    const baseTrigger = await screen.findByRole("button", { name: `Trigger base ${SECONDARY_CONV}` });
    fireEvent.click(baseTrigger);
    expect(await screen.findByRole("dialog", { name: "base.pdf" })).toBeInTheDocument();

    rerender(
      <WorkspaceScene
        view="workspace"
        settings={{} as never}
        detailState={null}
        chat={primaryChat as never}
        resizeHandle={null}
        tools={null}
        splitScene={makeSplit("44444444-4444-4444-8444-444444444444")}
      />,
    );

    expect(screen.queryByRole("dialog", { name: "base.pdf" })).not.toBeInTheDocument();
  });
});
