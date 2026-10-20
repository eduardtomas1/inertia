import { act, render, screen } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultSettings } from "../../src/shared/contracts";
import { WatcherAttachHost } from "../../src/renderer/src/components/watcher/WatcherAttachHost";
import { WatcherDockHost } from "../../src/renderer/src/components/watcher/WatcherDockHost";
import { WatcherFindingCard } from "../../src/renderer/src/components/watcher/WatcherFindingCard";
import { WatcherContext } from "../../src/renderer/src/components/watcher/watcherContext";
import { resetWatcherDockStore } from "../../src/renderer/src/hooks/useWatcherDock";
import { WATCHED_ID, finding, surfaceModel } from "./watcher-fixtures";

vi.mock("../../src/renderer/src/components/watcher/WatcherDock", () => {
  throw new Error("chunk failed");
});
vi.mock("../../src/renderer/src/components/watcher/WatcherAttachDialog", () => {
  throw new Error("chunk failed");
});
vi.mock("../../src/renderer/src/components/ResponseMarkdown", () => {
  throw new Error("chunk failed");
});

class Window extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? <p>Window failed</p> : this.props.children;
  }
}

const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

beforeEach(() => {
  window.localStorage.clear();
  resetWatcherDockStore();
});

describe("watcher chunks that fail to load", () => {
  it("keeps the chat when the dock chunk fails", async () => {
    render(
      <Window>
        <WatcherContext.Provider value={surfaceModel()}>
          <textarea aria-label="Message" />
          <WatcherDockHost watchedId={WATCHED_ID} />
        </WatcherContext.Provider>
      </Window>,
    );
    await settle();
    expect(screen.queryByText("Window failed")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeInTheDocument();
  });

  it("keeps the window when the attach dialog chunk fails", async () => {
    render(
      <Window>
        <textarea aria-label="Message" />
        <WatcherAttachHost
          target={{ watchedId: WATCHED_ID, returnFocusTo: null }}
          snapshot={null}
          settings={defaultSettings}
          request={vi.fn()}
          onClose={vi.fn()}
          onAttached={vi.fn()}
          onOpenProviderSetup={vi.fn()}
          onOpenBackendSetup={vi.fn()}
        />
      </Window>,
    );
    await settle();
    expect(screen.queryByText("Window failed")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeInTheDocument();
  });

  it("shows a finding as plain text when the Markdown chunk fails", async () => {
    render(
      <Window>
        <WatcherFindingCard
          item={finding(3, "The parser drops trailing commas.")}
          motionIndex={0}
          enter={false}
          onEntered={vi.fn()}
          projectRoot="/workspace"
          projectId="project"
          watchedConversationId={WATCHED_ID}
          watchedRunning={false}
          steerable={false}
          sending={false}
          failure={null}
          online
          onDeliver={vi.fn()}
          onDismiss={vi.fn()}
          statusRef={vi.fn()}
          cardRef={vi.fn()}
        />
      </Window>,
    );
    await settle();
    expect(screen.queryByText("Window failed")).not.toBeInTheDocument();
    expect(screen.getByText("The parser drops trailing commas.")).toBeInTheDocument();
  });
});
