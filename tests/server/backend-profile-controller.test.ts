import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  modelSelectionForBackendProfile,
  persistedModelBackendProfileSchema,
  type ModelBackendProfileDraft,
  type PersistedModelBackendProfile,
} from "../../src/shared/backend-profile-settings";
import {
  continuationIdentityForSelection,
  MODEL_CAPABILITY_IDS,
  nativeModelSelection,
} from "../../src/shared/model-routing";
import type { ProviderInfo } from "../../src/shared/contracts";
import { RuntimeStore } from "../../src/server/database";
import {
  BackendProfileController,
  type BackendCredentialBroker,
} from "../../src/server/runtime/backends/backend-profile-controller";

const temporaryDirectories: string[] = [];

async function store(): Promise<RuntimeStore> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-backend-profile-"));
  temporaryDirectories.push(directory);
  return new RuntimeStore(join(directory, "runtime.sqlite"), directory);
}

function draft(overrides: Partial<ModelBackendProfileDraft> = {}): ModelBackendProfileDraft {
  return {
    displayName: "Team gateway",
    harnessId: "claude-agent-sdk",
    protocol: "anthropic-messages",
    authenticationMode: "none",
    preset: "custom",
    baseUrl: "https://gateway.example.test/v1",
    allowInsecureLocalhost: false,
    models: [
      {
        id: "primary-model",
        displayName: "Primary model with a deliberately long readable label",
        contextWindowTokens: 200_000,
        reasoningOptions: [],
        capabilities: [],
      },
      {
        id: "secondary-model-with-a-deliberately-long-identifier",
        displayName: "Secondary model",
        contextWindowTokens: null,
        reasoningOptions: [],
        capabilities: [],
      },
    ],
    routing: {
      mode: "advanced",
      primaryModelId: "primary-model",
      tierModels: {
        fable: "secondary-model-with-a-deliberately-long-identifier",
        opus: "primary-model",
        sonnet: "primary-model",
        haiku: "secondary-model-with-a-deliberately-long-identifier",
      },
      subagentModelId: "secondary-model-with-a-deliberately-long-identifier",
    },
    capabilityHints: [],
    ...overrides,
  };
}

function persistedCredentialProfile(): PersistedModelBackendProfile {
  const timestamp = "2026-07-25T08:00:00.000Z";
  return persistedModelBackendProfileSchema.parse({
    id: "custom:generation-test",
    displayName: "Credential gateway",
    harnessId: "claude-agent-sdk",
    protocol: "anthropic-messages",
    authenticationMode: "api-key",
    source: "custom",
    enabled: true,
    configurationRevision: 7,
    endpointIdentity: "endpoint:credential-test",
    preset: "custom",
    baseUrl: "https://credential.example.test/v1",
    allowInsecureLocalhost: false,
    credentialGeneration: "generation:old",
    models: [{
      id: "credential-model",
      displayName: "Credential model",
      contextWindowTokens: null,
      reasoningOptions: [],
      capabilities: [],
    }],
    routing: { mode: "simple", primaryModelId: "credential-model" },
    capabilityHints: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function nativeProvider(): ProviderInfo {
  return {
    id: "codex",
    label: "Codex",
    command: "codex",
    available: true,
    version: "1.0.0",
    executable: "/opt/bin/codex",
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    statusMessage: "Connected",
    models: [{
      id: "gpt-authoritative",
      label: "GPT Authoritative",
      description: "Authoritative native catalog model",
      isDefault: true,
      inputModalities: ["text"],
      reasoningOptions: [{
        value: "high",
        label: "High",
        description: "Deep reasoning",
      }],
      defaultReasoningEffort: "high",
      fastMode: {
        providerValue: "priority",
        label: "Fast",
        description: "Faster responses with increased usage.",
        isDefault: false,
      },
    }],
    rateLimits: [],
    metadataState: {
      models: {
        freshness: "fresh",
        provenance: "provider",
        updatedAt: "2026-08-01T08:00:00.000Z",
        lastAttemptedAt: "2026-08-01T08:00:00.000Z",
        refreshing: false,
      },
      rateLimits: {
        freshness: "unavailable",
        provenance: null,
        updatedAt: null,
        lastAttemptedAt: null,
        refreshing: false,
      },
    },
  };
}

function compatibleProbe(
  profile: PersistedModelBackendProfile,
) {
  const checkedAt = "2026-08-01T09:00:00.000Z";
  return {
    profileId: profile.id,
    backendConfigurationRevision: profile.configurationRevision,
    endpointIdentity: profile.endpointIdentity,
    protocol: profile.protocol,
    modelId: profile.models[0]!.id,
    compatibility: "protocol-compatible" as const,
    protocolVerified: true,
    modelVerified: true,
    capabilities: MODEL_CAPABILITY_IDS.map((id) => ({
      id,
      state: "verified" as const,
      provenance: "probe" as const,
      detail: null,
      checkedAt,
    })),
    contextWindow: {
      tokens: 200_000,
      state: "verified" as const,
      provenance: "probe" as const,
      detail: null,
      checkedAt,
    },
    failure: null,
    checkedAt,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })),
  );
});

