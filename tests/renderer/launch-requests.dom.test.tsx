import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Project } from "../../src/shared/contracts";
import type { DesktopBridge, LaunchProjectRequest } from "../../src/shared/desktop";
import { launchRequestProject, useLaunchRequests } from "../../src/renderer/src/hooks/useLaunchRequests";

const project = (id: string, path: string, extra: Partial<Project> = {}): Project => ({
  id, name: id, path, normalizedPath: path, repositoryIdentity: null, repositoryRoot: null,
  repositoryRelativePath: ".", groupingMode: null, gitRepositoryLimit: 16, color: "#5661d8",
  status: "ready", createdAt: "2026-10-19T00:00:00.000Z", updatedAt: "2026-10-19T00:00:00.000Z", ...extra,
} as Project);

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
});

describe("launch request project matching", () => {
  const projects = [
    project("work", "/work"),
    project("app", "/work/app"),
    project("linked", "/home/me/linked", { normalizedPath: "/data/real" }),
    project("scratch", "/home/me/.inertia/scratch", { workspaceKind: "scratch" }),
  ];

  it("opens the deepest project that is or contains the folder", () => {
    expect(launchRequestProject(projects, { path: "/work/app", realPath: "/work/app" })?.id).toBe("app");
    expect(launchRequestProject(projects, { path: "/work/app/src/lib", realPath: null })?.id).toBe("app");
    expect(launchRequestProject(projects, { path: "/work/other", realPath: null })?.id).toBe("work");
  });

  it("matches through the real folder, never by a name prefix, and never the chats-without-a-project folder", () => {
    expect(launchRequestProject(projects, { path: "/mnt/alias", realPath: "/data/real/src" })?.id).toBe("linked");
    expect(launchRequestProject(projects, { path: "/workspace", realPath: null })).toBeNull();
    expect(launchRequestProject(projects, { path: "/home/me/.inertia/scratch/chat", realPath: null })).toBeNull();
  });
});

describe("useLaunchRequests", () => {
  it("takes pending requests once ready, opens known projects, adds new folders and listens for more", async () => {
    const pending: LaunchProjectRequest[][] = [
      [{ path: "/work/app/src", realPath: "/work/app/src" }, { path: "/new/site", realPath: "/real/site" }],
      [{ path: "/work/app", realPath: "/work/app" }],
    ];
    let notify = (): void => undefined;
    const unsubscribe = vi.fn();
    const takeLaunchRequests = vi.fn(async () => pending.shift() ?? []);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        takeLaunchRequests,
        onLaunchRequest: (listener: () => void) => { notify = listener; return unsubscribe; },
      } as unknown as DesktopBridge,
    });
    const openProject = vi.fn();
    const addProject = vi.fn(async () => undefined);
    const props = { ready: false, projects: [project("app", "/work/app")], openProject, addProject };
    const hook = renderHook((current: typeof props) => useLaunchRequests(current), { initialProps: props });
    expect(takeLaunchRequests).not.toHaveBeenCalled();

    hook.rerender({ ...props, ready: true });
    await waitFor(() => expect(addProject).toHaveBeenCalledWith("/real/site"));
    expect(openProject).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "app" }));

    await act(async () => notify());
    await waitFor(() => expect(openProject).toHaveBeenCalledTimes(2));
    hook.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps listening after adding a folder fails", async () => {
    const pending: LaunchProjectRequest[][] = [[{ path: "/bad", realPath: null }], [{ path: "/good", realPath: null }]];
    let notify = (): void => undefined;
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        takeLaunchRequests: async () => pending.shift() ?? [],
        onLaunchRequest: (listener: () => void) => { notify = listener; return () => undefined; },
      } as unknown as DesktopBridge,
    });
    const addProject = vi.fn(async (path: string) => { if (path === "/bad") throw new Error("Not a folder"); });
    renderHook(() => useLaunchRequests({ ready: true, projects: [], openProject: vi.fn(), addProject }));
    await waitFor(() => expect(addProject).toHaveBeenCalledWith("/bad"));
    await act(async () => notify());
    await waitFor(() => expect(addProject).toHaveBeenCalledWith("/good"));
  });
});
