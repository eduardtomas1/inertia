import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultSettings, type ServerEvent } from "../../src/shared/contracts";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";
import type { InertiaConnection } from "../../src/renderer/src/hooks/useInertiaConnection";

const harness = vi.hoisted(() => ({ connection: null as unknown }));

vi.mock("../../src/renderer/src/hooks/useInertiaConnection", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/renderer/src/hooks/useInertiaConnection")>(),
  useInertiaConnection: () => harness.connection,
}));

const projectId = "71717171-7171-4171-8171-717171717171";
const now = "2026-10-14T10:00:00.000Z";

function welcome(): ServerEvent {
  return parseServerEvent({
    type: "server.welcome",
    protocolVersion: 1,
    snapshot: {
      projects: [{
        id: projectId,
        name: "Preload project",
        path: "/workspace/preload",
        normalizedPath: "/workspace/preload",
        repositoryIdentity: null,
        repositoryRoot: null,
        repositoryRelativePath: "",
        groupingMode: null,
        gitRepositoryLimit: 64,
        color: "#6366f1",
        status: "ready",
        createdAt: now,
        updatedAt: now,
      }],
      conversations: [],
      runs: [],
      providers: [],
      settings: defaultSettings,
      activeProjectId: projectId,
      activeConversationId: null,
    },
  });
}

beforeEach(() => {
  const event = welcome();
  if (event.type !== "server.welcome") throw new Error(event.type);
  harness.connection = {
    snapshot: event.snapshot,
    runtimeGeneration: null,
    status: "online",
    error: null,
    databaseRecoveryNotice: null,
    dismissDatabaseRecoveryNotice: () => undefined,
    clearError: () => undefined,
    sendCommand: async () => await new Promise<ServerEvent>(() => undefined),
    subscribe: () => () => undefined,
  } satisfies InertiaConnection;
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: new Proxy({}, {
      get: (_target, key) => {
        if (key === "getPlatform") return () => "darwin";
        if (key === "getDetachedChatWindows") return async () => [];
        if (key === "getPendingDetachedChatDrafts") return async () => [];
        if (typeof key === "string" && key.startsWith("on")) return () => () => undefined;
        return () => new Promise(() => undefined);
      },
    }),
  });
});

afterEach(() => {
  cleanup();
  vi.doUnmock("../../src/renderer/src/components/TasksView");
  Reflect.deleteProperty(window, "inertia");
});

async function renderPreloadedWorkbench(): Promise<HTMLElement> {
  vi.resetModules();
  const { default: App } = await import("../../src/renderer/src/App");
  const { WindowErrorBoundary } = await import("../../src/renderer/src/components/WindowErrorBoundary");
  const { prefetchFrequentSurfaces } = await import("../../src/renderer/src/components/lazySurfaceLoaders");
  const view = render(<WindowErrorBoundary><App /></WindowErrorBoundary>);
  await act(async () => { await vi.dynamicImportSettled(); });
  await waitFor(() => expect(view.container.querySelector(".sidebar-footer")).not.toBeNull());
  await act(async () => {
    prefetchFrequentSurfaces();
    await vi.dynamicImportSettled();
  });
  return view.container;
}

function footerButton(container: HTMLElement, name: string): HTMLElement {
  const footer = container.querySelector<HTMLElement>(".sidebar-footer");
  if (!footer) throw new Error("The sidebar footer is missing.");
  const button = [...footer.querySelectorAll<HTMLElement>("button")]
    .find((candidate) => candidate.getAttribute("aria-label") === name || candidate.textContent?.trim() === name);
  if (!button) throw new Error(`The ${name} button is missing.`);
  return button;
}

describe("screens preloaded at idle", () => {
  it("opens Usage and its Limits tab on the first commit", async () => {
    const container = await renderPreloadedWorkbench();

    act(() => { fireEvent.click(footerButton(container, "Usage")); });

    expect(container.querySelector(".usage-view")).not.toBeNull();
    expect(container.querySelector(".usage-surface-loading")).toBeNull();

    act(() => {
      fireEvent.click(within(screen.getByRole("group", { name: "Usage section" })).getByRole("button", { name: "Limits" }));
    });

    expect(container.querySelector(".usage-limits-panel")).not.toBeNull();
    expect(screen.queryByLabelText("Loading limits")).toBeNull();
  });

  it("opens Tasks on the first commit", async () => {
    const container = await renderPreloadedWorkbench();
    const tasks = container.querySelector<HTMLElement>(".sidebar-tasks-action");
    if (!tasks) throw new Error("The Tasks button is missing.");

    act(() => { fireEvent.click(tasks); });

    expect(container.querySelector(".tasks-view")).not.toBeNull();
    expect(container.querySelector(".tasks-view-loading")).toBeNull();
  });

  it("opens Daily work on the first commit", async () => {
    const container = await renderPreloadedWorkbench();

    act(() => { fireEvent.click(footerButton(container, "Daily work")); });

    expect(document.querySelector(".daily-work-dialog")).not.toBeNull();
  });

  it("still reports a screen whose code cannot load", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      vi.doMock("../../src/renderer/src/components/TasksView", () => {
        throw new Error("missing chunk");
      });
      const container = await renderPreloadedWorkbench();
      const tasks = container.querySelector<HTMLElement>(".sidebar-tasks-action");
      if (!tasks) throw new Error("The Tasks button is missing.");

      await act(async () => {
        fireEvent.click(tasks);
        await vi.dynamicImportSettled();
      });

      expect(await screen.findByRole("alert")).toHaveTextContent("This window could not finish loading.");
      expect(screen.getByRole("button", { name: "Reload window" })).toBeEnabled();
    } finally {
      error.mockRestore();
    }
  });
});
