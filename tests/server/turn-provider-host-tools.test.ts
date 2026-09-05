import { afterEach, describe, expect, it, vi } from "vitest";

import {
  KIMI_CLAUDE_BUILTIN_PROFILE_ID,
  builtInKimiClaudeBackendProfile,
  claudeHarnessBackendCompatibility,
  createKimiClaudeModelSelection,
} from "../../src/shared/claude-backend-profiles";
import { continuationIdentityForSelection } from "../../src/shared/model-routing";
import type { ProviderHostToolBridge } from "../../src/server/provider/contracts";
import { routeUsesTrustedHostBridge } from "../../src/server/runtime/turns/turn-provider-host-tools";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestProviderInfo,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);

describe("turn provider host-tool route authority", () => {
  it("preserves host tools and instructions for built-in Kimi through Claude", async () => {
    const hostTools: ProviderHostToolBridge = {
      definitions: [],
      invoke: vi.fn(async () => ({ success: true, text: "unused" })),
    };
    const hostToolsForTurn = vi.fn(() => hostTools);
    const harnessInstructionsForTurn = vi.fn(() => [{
      label: "kimi-host-tools",
      text: "TRUSTED_KIMI_HOST_TOOLS_ARE_AVAILABLE",
    }]);
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
      harnessInstructionsForTurn,
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
    expect(harnessInstructionsForTurn).toHaveBeenCalledTimes(1);
    expect(hostToolsForTurn).toHaveBeenCalledTimes(1);
    expect(runtime.provider.callbacks?.hostTools).toBe(hostTools);

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
