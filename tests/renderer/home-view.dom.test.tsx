import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { HomeView } from "../../src/renderer/src/components/HomeView";
import type { Project } from "../../src/shared/contracts";

const projects: Project[] = [
  {
    id: "project-inertia",
    name: "Inertia",
    path: "/workspace/inertia",
    normalizedPath: "/workspace/inertia",
    repositoryIdentity: "git:/workspace/inertia/.git",
    repositoryRoot: "/workspace/inertia",
    repositoryRelativePath: ".",
    groupingMode: null,
    gitRepositoryLimit: 64,
    color: "#6366f1",
    status: "ready",
    createdAt: "2026-09-01T08:00:00.000Z",
    updatedAt: "2026-09-01T08:00:00.000Z",
  },
  {
    id: "project-studio",
    name: "Studio",
    path: "/workspace/acme/apps/studio",
    normalizedPath: "/workspace/acme/apps/studio",
    repositoryIdentity: "git:/workspace/acme/.git",
    repositoryRoot: "/workspace/acme",
    repositoryRelativePath: "apps/studio",
    groupingMode: null,
    gitRepositoryLimit: 64,
    color: "#2d8a64",
    status: "working",
    createdAt: "2026-09-01T09:00:00.000Z",
    updatedAt: "2026-09-01T09:00:00.000Z",
  },
];

describe("global project launcher", () => {
  it("starts a normal chat in the chosen existing project", () => {
    const onCreateConversation = vi.fn();
    render(
      <HomeView
        projects={projects}
        connectionStatus="online"
        importingProject={false}
        onCreateConversation={onCreateConversation}
        onImportProject={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", {
      name: "What should we build today?",
    })).toBeVisible();
    expect(screen.getByRole("list", { name: "Choose a project" }))
      .toBeVisible();
    expect(screen.getByText("/workspace/inertia")).toBeVisible();
    expect(screen.getByText("apps/studio")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "New chat in Studio" }));

    expect(onCreateConversation).toHaveBeenCalledOnce();
    expect(onCreateConversation).toHaveBeenCalledWith(projects[1]);
  });

  it("keeps project actions safe while the runtime is offline", () => {
    render(
      <HomeView
        projects={projects}
        connectionStatus="offline"
        importingProject={false}
        onCreateConversation={vi.fn()}
        onImportProject={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "New chat in Inertia" }))
      .toBeDisabled();
    expect(screen.getByRole("button", { name: "Add project" }))
      .toBeDisabled();
  });

  it("offers project import when no projects exist", () => {
    const onImportProject = vi.fn();
    render(
      <HomeView
        projects={[]}
        connectionStatus="online"
        importingProject={false}
        onCreateConversation={vi.fn()}
        onImportProject={onImportProject}
      />,
    );

    expect(screen.getByText("Add a project before starting your first chat."))
      .toBeVisible();
    expect(screen.queryByRole("list", { name: "Choose a project" }))
      .not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add project" }));
    expect(onImportProject).toHaveBeenCalledOnce();
  });
});
