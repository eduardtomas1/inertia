import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prefetchWorkspaceTool = vi.hoisted(() => vi.fn());

vi.mock("../../src/renderer/src/components/lazySurfaceLoaders", () => ({
  prefetchWorkspaceTool,
}));

import { WorkspacePanel } from "../../src/renderer/src/components/WorkspacePanel";

describe("workspace tool intent prefetch", () => {
  beforeEach(() => {
    prefetchWorkspaceTool.mockClear();
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
    const onTabChange = vi.fn();
    render(
      <WorkspacePanel activeTab="changes" onTabChange={onTabChange}>
        <span>Current panel</span>
      </WorkspacePanel>,
    );
    const changes = screen.getByRole("tab", { name: "Changes" });
    changes.focus();

    fireEvent.keyDown(changes, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Environment" })).toHaveFocus();
    expect(onTabChange).toHaveBeenLastCalledWith("environment");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Environment" }), {
      key: "ArrowLeft",
    });
    expect(screen.getByRole("tab", { name: "Preview" })).toHaveFocus();
    expect(onTabChange).toHaveBeenLastCalledWith("preview");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Preview" }), {
      key: "Home",
    });
    expect(screen.getByRole("tab", { name: "Environment" })).toHaveFocus();
    expect(onTabChange).toHaveBeenLastCalledWith("environment");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Environment" }), {
      key: "End",
    });
    expect(screen.getByRole("tab", { name: "Preview" })).toHaveFocus();
    expect(onTabChange).toHaveBeenLastCalledWith("preview");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Preview" }), {
      key: "ArrowRight",
    });
    expect(screen.getByRole("tab", { name: "Environment" })).toHaveFocus();
    expect(onTabChange).toHaveBeenLastCalledWith("environment");
  });
});
