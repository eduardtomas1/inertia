import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const prefetchWorkspaceTool = vi.hoisted(() => vi.fn());

vi.mock("../../src/renderer/src/components/lazySurfaceLoaders", () => ({
  prefetchWorkspaceTool,
}));

import { WorkspacePanel } from "../../src/renderer/src/components/WorkspacePanel";

describe("workspace tool intent prefetch", () => {
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

    fireEvent.keyDown(screen.getByRole("tab", { name: "Environment" }), {
      key: "End",
    });
    expect(screen.getByRole("tab", { name: "Preview" })).toHaveFocus();
  });
});
