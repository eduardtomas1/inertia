import { afterEach, describe, expect, it, vi } from "vitest";

import {
  KIMI_CLAUDE_BUILTIN_PROFILE_ID,
  builtInKimiClaudeBackendProfile,
  claudeHarnessBackendCompatibility,
  createKimiClaudeModelSelection,
} from "../../src/shared/claude-backend-profiles";
import {
  continuationIdentityForSelection,
  providerNativeModelSelection,
} from "../../src/shared/model-routing";
import { defaultProjectPreferences } from "../../src/shared/project-preferences";
import type { RuntimeStore } from "../../src/server/database";
import { AgentThreadManager } from "../../src/server/runtime/agent-thread-manager";
import { WORKSPACE_TOOL_DEFINITIONS } from "../../src/server/runtime/workspace-host-tools";
import type { ProviderHostToolBridge } from "../../src/server/provider/contracts";
import { FULL_HARNESS_CAPABILITY_OFFER } from "../../src/server/runtime/harness-capabilities";
import { routeUsesTrustedHostBridge } from "../../src/server/runtime/turns/turn-provider-host-tools";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestProviderInfo,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

/**
 * A turn controller wired to a real AgentThreadManager exactly as the runtime
 * wires it: the offer is snapshotted at prompt assembly and handed back at
 * provider start.
 */
async function offerRuntime(providerId: "codex" | "claude" = "codex") {
  let store: RuntimeStore | undefined;
  let manager: AgentThreadManager | undefined;
  const baseProvider = turnControllerTestProviderInfo();
  const runtime = await createTurnControllerTestRuntime({
    capabilityOfferForTurn: ({ conversation }) => manager!.capabilityOfferForTurn(conversation),
    hostToolsForTurn: ({ conversation, turn, offer }) =>
      manager!.bridgeFor({ conversation, turn }, offer),
    ...(providerId === "claude"
      ? {
          providerInfo: () => [{
            ...baseProvider,
            id: "claude" as const,
            label: "Claude",
            command: "fake-claude",
            capabilityContract: {
              ...baseProvider.capabilityContract!,
              harnessId: "claude-agent-sdk",
            },
          }],
        }
      : {}),
  }, providerId === "claude"
    ? { modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "gpt-test" }) }
    : {});
  store = runtime.store;
  manager = new AgentThreadManager({
    store,
    agentBrowser: { perform: vi.fn() },
    providerInfo: () => [],
    broadcastSnapshot: vi.fn(),
    broadcastConversationShell: vi.fn(),
    broadcast: vi.fn(),
  } as never);
  return { runtime, manager };
}

function setBrowserAccess(store: RuntimeStore, conversationId: string, browserAccess: boolean | null): void {
  const { projectId } = store.conversation(conversationId);
  store.updateProject(projectId, {
    preferences: { ...defaultProjectPreferences(), browserAccess },
  });
}

function offeredFrontend(runtime: Awaited<ReturnType<typeof offerRuntime>>["runtime"]) {
  const prompt = runtime.provider.input?.prompt ?? "";
  expect(prompt).toContain("[inertia-orchestration]");
  // Browser access never withholds the read-only workspace pack.
  expect(prompt).toContain("[inertia-workspace]");
  const tools = runtime.provider.callbacks?.hostTools?.definitions.map(({ name }) => name) ?? [];
  expect(tools).toContain("inertia_render_html");
  expect(tools).toEqual(expect.arrayContaining(WORKSPACE_TOOL_DEFINITIONS.map(({ name }) => name)));
  return {
    prompt: prompt.includes("[inertia-frontend-workbench]"),
    tools: tools.some((name) => name.startsWith("inertia_browser_")),
  };
}

