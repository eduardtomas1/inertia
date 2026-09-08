import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeGenerationLeaseJournal } from
  "../../src/node/runtime-generation-leases";
import { startRuntime } from "../../src/server";
import { RuntimeStore } from "../../src/server/database";
import { ProviderManager } from "../../src/server/providers";
import type { TurnControllerHooks } from
  "../../src/server/runtime/turns/turn-controller";
import { RuntimeTestCleanup } from "../support/runtime-test-cleanup";

const observed = vi.hoisted(() => ({ hooks: null as TurnControllerHooks | null }));
vi.mock("../../src/server/runtime/turns/turn-controller", async (importOriginal) => {
  const actual = await importOriginal<typeof import(
    "../../src/server/runtime/turns/turn-controller"
  )>();
  return {
    ...actual,
    TurnController: class extends actual.TurnController {
      constructor(...args: ConstructorParameters<typeof actual.TurnController>) {
        super(...args);
        observed.hooks = args[5];
      }
    },
  };
});

const cleanup = new RuntimeTestCleanup();
afterEach(async () => {
  try {
    await cleanup.close();
  } finally {
    observed.hooks = null;
    vi.restoreAllMocks();
  }
});

describe("completed-turn provider metadata", () => {
  it.each([false, true])("respects provider execution enabled=%s", async (enableProviders) => {
    const root = mkdtempSync(join(tmpdir(), "inertia-turn-metadata-"));
    cleanup.directories.push(root);
    const dataDirectory = join(root, "data");
    const workspace = join(root, "workspace");
    mkdirSync(dataDirectory, { mode: 0o700 });
    mkdirSync(workspace);
    const store = new RuntimeStore(join(dataDirectory, "inertia.sqlite"), workspace);
    const project = store.createProject("Metadata fixture", workspace);
    const conversation = store.createConversation(project.id, "Completed turn");
    const { turn } = store.beginAgentTurn({
      conversationId: conversation.id,
      runId: randomUUID(),
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "builtin:openai",
      model: "fixture-model",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: 0,
      association: "authoritative",
      content: "Synthetic completed turn",
    });
    store.updateAgentTurnLifecycle(turn.id, { status: "completed" });
    store.close();
    const runtimeGenerationId = `${randomUUID()}:1`;
    const systemBootId = `test:${randomUUID()}`;
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).publish(
      runtimeGenerationId,
      systemBootId,
    )).toBe(true);

    const detect = vi.spyOn(ProviderManager.prototype, "detect")
      .mockRejectedValue(new Error("This fixture must never discover a host CLI."));
    const metadata = vi.spyOn(ProviderManager.prototype, "metadata")
      .mockImplementation(async function (this: ProviderManager, providerId) {
        return this.cachedMetadata(providerId);
      });
    // Do not start passive discovery: exercise the runtime's actual settlement
    // callback with a completed persisted turn and an entirely synthetic provider.
    const runtime = await startRuntime({
      dataDirectory,
      defaultWorkspacePath: workspace,
      enableProviders,
      runtimeGenerationId,
      systemBootId,
    });
    cleanup.runtimes.push(runtime);
    const refresh = observed.hooks?.refreshProviderMetadata;
    expect(refresh).toBeTypeOf("function");
    await refresh!({
      providerId: "codex",
      conversationId: conversation.id,
      turnId: turn.id,
      runStartedAt: Date.now() - 1_000,
      status: "completed",
    });

    expect(detect).not.toHaveBeenCalled();
    expect(metadata).toHaveBeenCalledTimes(enableProviders ? 1 : 0);
    if (enableProviders) {
      expect(metadata).toHaveBeenCalledWith("codex", workspace, {
        fields: ["models", "rateLimits"],
        force: true,
        signal: expect.any(AbortSignal),
      });
    }
  });
});