describe("model backend profile controller", () => {
  it("canonicalizes native model metadata and rejects unsupported reasoning", async () => {
    const runtimeStore = await store();
    const controller = await BackendProfileController.create({ store: runtimeStore });
    controller.profiles([nativeProvider()]);
    const submitted = {
      ...nativeModelSelection({
        providerId: "codex",
        modelId: "gpt-authoritative",
        reasoningEffort: "high",
      }),
      alias: "Forged alias",
      contextWindowOverride: 99_000_000,
      capabilities: [{
        id: "images" as const,
        state: "verified" as const,
        provenance: "user" as const,
        detail: "Forged renderer capability",
      }],
    };

    expect(controller.validateSelection(submitted)).toEqual({
      ...nativeModelSelection({
        providerId: "codex",
        modelId: "gpt-authoritative",
        alias: "GPT Authoritative",
        reasoningEffort: "high",
      }),
      alias: "GPT Authoritative",
    });
    expect(() => controller.validateSelection({
      ...submitted,
      reasoningEffort: "unsupported",
    })).toThrow("not supported");
    runtimeStore.close();
  });

  it("uses a known stale native route but requires refresh before trusting an unknown one", async () => {
    const runtimeStore = await store();
    const controller = await BackendProfileController.create({ store: runtimeStore });
    const concrete = nativeModelSelection({
      providerId: "codex",
      modelId: "gpt-authoritative",
      reasoningEffort: "high",
    });
    const stale = nativeProvider();
    stale.metadataState.models.freshness = "stale";
    controller.profiles([stale]);

    expect(controller.validateSelection(concrete)).toMatchObject({
      modelId: "gpt-authoritative",
      alias: "GPT Authoritative",
      reasoningEffort: "high",
    });
    expect(controller.validateSelection(concrete, {
      allowUnavailableNativeCatalog: true,
    })).toMatchObject({
      modelId: "gpt-authoritative",
      alias: "GPT Authoritative",
      reasoningEffort: "high",
    });
    expect(controller.validateSelection(nativeModelSelection({
      providerId: "codex",
      modelId: "provider-default",
    })).modelId).toBe("provider-default");

    const staleWithoutModel = nativeProvider();
    staleWithoutModel.models = [];
    staleWithoutModel.metadataState.models.freshness = "stale";
    controller.profiles([staleWithoutModel]);
    expect(() => controller.validateSelection(concrete))
      .toThrow("Refresh provider models");

    const freshWithoutModel = nativeProvider();
    freshWithoutModel.models = [];
    controller.profiles([freshWithoutModel]);
    expect(() => controller.validateSelection(concrete))
      .toThrow("no longer offered");
    runtimeStore.close();
  });

  it("accepts only the exact Fast mode value advertised by a native model", async () => {
    const runtimeStore = await store();
    const controller = await BackendProfileController.create({ store: runtimeStore });
    controller.profiles([nativeProvider()]);
    const fast = nativeModelSelection({
      providerId: "codex",
      modelId: "gpt-authoritative",
      reasoningEffort: "high",
      providerOptions: { fastMode: "priority" },
    });

    expect(controller.validateSelection(fast).providerOptions).toEqual({
      fastMode: "priority",
    });
    expect(controller.supportsNativeFastModeControl(fast)).toBe(true);
    expect(() => controller.validateSelection({
      ...fast,
      providerOptions: { fastMode: "fast" },
    })).toThrow("does not currently advertise Fast mode");
    expect(() => controller.validateSelection({
      ...fast,
      providerOptions: { fastMode: "priority", temperature: 0 },
    })).toThrow("native provider options are invalid");

    const malformed = nativeProvider();
    malformed.models[0]!.fastMode!.providerValue = "turbo";
    controller.profiles([malformed]);
    expect(() => controller.validateSelection({
      ...fast,
      providerOptions: { fastMode: "turbo" },
    })).toThrow("does not currently advertise Fast mode");

    const defaultFast = nativeProvider();
    defaultFast.models[0]!.fastMode!.isDefault = true;
    controller.profiles([defaultFast]);
    expect(controller.validateSelection(fast).providerOptions).toEqual({
      fastMode: "priority",
    });
    expect(controller.validateSelection({
      ...fast,
      providerOptions: {},
    }).providerOptions).toEqual({});

    const unsupported = nativeProvider();
    unsupported.models[0]!.fastMode = null;
    controller.profiles([unsupported]);
    expect(controller.supportsNativeFastModeControl(fast)).toBe(false);
    expect(() => controller.validateSelection(fast)).toThrow(
      "does not currently advertise Fast mode",
    );
    runtimeStore.close();
  });

  it("keeps historical display labels valid while canonicalizing external metadata", async () => {
    const runtimeStore = await store();
    const controller = await BackendProfileController.create({ store: runtimeStore });
    const created = await controller.createProfile(draft({
      models: [{
        id: "primary-model",
        displayName: "Authoritative model",
        contextWindowTokens: 200_000,
        reasoningOptions: [{
          value: "high",
          label: "High",
          description: "Deep reasoning",
        }],
        capabilities: [{
          id: "reasoning",
          state: "user-declared",
          provenance: "user",
          detail: "Configured by the user",
        }],
      }],
      routing: { mode: "simple", primaryModelId: "primary-model" },
    }));
    const beforeRename = runtimeStore.modelBackendProfile(created.id).profile;
    const historical = modelSelectionForBackendProfile(
      beforeRename,
      "primary-model",
      "high",
    );
    await controller.updateProfile(created.id, {
      displayName: "Renamed team gateway",
    });

    const canonical = controller.validateSelection({
      ...historical,
      alias: "Forged alias",
      contextWindowOverride: 99_000_000,
      capabilities: [{
        id: "images",
        state: "verified",
        provenance: "user",
        detail: "Forged renderer capability",
      }],
    });
    expect(canonical).toMatchObject({
      backendProfileId: created.id,
      backendProfileDisplayName: "Renamed team gateway",
      backendConfigurationRevision: historical.backendConfigurationRevision,
      modelId: "primary-model",
      alias: "Authoritative model",
      reasoningEffort: "high",
      contextWindowOverride: 200_000,
      capabilities: [{
        id: "reasoning",
        state: "user-declared",
        provenance: "user",
        detail: "Configured by the user",
      }],
      providerOptions: {},
    });
    runtimeStore.close();
  });

  it("rejects unsupported external reasoning and provider options", async () => {
    const runtimeStore = await store();
    const controller = await BackendProfileController.create({ store: runtimeStore });
    const created = await controller.createProfile(draft());
    const profile = runtimeStore.modelBackendProfile(created.id).profile;
    const selection = modelSelectionForBackendProfile(
      profile,
      "primary-model",
    );

    expect(() => controller.validateSelection({
      ...selection,
      reasoningEffort: "renderer-invented",
    })).toThrow("does not expose reasoning choices");
    expect(() => controller.validateSelection({
      ...selection,
      providerOptions: { temperature: 2 },
    })).toThrow("does not support provider options");
    runtimeStore.close();
  });

  it("keeps full endpoint URLs in scoped details rather than shell profiles", async () => {
    const runtimeStore = await store();
    const controller = await BackendProfileController.create({ store: runtimeStore });
    const detail = await controller.createProfile(draft());
    const shell = controller.profiles([]).find(({ id }) => id === detail.id);

    expect(detail.baseUrl).toBe("https://gateway.example.test/v1");
    expect(shell?.endpointHost).toBe("gateway.example.test");
    expect(shell).not.toHaveProperty("baseUrl");
    expect(JSON.stringify(shell)).not.toContain("https://gateway.example.test");
    runtimeStore.close();
  });

  it("invalidates execution revisions and defaults but not display-only edits", async () => {
    const runtimeStore = await store();
    const controller = await BackendProfileController.create({ store: runtimeStore });
    const created = await controller.createProfile(draft());
    const enabled = runtimeStore.saveModelBackendProfile({
      ...runtimeStore.modelBackendProfile(created.id).profile,
      enabled: true,
    }).profile;
    runtimeStore.saveModelBackendDefault(
      null,
      modelSelectionForBackendProfile(enabled, "primary-model"),
    );
    runtimeStore.recordModelBackendProbe(
      created.id,
      compatibleProbe(enabled),
    );

    const renamed = await controller.updateProfile(created.id, {
      displayName: "Renamed team gateway",
    });
    expect(renamed.configurationRevision).toBe(1);
    expect(renamed.enabled).toBe(true);
    expect(runtimeStore.modelBackendProfile(created.id).latestProbe)
      .not.toBeNull();
    expect(runtimeStore.listModelBackendDefaults()).toHaveLength(1);

    const unchanged = await controller.updateProfile(created.id, {
      models: renamed.models,
    });
    expect(unchanged.configurationRevision).toBe(1);
    expect(unchanged.enabled).toBe(true);
    expect(runtimeStore.modelBackendProfile(created.id).latestProbe)
      .not.toBeNull();
    expect(runtimeStore.listModelBackendDefaults()).toHaveLength(1);

    const changed = await controller.updateProfile(created.id, {
      baseUrl: "https://replacement.example.test/v1/",
    });
    expect(changed.configurationRevision).toBe(2);
    expect(changed.enabled).toBe(false);
    expect(changed.baseUrl).toBe("https://replacement.example.test/v1");
    expect(runtimeStore.modelBackendProfile(created.id).latestProbe).toBeNull();
    expect(runtimeStore.listModelBackendDefaults()).toEqual([]);
    runtimeStore.close();
  });

  it("reconciles secure-vault generation changes before exposing profiles", async () => {
    const runtimeStore = await store();
    const profile = runtimeStore.saveModelBackendProfile(
      persistedCredentialProfile(),
    ).profile;
    runtimeStore.saveModelBackendDefault(
      null,
      modelSelectionForBackendProfile(profile, "credential-model"),
    );
    const credentials: BackendCredentialBroker = {
      resolve: async () => "credential-value",
      status: async () => ({
        hasSecret: true,
        credentialGeneration: "generation:new",
      }),
      forget: async () => true,
    };

    await BackendProfileController.create({ store: runtimeStore, credentials });
    const reconciled = runtimeStore.modelBackendProfile(profile.id);
    expect(reconciled.profile).toMatchObject({
      enabled: false,
      credentialGeneration: "generation:new",
      configurationRevision: 8,
    });
    expect(reconciled.latestProbe).toBeNull();
    expect(runtimeStore.listModelBackendDefaults()).toEqual([]);
    runtimeStore.close();
  });

  it("allows explicit IPv6 localhost HTTP without widening the exception", async () => {
    const runtimeStore = await store();
    const controller = await BackendProfileController.create({ store: runtimeStore });
    await expect(controller.createProfile(draft({
      baseUrl: "http://[::1]:11434/v1",
      allowInsecureLocalhost: true,
    }))).resolves.toMatchObject({
      baseUrl: "http://[::1]:11434/v1",
    });
    await expect(controller.createProfile(draft({
      baseUrl: "http://10.0.0.8:11434/v1",
      allowInsecureLocalhost: true,
    }))).rejects.toThrow("except explicit localhost HTTP");
    await expect(controller.createProfile(draft({
      baseUrl: "http://localhost.example.test/v1",
      allowInsecureLocalhost: true,
    }))).rejects.toThrow("except explicit localhost HTTP");
    runtimeStore.close();
  });

  it("forgets deleted credentials while preserving safe historical turn identity", async () => {
    const runtimeStore = await store();
    const directory = temporaryDirectories.at(-1)!;
    const profile = runtimeStore.saveModelBackendProfile(
      persistedCredentialProfile(),
    ).profile;
    const selection = modelSelectionForBackendProfile(
      profile,
      "credential-model",
    );
    const project = runtimeStore.createProject("Historical project", directory);
    const conversation = runtimeStore.createConversation(
      project.id,
      "Historical credential-backed turn",
      { modelSelection: selection },
    );
    const queued = runtimeStore.beginAgentTurn({
      id: "turn-deleted-backend",
      conversationId: conversation.id,
      runId: "run-deleted-backend",
      content: "Keep this historical request.",
      providerId: "claude",
      modelSelection: selection,
      continuationIdentity: continuationIdentityForSelection(
        selection,
        profile.endpointIdentity,
        true,
      ),
      reasoningEffort: selection.reasoningEffort ?? "",
      interactionMode: "build",
      accessMode: "supervised",
      providerSessionBefore: null,
      usageAtStart: null,
      configurationRevision: selection.backendConfigurationRevision,
      association: "authoritative",
    });
    const forget = vi.fn(async (_reference: string) => true);
    const credentials: BackendCredentialBroker = {
      resolve: async () => "credential-secret-that-must-not-persist",
      status: async () => ({
        hasSecret: true,
        credentialGeneration: "generation:old",
      }),
      forget,
    };
    const controller = await BackendProfileController.create({
      store: runtimeStore,
      credentials,
    });

    await controller.deleteProfile(profile.id);
    expect(() => runtimeStore.modelBackendProfile(profile.id)).toThrow();
    expect(forget).toHaveBeenCalledTimes(1);
    expect(forget.mock.calls[0]?.[0]).toMatch(/^secret:backend:[a-f0-9]{64}$/u);
    expect(runtimeStore.agentTurn(queued.turn.id).modelSelection).toMatchObject({
      backendProfileId: profile.id,
      backendProfileDisplayName: "Credential gateway",
      modelId: "credential-model",
      backendConfigurationRevision: 7,
    });
    runtimeStore.close();

    const reopened = new RuntimeStore(join(directory, "runtime.sqlite"), directory);
    const historical = reopened.agentTurn(queued.turn.id);
    expect(historical.modelSelection).toMatchObject({
      backendProfileId: profile.id,
      backendProfileDisplayName: "Credential gateway",
      modelId: "credential-model",
    });
    expect(JSON.stringify({
      turn: historical,
      detail: reopened.conversationDetail(conversation.id),
    })).not.toContain("credential-secret-that-must-not-persist");
    reopened.close();
  });
});