describe("turn provider host-tool route authority", () => {
  it("preserves host tools and instructions for built-in Kimi through Claude", async () => {
    const hostTools: ProviderHostToolBridge = {
      definitions: [],
      invoke: vi.fn(async () => ({ success: true, text: "unused" })),
    };
    const hostToolsForTurn = vi.fn(() => hostTools);
    const capabilityOfferForTurn = vi.fn(() => ({
      instructions: [{
        label: "kimi-host-tools",
        text: "TRUSTED_KIMI_HOST_TOOLS_ARE_AVAILABLE",
      }],
      offer: FULL_HARNESS_CAPABILITY_OFFER,
    }));
    const kimiProfile = builtInKimiClaudeBackendProfile(
      "secret:kimi-host-bridge-test",
    );
    const kimiSelection = createKimiClaudeModelSelection({
      profile: kimiProfile,
      modelId: "k3",
    });
    const compatibility = claudeHarnessBackendCompatibility(
      kimiProfile,
      "claude-agent-sdk",
      { modelId: kimiSelection.modelId },
    );
    const baseProvider = turnControllerTestProviderInfo();
    const runtime = await createTurnControllerTestRuntime({
      providerInfo: () => [{
        ...baseProvider,
        id: "claude",
        label: "Claude",
        command: "fake-claude",
        models: [{
          ...baseProvider.models[0]!,
          id: "k3",
          label: "K3",
          isDefault: true,
        }],
        capabilityContract: {
          ...baseProvider.capabilityContract!,
          harnessId: "claude-agent-sdk",
        },
      }],
      capabilityOfferForTurn,
      hostToolsForTurn,
    }, {
      modelSelection: kimiSelection,
      resolveModelRoute: () => ({
        providerId: "claude",
        harnessId: "claude-agent-sdk",
        backendProfile: kimiProfile,
        compatibility,
        continuationIdentity: continuationIdentityForSelection(
          kimiSelection,
          kimiProfile.endpointIdentity,
          !compatibility.allowsModelSwitchWithinSession,
        ),
      }),
    });
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Use the trusted built-in route.",
    });

    expect(runtime.store.turnExecutionManifest(queued.turn.id))
      .toMatchObject({ internalInstructionCount: 2 });
    expect(runtime.controller.start(queued.turn.id)).toBe(true);
    expect(runtime.provider.input?.prompt)
      .toContain("TRUSTED_KIMI_HOST_TOOLS_ARE_AVAILABLE");
    expect(capabilityOfferForTurn).toHaveBeenCalledTimes(1);
    expect(hostToolsForTurn).toHaveBeenCalledTimes(1);
    expect(runtime.provider.callbacks?.hostTools).toBe(hostTools);

    runtime.provider.resolve();
    await flushTurnControllerTestPromises();
    runtime.store.close();
  });

  it.each([
    { browserAccess: false, frontend: false },
    { browserAccess: null, frontend: true },
  ])("offers the frontend pack's instructions and tools per project (browserAccess=$browserAccess)", async ({
    browserAccess,
    frontend,
  }) => {
    const { runtime, manager } = await offerRuntime();
    setBrowserAccess(runtime.store, runtime.conversationId, browserAccess);
    const digest = manager.capabilityManifest().definitionDigest;
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Check the page.",
    });

    expect(runtime.controller.start(queued.turn.id)).toBe(true);
    expect(offeredFrontend(runtime)).toEqual({ prompt: frontend, tools: frontend });
    expect(runtime.provider.callbacks?.hostTools?.instructions?.map(({ label }) => label)).toEqual(frontend
      ? ["inertia-frontend-workbench", "inertia-orchestration", "inertia-workspace"]
      : ["inertia-orchestration", "inertia-workspace"]);
    expect(manager.capabilityManifest().definitionDigest).toBe(digest);

    runtime.provider.resolve();
    await flushTurnControllerTestPromises();
    runtime.store.close();
  });

  it.each([
    { providerId: "codex" as const, before: null, after: false },
    { providerId: "codex" as const, before: false, after: true },
    { providerId: "claude" as const, before: null, after: false },
    { providerId: "claude" as const, before: false, after: true },
  ])("keeps $providerId's prompt and tools on the offer snapshotted at assembly when Browser access changes before start ($before -> $after)", async ({
    providerId,
    before,
    after,
  }) => {
    const { runtime } = await offerRuntime(providerId);
    setBrowserAccess(runtime.store, runtime.conversationId, before);
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Check the page.",
    });
    setBrowserAccess(runtime.store, runtime.conversationId, after);

    expect(runtime.controller.start(queued.turn.id)).toBe(true);
    expect(runtime.provider.input?.harnessId).toBe(
      providerId === "codex" ? "codex-app-server" : "claude-agent-sdk",
    );
    const offeredAtAssembly = before !== false;
    expect(offeredFrontend(runtime)).toEqual({
      prompt: offeredAtAssembly,
      tools: offeredAtAssembly,
    });

    runtime.provider.resolve();
    await flushTurnControllerTestPromises();
    runtime.store.close();
  });

  it("denies a custom profile even when it spoofs the built-in Kimi identity", () => {
    const builtIn = builtInKimiClaudeBackendProfile(
      "secret:kimi-host-bridge-test",
    );
    expect(routeUsesTrustedHostBridge({
      providerId: "claude",
      harnessId: "claude-agent-sdk",
      backendProfile: {
        ...builtIn,
        id: KIMI_CLAUDE_BUILTIN_PROFILE_ID,
        source: "custom",
      },
    })).toBe(false);
  });
});
