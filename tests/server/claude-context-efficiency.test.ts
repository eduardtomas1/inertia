// @inertia-test-suite portable
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Options as ClaudeOptions, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";

import type { ProviderInfo } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { RuntimeStore } from "../../src/server/database";
import { validateProviderRunInput } from "../../src/server/provider/adapters";
import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import { readClaudeContextUsage } from "../../src/server/provider/claude-usage";
import type { ProviderId, ProviderRunInput } from "../../src/server/provider/contracts";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import type { TurnProviderRuntime } from "../../src/server/runtime/turns/turn-controller-types";
import { resolveTurnRequest } from "../../src/server/runtime/turns/turn-request-preparation";
import { claudeSuccessResult, claudeSystem, fixtureClaudeQuery } from "../helpers/claude-agent-sdk-protocol";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
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
    id,
    label: id,
    command: id,
    available: true,
    version: "test",
    executable: id,
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    statusMessage: null,
    models: [{
      id: `${id}-default`,
      label: `${id} default`,
      description: "Current provider default",
      isDefault: true,
      inputModalities: ["text"],
      reasoningOptions: [{ value: "high", label: "High", description: "" }],
      defaultReasoningEffort: "high",
      fastMode: null,
    }],
    rateLimits: [],
    metadataState: { models: metadata, rateLimits: metadata },
  };
}

async function runtimeStore(): Promise<{ store: RuntimeStore; projectId: string }> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-claude-context-efficiency-"));
  directories.push(directory);
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const store = new RuntimeStore(join(directory, "runtime.sqlite"), workspace, { recoverInterruptedRuns: false });
  stores.push(store);
  return { store, projectId: store.createProject("Context", workspace).id };
}

function resolveFor(store: RuntimeStore, conversationId: string): ProviderRunInput {
  const resolved = resolveTurnRequest({
    store,
    providers: {
      resolveModelRoute: resolveNativeModelRoute,
      harnessIdFor: (input: ProviderRunInput) => input.harnessId,
    } as unknown as TurnProviderRuntime,
    hooks: {
      broadcast: () => undefined,
      broadcastSnapshot: () => undefined,
      providerInfo: () => [providerInfo("claude"), providerInfo("codex")],
    },
    id: () => `context-${conversationId}-${++sequence}`,
    now: () => "2030-01-01T00:00:00.000Z",
    clock: () => new Date("2030-01-01T00:00:00.000Z"),
  }, { conversationId, content: "Do the work." });
  return resolved.adopt(store.beginAgentTurn(resolved.input)).active.providerInput;
}

describe("Claude automatic compaction window", () => {
  it("accepts Claude Code's range on Claude runs only", () => {
    for (const autoCompactWindow of [100_000, 400_000, 1_000_000]) {
      expect(validateProviderRunInput(runInput("claude", { autoCompactWindow }))).toBe("conversation-1");
    }
    for (const autoCompactWindow of [99_999, 1_000_001, 250_000.5, Number.NaN, "400000" as unknown as number, null as unknown as number]) {
      expect(() => validateProviderRunInput(runInput("claude", { autoCompactWindow })))
        .toThrow(expect.objectContaining({ code: "invalid_input", message: "The automatic compaction window is invalid." }));
    }
    expect(() => validateProviderRunInput(runInput("codex", { autoCompactWindow: 400_000 })))
      .toThrow(expect.objectContaining({ message: "The automatic compaction window is invalid." }));
  });

  it("sends the saved window on Claude turns, nothing on other providers, and nothing for Claude Code's default", async () => {
    const { store, projectId } = await runtimeStore();
    const claude = store.createConversation(projectId, "Claude", {
      modelSelection: providerNativeModelSelection({ providerId: "claude" }),
    });
    const codex = store.createConversation(projectId, "Codex", {
      modelSelection: providerNativeModelSelection({ providerId: "codex" }),
    });

    const claudeInput = resolveFor(store, claude.id);
    expect(claudeInput).toMatchObject({ harnessId: "claude-agent-sdk", autoCompactWindow: 400_000 });
    expect(validateProviderRunInput(claudeInput)).toBe(claude.id);
    expect(resolveFor(store, codex.id)).not.toHaveProperty("autoCompactWindow");

    store.updateSettings({ claudeAutoCompactWindow: null });
    expect(resolveFor(store, claude.id)).not.toHaveProperty("autoCompactWindow");
    store.updateSettings({ claudeAutoCompactWindow: 200_000 });
    expect(resolveFor(store, claude.id)).toMatchObject({ autoCompactWindow: 200_000 });
  });

  it("passes the window to Claude Code in its launch settings", async () => {
    const root = portableFixtureRoot("Claude compaction window");
    roots.push(root);
    const captured: Array<ClaudeOptions | undefined> = [];
    const manager = ProviderManager.createForTests(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([createClaudeAgentSdkHarness({
        createQuery: ({ options }) => {
          captured.push(options);
          return fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
            yield claudeSystem("init");
            yield claudeSuccessResult("Provider response", "completed");
          })());
        },
      })]),
    );
    managers.push(manager);
    const input = nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-window",
      cwd: root,
      prompt: "Keep going",
      interactionMode: "build",
      access: "supervised",
    });

    await expect(manager.run({ ...input, autoCompactWindow: 300_000 })).resolves.toMatchObject({ status: "completed" });
    await expect(manager.run({ ...input, conversationId: "claude-default" })).resolves.toMatchObject({ status: "completed" });

    expect(captured[0]?.settings).toMatchObject({ autoCompactWindow: 300_000 });
    expect(captured[1]?.settings).not.toHaveProperty("autoCompactWindow");
  });
});

describe("Claude context usage reads", () => {
  it("asks for the summary so no token-count requests are made", async () => {
    const calls: unknown[] = [];
    const query = {
      getContextUsage: async (options?: unknown) => {
        calls.push(options);
        return { totalTokens: 10, maxTokens: 1_000_000, isAutoCompactEnabled: true };
      },
    };
    await expect(readClaudeContextUsage(query as never)).resolves.toMatchObject({ totalTokens: 10 });
    expect(calls).toEqual([{ detail: "summary" }]);
  });
});
