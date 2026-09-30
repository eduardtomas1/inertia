import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultSettings, type ServerEvent } from "../../src/shared/contracts";
import { parseServerEvent } from "../../src/shared/contracts/server-event-schema";
import type { InertiaConnection } from "../../src/renderer/src/hooks/useInertiaConnection";

const harness = vi.hoisted(() => ({ connection: null as unknown }));

vi.mock("../../src/renderer/src/hooks/useInertiaConnection", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/renderer/src/hooks/useInertiaConnection")>(),
  useInertiaConnection: () => harness.connection,
}));

const projectId = "61616161-6161-4161-8161-616161616161";
const now = "2026-09-28T10:00:00.000Z";

function legacyWelcome(): ServerEvent {
  const { completionSound: _completionSound, ...settings } = defaultSettings;
  return parseServerEvent({
    type: "server.welcome",
    protocolVersion: 1,
    snapshot: {
      projects: [{
        id: projectId,
        name: "Legacy project",
        path: "/workspace/legacy",
        normalizedPath: "/workspace/legacy",
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
      settings,
      activeProjectId: projectId,
      activeConversationId: null,
    },
  });
}

beforeEach(() => {
  const welcome = legacyWelcome();
  if (welcome.type !== "server.welcome") throw new Error(welcome.type);
  harness.connection = {
    snapshot: welcome.snapshot,
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
  Reflect.deleteProperty(window, "inertia");
});

describe("a snapshot from a runtime that predates completion sounds", () => {
  it("renders the workbench with the sound off", async () => {
    const { default: App } = await import("../../src/renderer/src/App");
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent): void => { errors.push(event.error); };
    window.addEventListener("error", onError);
    try {
      render(<App />);
      await act(async () => { await vi.dynamicImportSettled(); });
      expect(await screen.findAllByText("Legacy project")).not.toHaveLength(0);
    } finally {
      window.removeEventListener("error", onError);
    }
    expect(errors).toEqual([]);
  });
});
