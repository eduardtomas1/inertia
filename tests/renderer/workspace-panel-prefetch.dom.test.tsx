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
});
