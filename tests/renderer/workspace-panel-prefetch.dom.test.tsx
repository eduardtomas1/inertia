import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prefetchWorkspaceTool = vi.hoisted(() => vi.fn());

vi.mock("../../src/renderer/src/components/lazySurfaceLoaders", () => ({
  prefetchWorkspaceTool,
}));

import {
  WorkspacePanel,
  type WorkspacePanelTab,
} from "../../src/renderer/src/components/WorkspacePanel";

describe("workspace tool intent prefetch", () => {
  beforeEach(() => {
    prefetchWorkspaceTool.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps Environment primary while exposing settings and the other tools", () => {
    const onTabChange = vi.fn();
    const onOpenSettings = vi.fn();
    render(
      <WorkspacePanel
        activeTab="environment"
        onTabChange={onTabChange}
        onOpenSettings={onOpenSettings}
        tabs={["environment", "changes", "terminal"]}
      >
        <span>Environment panel</span>
      </WorkspacePanel>,
    );

    expect(screen.getByRole("tab", { name: "Environment" }))
      .toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: "Environment settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();

    const chooser = screen.getByLabelText("Choose workspace tool");
    const disclosure = chooser.closest("details")!;
    fireEvent.click(chooser);
    expect(disclosure).toHaveAttribute("open");
    const terminal = screen.getByRole("button", { name: "Terminal" });
    fireEvent.pointerEnter(terminal);
    fireEvent.focus(terminal);
    expect(prefetchWorkspaceTool).toHaveBeenCalledWith("terminal");
    fireEvent.click(terminal);
    expect(onTabChange).toHaveBeenCalledWith("terminal");
    expect(disclosure).not.toHaveAttribute("open");

    fireEvent.click(chooser);
    expect(disclosure).toHaveAttribute("open");
    fireEvent.blur(disclosure, { relatedTarget: document.body });
    expect(disclosure).not.toHaveAttribute("open");
  });

  it("starts the local chunk before activating a tab", () => {
    render(
      <WorkspacePanel activeTab="changes" onTabChange={() => undefined}>
        <span>Current panel</span>
      </WorkspacePanel>,
    );
    const files = screen.getByRole("tab", { name: "Files" });

    fireEvent.pointerEnter(files);
    fireEvent.focus(files);
    fireEvent.pointerDown(files);

    expect(prefetchWorkspaceTool).toHaveBeenCalledWith("files");
    expect(prefetchWorkspaceTool).toHaveBeenCalledTimes(3);
  });

  it("moves and selects tabs with standard arrow, Home, and End keys", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const onTabChange = vi.fn();
    function Harness(): React.JSX.Element {
      const [activeTab, setActiveTab] = useState<WorkspacePanelTab>("changes");
      return (
        <WorkspacePanel
          activeTab={activeTab}
          onTabChange={(tab) => {
            onTabChange(tab);
            setActiveTab(tab);
          }}
        >
          <span>Current panel</span>
        </WorkspacePanel>
      );
    }
    render(
      <Harness />,
    );
    const flushFocusFrame = () => {
      act(() => frames.shift()?.(performance.now()));
    };
    const changes = screen.getByRole("tab", { name: "Changes" });
    changes.focus();

    fireEvent.keyDown(changes, { key: "ArrowLeft" });
    flushFocusFrame();
    expect(screen.getByRole("tab", { name: "Environment" })).toHaveFocus();
    expect(onTabChange).toHaveBeenLastCalledWith("environment");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Environment" }), {
      key: "ArrowRight",
    });
    flushFocusFrame();
    expect(screen.getByRole("tab", { name: "Changes" })).toHaveFocus();
    expect(onTabChange).toHaveBeenLastCalledWith("changes");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Changes" }), {
      key: "ArrowLeft",
    });
    flushFocusFrame();
    expect(screen.getByRole("tab", { name: "Environment" })).toHaveFocus();

    fireEvent.click(screen.getByLabelText("Choose workspace tool"));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }), {
      detail: 0,
    });
    flushFocusFrame();
    expect(screen.getByRole("tab", { name: "Preview" })).toHaveFocus();
    expect(onTabChange).toHaveBeenLastCalledWith("preview");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Preview" }), {
      key: "Home",
    });
    flushFocusFrame();
    expect(screen.getByRole("tab", { name: "Environment" })).toHaveFocus();
    expect(onTabChange).toHaveBeenLastCalledWith("environment");

    fireEvent.click(screen.getByLabelText("Choose workspace tool"));
    fireEvent.click(screen.getByRole("button", { name: "Changes" }), {
      detail: 0,
    });
    flushFocusFrame();
    expect(screen.getByRole("tab", { name: "Changes" })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("tab", { name: "Changes" }), {
      key: "End",
    });
    flushFocusFrame();
    expect(screen.getByRole("tab", { name: "Preview" })).toHaveFocus();
    expect(onTabChange).toHaveBeenLastCalledWith("preview");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Preview" }), {
      key: "ArrowRight",
    });
    flushFocusFrame();
    expect(screen.getByRole("tab", { name: "Environment" })).toHaveFocus();
    expect(onTabChange).toHaveBeenLastCalledWith("environment");
  });
});
