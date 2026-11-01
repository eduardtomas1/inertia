import { afterEach, describe, expect, it, vi } from "vitest";

import { FULL_HARNESS_CAPABILITY_OFFER } from "../../src/server/runtime/harness-capabilities";
import {
  continuationIdentityForSelection,
  modelSelectionSchema,
  providerNativeBackendProfile,
  providerNativeModelSelection,
  resolveHarnessBackendCompatibility,
} from "../../src/shared/model-routing";
import type { ProviderHostToolBridge } from "../../src/server/provider/contracts";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime as testRuntime,
  flushTurnControllerTestPromises as flushPromises,
  turnControllerTestProviderInfo as providerInfo,
} from "../support/turn-controller-runtime";

afterEach(cleanupTurnControllerTestDirectories);
describe("TurnController host tool authority", () => {
  it("does not advertise or grant host tools before exact capability verification", async () => {
    const hostTools: ProviderHostToolBridge = {
      definitions: [],
      invoke: vi.fn(async () => ({ success: true, text: "unused" })),
    };
    const hostToolsForTurn = vi.fn(() => hostTools);
    const runtime = await testRuntime({
      providerInfo: () => [{
        ...providerInfo(),
        capabilityContract: {
          schemaVersion: 1,
          harnessId: "codex-app-server",
          manifestDigest: "a".repeat(64),
          installationVerified: false,
          installedVersion: null,
          currentlyAvailableCount: 0,
          declaredCapabilityCount: 28,
          hostToolBridgeAvailable: false,
        },
      }],
      capabilityOfferForTurn: () => ({ instructions: [{
        label: "unverified-host-tools",
        text: "UNVERIFIED_HOST_TOOLS_MUST_NOT_BE_ADVERTISED",
      }], offer: FULL_HARNESS_CAPABILITY_OFFER }),
      hostToolsForTurn,
    });
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Inspect safely.",
    });

    expect(runtime.store.turnExecutionManifest(queued.turn.id))
      .toMatchObject({ internalInstructionCount: 1 });
    expect(runtime.controller.start(queued.turn.id)).toBe(true);
    expect(runtime.provider.input?.prompt)
      .not.toContain("UNVERIFIED_HOST_TOOLS_MUST_NOT_BE_ADVERTISED");
    expect(hostToolsForTurn).not.toHaveBeenCalled();
    expect(runtime.provider.callbacks?.hostTools).toBeUndefined();

    runtime.provider.resolve();
    await flushPromises();
    runtime.store.close();
  });

  it("does not lend a verified native host bridge to a custom backend route", async () => {
    const hostTools: ProviderHostToolBridge = {
      definitions: [],
      invoke: vi.fn(async () => ({ success: true, text: "unused" })),
    };
    const hostToolsForTurn = vi.fn(() => hostTools);
    const capabilityOfferForTurn = vi.fn(() => ({ instructions: [{
      label: "native-host-tools",
      text: "NATIVE_HOST_TOOLS_MUST_NOT_CROSS_CUSTOM_ROUTE",
    }], offer: FULL_HARNESS_CAPABILITY_OFFER }));
    const customProfile = {
      ...providerNativeBackendProfile("codex"),
      id: "custom:no-native-host-bridge",
      displayName: "Custom Responses",
      source: "custom" as const,
      authenticationMode: "api-key" as const,
      configurationRevision: 12,
      endpointIdentity: "endpoint:no-native-host-bridge:12",
    };
    const customSelection = modelSelectionSchema.parse({
      ...providerNativeModelSelection({
        providerId: "codex",
        modelId: "custom-model",
      }),
      backendProfileId: customProfile.id,
      backendProfileDisplayName: customProfile.displayName,
      backendConfigurationRevision: customProfile.configurationRevision,
    });
    const customCompatibility = resolveHarnessBackendCompatibility(
      "codex-app-server",
      customProfile,
    );
    const runtime = await testRuntime({
      // The default provider view deliberately claims a fully verified native
      // host bridge. Route identity, not that provider-wide summary, decides.
      capabilityOfferForTurn,
      hostToolsForTurn,
    }, {
      modelSelection: customSelection,
      resolveModelRoute: () => ({
        providerId: "codex",
        harnessId: "codex-app-server",
        backendProfile: customProfile,
        compatibility: customCompatibility,
        continuationIdentity: continuationIdentityForSelection(
          customSelection,
          customProfile.endpointIdentity,
          !customCompatibility.allowsModelSwitchWithinSession,
        ),
      }),
    });
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Use only the custom backend's verified surface.",
    });

    expect(runtime.controller.start(queued.turn.id)).toBe(true);
    expect(runtime.provider.input?.prompt)
      .not.toContain("NATIVE_HOST_TOOLS_MUST_NOT_CROSS_CUSTOM_ROUTE");
    expect(capabilityOfferForTurn).not.toHaveBeenCalled();
    expect(hostToolsForTurn).not.toHaveBeenCalled();
    expect(runtime.provider.callbacks?.hostTools).toBeUndefined();

    runtime.provider.resolve();
    await flushPromises();
    runtime.store.close();
  });

  it("does not advertise or grant host tools when capability attestation is absent", async () => {
    const hostTools: ProviderHostToolBridge = {
      definitions: [],
      invoke: vi.fn(async () => ({ success: true, text: "unused" })),
    };
    const hostToolsForTurn = vi.fn(() => hostTools);
    const providerWithoutAttestation = providerInfo();
    delete providerWithoutAttestation.capabilityContract;
    const runtime = await testRuntime({
      providerInfo: () => [providerWithoutAttestation],
      capabilityOfferForTurn: () => ({ instructions: [{
        label: "missing-host-tools",
        text: "MISSING_HOST_TOOLS_MUST_NOT_BE_ADVERTISED",
      }], offer: FULL_HARNESS_CAPABILITY_OFFER }),
      hostToolsForTurn,
    });
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Inspect safely.",
    });

    expect(runtime.store.turnExecutionManifest(queued.turn.id))
      .toMatchObject({ internalInstructionCount: 1 });
    expect(runtime.controller.start(queued.turn.id)).toBe(true);
    expect(runtime.provider.input?.prompt)
      .not.toContain("MISSING_HOST_TOOLS_MUST_NOT_BE_ADVERTISED");
    expect(hostToolsForTurn).not.toHaveBeenCalled();
    expect(runtime.provider.callbacks?.hostTools).toBeUndefined();

    runtime.provider.resolve();
    await flushPromises();
    runtime.store.close();
  });
});
