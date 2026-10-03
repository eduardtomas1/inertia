import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { BackendProfileController } from "../../src/server/runtime/backends/backend-profile-controller";
import { createSettingsBackendCommandHandler, type SettingsBackendCommandDependencies } from "../../src/server/runtime/commands/settings-backend-commands";
import { clientCommandSchema } from "../../src/shared/contracts/client-command";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function openStore(): Promise<{ store: RuntimeStore; workspacePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-new-chat-default-"));
  temporaryDirectories.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  return { store: new RuntimeStore(join(directory, "inertia.sqlite"), workspacePath), workspacePath };
}

const command = (payload: unknown) => ({ type: "settings.default-model.set", requestId: crypto.randomUUID(), payload });

describe("new-chat default model command", () => {
  it("accepts a native provider choice and rejects malformed payloads", () => {
    expect(clientCommandSchema.safeParse(command({ defaultProvider: "claude", defaultModel: "opus", defaultReasoningEffort: "" })).success).toBe(true);
    for (const invalid of [
      {},
      { defaultProvider: "nobody", defaultModel: "", defaultReasoningEffort: "" },
      { defaultProvider: "claude", defaultModel: "x".repeat(161), defaultReasoningEffort: "" },
      { defaultProvider: "claude", defaultModel: "", defaultReasoningEffort: "", extra: true },
    ]) expect(clientCommandSchema.safeParse(command(invalid)).success).toBe(false);
  });

  it("writes the provider default and clears the global backend default in one step, keeping project defaults", async () => {
    const { store, workspacePath } = await openStore();
    const project = store.createProject("Project", workspacePath);
    store.saveModelBackendDefault(null, providerNativeModelSelection({ providerId: "codex", modelId: "gpt", alias: "gpt" }));
    store.saveModelBackendDefault(project.id, providerNativeModelSelection({ providerId: "claude", modelId: "haiku", alias: "haiku" }));
    const controller = await BackendProfileController.create({ store });
    const handler = createSettingsBackendCommandHandler({
      store,
      backendProfileController: controller,
      providerMaintenanceBlocked: () => false,
      broadcastSnapshot: vi.fn(),
      send: vi.fn(),
    } as unknown as SettingsBackendCommandDependencies);

    const parsed = clientCommandSchema.parse(command({ defaultProvider: "claude", defaultModel: "opus", defaultReasoningEffort: "" }));
    await expect(handler({} as WebSocket, parsed)).resolves.toBe("mutation");

    expect(store.snapshot().settings).toMatchObject({ defaultProvider: "claude", defaultModel: "opus", defaultReasoningEffort: "" });
    expect(store.listModelBackendDefaults().map(({ scope }) => scope)).toEqual(["project"]);
    store.close();
  });
});
