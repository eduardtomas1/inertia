// @inertia-test-suite portable
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProviderInfo } from "../../src/shared/contracts";
import { codexAutoCompactTokenLimit, DEFAULT_CODEX_AUTO_COMPACT_LIMIT } from "../../src/shared/compact-on-return";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { RuntimeStore } from "../../src/server/database";
import { validateProviderRunInput } from "../../src/server/provider/adapters";
import type { ProviderId, ProviderRunInput } from "../../src/server/provider/contracts";
import { ProviderManager } from "../../src/server/providers";
import type { TurnProviderRuntime } from "../../src/server/runtime/turns/turn-controller-types";
import { resolveTurnRequest } from "../../src/server/runtime/turns/turn-request-preparation";
import { captured, fakeAppServer } from "../helpers/codex-app-server-fixture";
import { removePortableFixture } from "../helpers/portable-provider-fixture";
import { nativeProviderRunFields, nativeProviderRunInput, resolveNativeModelRoute } from "./model-route-fixture";

const directories: string[] = [];
const stores: RuntimeStore[] = [];
const managers: ProviderManager[] = [];
const roots: string[] = [];
let sequence = 0;

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
  await Promise.all(roots.splice(0).map(removePortableFixture));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function runInput(providerId: ProviderId, overrides: Partial<ProviderRunInput> = {}): ProviderRunInput {
  return {
    ...nativeProviderRunFields(providerId),
    conversationId: "conversation-1",
    runId: "run-1",
    turnId: "turn-1",
    cwd: "/workspace",
    prompt: "Inspect this project",
    interactionMode: "build",
    access: "supervised",
    ...overrides,
  } as ProviderRunInput;
}

function providerInfo(id: ProviderId): ProviderInfo {
  const metadata = {
    freshness: "fresh" as const,
    provenance: "provider" as const,
    updatedAt: "2030-01-01T00:00:00.000Z",
    lastAttemptedAt: "2030-01-01T00:00:00.000Z",
    refreshing: false,
  };
  return {
    id, label: id, command: id, available: true, version: "test", executable: id,
    installState: "installed", authState: "authenticated", canRun: true, statusMessage: null,
    models: [{
      id: `${id}-default`, label: `${id} default`, description: "", isDefault: true, inputModalities: ["text"],
      reasoningOptions: [{ value: "high", label: "High", description: "" }], defaultReasoningEffort: "high", fastMode: null,
    }],
    rateLimits: [],
    metadataState: { models: metadata, rateLimits: metadata },
  };
}

async function runtimeStore(): Promise<{ store: RuntimeStore; projectId: string }> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-codex-compaction-limit-"));
  directories.push(directory);
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const store = new RuntimeStore(join(directory, "runtime.sqlite"), workspace, { recoverInterruptedRuns: false });
  stores.push(store);
  return { store, projectId: store.createProject("Codex limit", workspace).id };
}

function resolveFor(store: RuntimeStore, conversationId: string): ProviderRunInput {
  const resolved = resolveTurnRequest({
    store,
    providers: {
      resolveModelRoute: resolveNativeModelRoute,
      harnessIdFor: (input: ProviderRunInput) => input.harnessId,
    } as unknown as TurnProviderRuntime,
    hooks: { broadcast: () => undefined, broadcastSnapshot: () => undefined, providerInfo: () => [providerInfo("claude"), providerInfo("codex")] },
    id: () => `codex-limit-${++sequence}`,
    now: () => "2030-01-01T00:00:00.000Z",
    clock: () => new Date("2030-01-01T00:00:00.000Z"),
  }, { conversationId, content: "Do the work." });
  return resolved.adopt(store.beginAgentTurn(resolved.input)).active.providerInput;
}

function reportWindow(store: RuntimeStore, conversationId: string, turnId: string, maxTokens: number): void {
  store.upsertUsage({
    conversationId, turnId, usedTokens: 120_000, totalProcessedTokens: null, totalProcessedScope: null, maxTokens,
    inputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, outputTokens: null,
    reasoningOutputTokens: null, compactsAutomatically: null,
  });
}

