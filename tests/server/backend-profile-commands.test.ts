import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { BackendProfileController } from "../../src/server/runtime/backends/backend-profile-controller";
import {
  createSettingsBackendCommandHandler,
  type SettingsBackendCommandDependencies,
} from "../../src/server/runtime/commands/settings-backend-commands";
import { clientCommandSchema } from "../../src/shared/contracts/client-command";

const directories: string[] = [];
const stores: RuntimeStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function runtimeStore(): Promise<RuntimeStore> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-backend-commands-"));
  directories.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const store = new RuntimeStore(join(directory, "inertia.sqlite"), workspacePath);
  stores.push(store);
  return store;
}

function command(type: string, payload: unknown) {
  return clientCommandSchema.parse({ type, requestId: crypto.randomUUID(), payload });
}

describe("backend profile commands", () => {
  it("creates a preset profile under its catalogue harness maintenance guard", async () => {
    const store = await runtimeStore();
    const send = vi.fn();
    let blockedProvider: string | null = "claude";
    const handler = createSettingsBackendCommandHandler({
      store,
      backendProfileController: await BackendProfileController.create({ store }),
      providerMaintenanceBlocked: (providerId: string) => providerId === blockedProvider,
      broadcastSnapshot: vi.fn(),
      send,
    } as unknown as SettingsBackendCommandDependencies);
    const create = command("backend.profile.create", { preset: "anthropic-api-key" });

    await expect(handler({} as WebSocket, create)).rejects.toThrow("maintenance owns it");
    expect(store.listModelBackendProfiles()).toEqual([]);

    blockedProvider = null;
    await expect(handler({} as WebSocket, create)).resolves.toBe("handled");
    expect(send).toHaveBeenCalledWith({}, {
      type: "request.result",
      requestId: create.requestId,
      result: {
        kind: "backend.profile",
        profile: expect.objectContaining({
          preset: "anthropic-api-key",
          harnessId: "claude-agent-sdk",
          routeKind: "api-key",
          providerId: "claude",
        }),
      },
    });
  });

  it("tells the renderer when an address change removed the saved key", async () => {
    const detail = { id: "custom:gateway", harnessId: "claude-agent-sdk" };
    const controller = {
      detail: vi.fn(() => detail),
      updateProfileWithOutcome: vi.fn()
        .mockResolvedValueOnce({ profile: detail, credentialCleared: true })
        .mockResolvedValueOnce({ profile: detail, credentialCleared: false }),
    };
    const send = vi.fn();
    const handler = createSettingsBackendCommandHandler({
      backendProfileController: controller,
      providerMaintenanceBlocked: () => false,
      broadcastSnapshot: vi.fn(),
      send,
    } as unknown as SettingsBackendCommandDependencies);
    const moved = command("backend.profile.update", {
      profileId: "custom:gateway",
      update: { baseUrl: "https://moved.example.test" },
    });
    const renamed = command("backend.profile.update", {
      profileId: "custom:gateway",
      update: { displayName: "Renamed" },
    });

    await handler({} as WebSocket, moved);
    await handler({} as WebSocket, renamed);

    expect(send.mock.calls.map(([, event]) => event)).toEqual([
      {
        type: "request.result",
        requestId: moved.requestId,
        result: { kind: "backend.profile", profile: detail, credentialCleared: true },
      },
      {
        type: "request.result",
        requestId: renamed.requestId,
        result: { kind: "backend.profile", profile: detail },
      },
    ]);
  });

  it("forwards requested probe models and returns discovered models", async () => {
    const detail = { id: "custom:gateway", harnessId: "codex-app-server" };
    const models = {
      kind: "backend.profile.models" as const,
      profileId: "custom:gateway",
      models: [{ id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" }],
    };
    const controller = {
      detail: vi.fn(() => detail),
      probeWithOutcome: vi.fn(async () => ({ profile: detail, skippedModelIds: ["gpt-6.1-mini"] })),
      discoverModels: vi.fn(async () => models),
    };
    const send = vi.fn();
    const handler = createSettingsBackendCommandHandler({
      backendProfileController: controller,
      providerMaintenanceBlocked: () => false,
      broadcastSnapshot: vi.fn(),
      send,
    } as unknown as SettingsBackendCommandDependencies);

    const probe = command("backend.profile.probe", {
      profileId: "custom:gateway",
      modelIds: ["gpt-6.1-sol", "gpt-6.1-mini"],
    });
    await handler({} as WebSocket, probe);
    expect(send).toHaveBeenCalledWith({}, {
      type: "request.result",
      requestId: probe.requestId,
      result: { kind: "backend.profile.probe", profile: detail, skippedModelIds: ["gpt-6.1-mini"] },
    });
    await handler({} as WebSocket, command("backend.profile.probe", { profileId: "custom:gateway" }));
    const discover = command("backend.profile.discover-models", { profileId: "custom:gateway" });
    await expect(handler({} as WebSocket, discover)).resolves.toBe("handled");

    expect(controller.probeWithOutcome.mock.calls).toEqual([
      ["custom:gateway", ["gpt-6.1-sol", "gpt-6.1-mini"]],
      ["custom:gateway", undefined],
    ]);
    expect(send).toHaveBeenLastCalledWith({}, {
      type: "request.result",
      requestId: discover.requestId,
      result: models,
    });
  });
});
