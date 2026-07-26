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
import { continuationIdentityForSelection } from "../../src/shared/model-routing";
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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })),
  );
});

describe("model backend profile controller", () => {
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

    const renamed = await controller.updateProfile(created.id, {
      displayName: "Renamed team gateway",
    });
    expect(renamed.configurationRevision).toBe(1);
    expect(renamed.enabled).toBe(true);
    expect(runtimeStore.listModelBackendDefaults()).toHaveLength(1);

    const changed = await controller.updateProfile(created.id, {
      models: renamed.models,
    });
    expect(changed.configurationRevision).toBe(2);
    expect(changed.enabled).toBe(false);
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