describe("Codex automatic compaction limit", () => {
  it("caps the setting at 90% of the model's context and leaves Codex alone without a window or a setting", () => {
    expect(DEFAULT_CODEX_AUTO_COMPACT_LIMIT).toBe(300_000);
    expect(codexAutoCompactTokenLimit(300_000, 475_000)).toBe(300_000);
    expect(codexAutoCompactTokenLimit(300_000, 258_400)).toBe(232_560);
    expect(codexAutoCompactTokenLimit(400_000, 400_000)).toBe(360_000);
    expect(codexAutoCompactTokenLimit(null, 475_000)).toBeNull();
    expect(codexAutoCompactTokenLimit(300_000, null)).toBeNull();
    expect(codexAutoCompactTokenLimit(300_000, 100_000)).toBeNull();
    expect(codexAutoCompactTokenLimit(300_000, Number.NaN)).toBeNull();
  });

  it("accepts the limit on Codex runs only", () => {
    expect(validateProviderRunInput(runInput("codex", { autoCompactTokenLimit: 300_000 }))).toBe("conversation-1");
    for (const autoCompactTokenLimit of [99_999, 1_000_001, 250_000.5, null as unknown as number]) {
      expect(() => validateProviderRunInput(runInput("codex", { autoCompactTokenLimit })))
        .toThrow(expect.objectContaining({ code: "invalid_input", message: "The automatic compaction limit is invalid." }));
    }
    expect(() => validateProviderRunInput(runInput("claude", { autoCompactTokenLimit: 300_000 })))
      .toThrow(expect.objectContaining({ message: "The automatic compaction limit is invalid." }));
  });

  it("sends the limit once Codex has reported the chat's context window for the same model", async () => {
    const { store, projectId } = await runtimeStore();
    const codex = store.createConversation(projectId, "Codex", { modelSelection: providerNativeModelSelection({ providerId: "codex" }) });

    const first = resolveFor(store, codex.id);
    expect(first).not.toHaveProperty("autoCompactTokenLimit");
    reportWindow(store, codex.id, first.turnId, 475_000);

    const second = resolveFor(store, codex.id);
    expect(second).toMatchObject({ harnessId: "codex-app-server", autoCompactTokenLimit: 300_000 });
    expect(validateProviderRunInput(second)).toBe(codex.id);

    reportWindow(store, codex.id, second.turnId, 258_400);
    expect(resolveFor(store, codex.id)).toMatchObject({ autoCompactTokenLimit: 232_560 });

    store.updateSettings({ codexAutoCompactTokenLimit: null });
    expect(resolveFor(store, codex.id)).not.toHaveProperty("autoCompactTokenLimit");
  });

  it("waits for the new model's window after the chat switches Codex models, even when a turn on it ended without usage", async () => {
    const { store, projectId } = await runtimeStore();
    const codex = store.createConversation(projectId, "Codex", { modelSelection: providerNativeModelSelection({ providerId: "codex" }) });
    const first = resolveFor(store, codex.id);
    reportWindow(store, codex.id, first.turnId, 475_000);
    store.updateConversation(codex.id, { modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "codex-smaller" }) });

    expect(resolveFor(store, codex.id)).not.toHaveProperty("autoCompactTokenLimit");
    const retry = resolveFor(store, codex.id);
    expect(retry).not.toHaveProperty("autoCompactTokenLimit");

    reportWindow(store, codex.id, retry.turnId, 258_400);
    expect(resolveFor(store, codex.id)).toMatchObject({ autoCompactTokenLimit: 232_560 });
  });

  it("waits for the window of the chat's current backend after it switches backends on the same model", async () => {
    const { store, projectId } = await runtimeStore();
    const native = providerNativeModelSelection({ providerId: "codex", modelId: "gpt-shared" });
    const codex = store.createConversation(projectId, "Codex", {
      modelSelection: { ...native, backendProfileId: "openai-api-key-profile", backendProfileDisplayName: "OpenAI API key" },
    });
    const first = resolveFor(store, codex.id);
    reportWindow(store, codex.id, first.turnId, 1_000_000);
    store.updateConversation(codex.id, { modelSelection: native });

    const switched = resolveFor(store, codex.id);
    expect(switched).not.toHaveProperty("autoCompactTokenLimit");

    reportWindow(store, codex.id, switched.turnId, 258_400);
    expect(resolveFor(store, codex.id)).toMatchObject({ autoCompactTokenLimit: 232_560 });
  });

  it("ignores usage that names no turn", async () => {
    const { store, projectId } = await runtimeStore();
    const codex = store.createConversation(projectId, "Codex", { modelSelection: providerNativeModelSelection({ providerId: "codex" }) });
    resolveFor(store, codex.id);
    store.upsertUsage({
      conversationId: codex.id, turnId: null, usedTokens: 120_000, totalProcessedTokens: null, totalProcessedScope: null,
      maxTokens: 475_000, inputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, outputTokens: null,
      reasoningOutputTokens: null, compactsAutomatically: null,
    });
    expect(resolveFor(store, codex.id)).not.toHaveProperty("autoCompactTokenLimit");
  });

  it("does not send the limit on Claude turns", async () => {
    const { store, projectId } = await runtimeStore();
    const claude = store.createConversation(projectId, "Claude", { modelSelection: providerNativeModelSelection({ providerId: "claude" }) });
    const first = resolveFor(store, claude.id);
    reportWindow(store, claude.id, first.turnId, 1_000_000);
    expect(resolveFor(store, claude.id)).not.toHaveProperty("autoCompactTokenLimit");
  });

  it("passes the limit to Codex in the thread config on start and resume, and nothing without one", async () => {
    const fake = fakeAppServer(roots);
    const manager = ProviderManager.createForTests({
      commands: { codex: fake.command },
      resolveBackendLaunchOptions: (_input, environment) => ({
        environment: { ...environment, INERTIA_APP_SERVER_CAPTURE: fake.capturePath },
      }),
    });
    managers.push(manager);
    const run = (conversationId: string, extra: Partial<ProviderRunInput>) => manager.run({
      ...nativeProviderRunInput({
        providerId: "codex", conversationId, cwd: fake.root, prompt: "Hello", interactionMode: "build", access: "supervised",
      }),
      ...extra,
    }, {
      onApproval: (event) => expect(manager.respondToApproval(event.conversationId, event.request.requestId, "approve", { runId: event.runId, turnId: event.turnId })).toBe(true),
      onInput: (event) => expect(manager.respondToInput(event.conversationId, event.request.requestId, { choice: ["Safe"] }, { runId: event.runId, turnId: event.turnId })).toBe(true),
    });

    await run("codex-limit-start", { autoCompactTokenLimit: 300_000 });
    await run("codex-limit-resume", { autoCompactTokenLimit: 232_560, sessionId: "thread-existing" });
    await run("codex-limit-none", {});

    const messages = captured(fake.capturePath);
    const starts = messages.filter(({ method }) => method === "thread/start").map(({ params }) => params as Record<string, unknown>);
    const resume = messages.find(({ method }) => method === "thread/resume")?.params as Record<string, unknown>;
    expect(starts[0]?.config).toEqual({ model_auto_compact_token_limit: 300_000 });
    expect(resume.config).toEqual({ model_auto_compact_token_limit: 232_560 });
    expect(starts[1]).not.toHaveProperty("config");
  });
});
