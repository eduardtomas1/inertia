import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  BackendCompatibilityProbeRequest,
  BackendCompatibilityProbeResult,
} from "../../src/shared/backend-probe";
import {
  modelSelectionForBackendProfile,
  type ModelBackendProfileDraft,
  type PersistedModelBackendProfile,
} from "../../src/shared/backend-profile-settings";
import type { ProviderInfo } from "../../src/shared/contracts";
import { createKimiClaudeBackendProfile, KIMI_CODING_MODELS } from "../../src/shared/claude-backend-profiles";
import {
  BACKEND_PROBE_FRESHNESS_MS,
  BACKEND_PROBE_RENEWAL_MS,
  MODEL_CAPABILITY_IDS,
  continuationIdentityForSelection,
} from "../../src/shared/model-routing";
import { MAX_BACKEND_PROBE_MODELS } from "../../src/shared/backend-profile-settings";
import { BACKEND_PROFILE_PROBE_REQUEST_TIMEOUT_MS } from "../../src/shared/runtime-command-timeouts";
import { RuntimeStore } from "../../src/server/database";
import type { ProviderRunInput } from "../../src/server/provider/contracts";
import { DEFAULT_TIMEOUT_MS } from "../../src/server/runtime/backends/backend-compatibility-probe/core";
import { safeBackendProfile } from "../../src/server/runtime/backends/backend-profile-model";

const probeCompatibility = vi.hoisted(() =>
  vi.fn<(
    request: BackendCompatibilityProbeRequest,
  ) => Promise<BackendCompatibilityProbeResult>>());

vi.mock(
  "../../src/server/runtime/backends/backend-compatibility-probe",
  () => ({ probeBackendCompatibility: probeCompatibility }),
);

import {
  BackendProfileController,
  type BackendCredentialBroker,
} from "../../src/server/runtime/backends/backend-profile-controller";

const START = new Date("2030-03-01T12:00:00.000Z");
const directories: string[] = [];
const stores = new Set<RuntimeStore>();

afterEach(async () => {
  probeCompatibility.mockReset();
  for (const store of stores) store.close();
  stores.clear();
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function runtimeStore(): Promise<RuntimeStore> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-api-key-routes-"));
  directories.push(directory);
  const store = new RuntimeStore(join(directory, "runtime.sqlite"), directory);
  stores.add(store);
  return store;
}

function credentialBroker(initialGeneration = "generation:one"): BackendCredentialBroker & {
  generation: string;
  hasSecret: boolean;
} {
  const broker = {
    generation: initialGeneration,
    hasSecret: true,
    resolve: async () => "test-credential-value",
    status: async () => ({
      hasSecret: broker.hasSecret,
      credentialGeneration: broker.generation,
    }),
    forget: async () => true,
  };
  return broker;
}

function clock(start = START): { now: () => Date; advance(ms: number): void } {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
  };
}

function successfulProbe(
  request: BackendCompatibilityProbeRequest,
  checkedAt: Date,
): BackendCompatibilityProbeResult {
  const at = checkedAt.toISOString();
  return {
    profileId: request.profile.id,
    backendConfigurationRevision: request.profile.configurationRevision,
    endpointIdentity: request.profile.endpointIdentity,
    protocol: request.profile.protocol,
    modelId: request.modelId,
    compatibility: "protocol-compatible",
    protocolVerified: true,
    modelVerified: true,
    capabilities: MODEL_CAPABILITY_IDS.map((id) => ({
      id,
      state: "verified",
      provenance: "probe",
      detail: null,
      checkedAt: at,
    })),
    contextWindow: {
      tokens: 200_000,
      state: "verified",
      provenance: "probe",
      detail: null,
      checkedAt: at,
    },
    failure: null,
    checkedAt: at,
  };
}

function failedProbe(
  request: BackendCompatibilityProbeRequest,
  checkedAt: Date,
): BackendCompatibilityProbeResult {
  return {
    ...successfulProbe(request, checkedAt),
    compatibility: "unavailable",
    protocolVerified: false,
    modelVerified: false,
    failure: {
      code: "invalid-credentials",
      message: "The backend rejected the configured credential.",
      retryAfterSeconds: null,
    },
  };
}

function anthropicDraft(overrides: Partial<ModelBackendProfileDraft> = {}): ModelBackendProfileDraft {
  return {
    displayName: "Team gateway",
    harnessId: "claude-agent-sdk",
    protocol: "anthropic-messages",
    authenticationMode: "api-key",
    preset: "custom",
    baseUrl: "https://gateway.example.test/v1/",
    allowInsecureLocalhost: false,
    models: ["alpha", "beta"].map((id) => ({
      id,
      displayName: `Model ${id}`,
      contextWindowTokens: null,
      reasoningOptions: [],
      capabilities: [],
    })),
    routing: { mode: "simple", primaryModelId: "alpha" },
    capabilityHints: [],
    ...overrides,
  };
}

function installedProvider(
  id: ProviderInfo["id"],
  overrides: Partial<ProviderInfo> = {},
): ProviderInfo {
  return {
    id,
    label: id === "claude" ? "Claude" : "Codex",
    command: id,
    available: true,
    version: "1.0.0",
    executable: `/opt/bin/${id}`,
    installState: "installed",
    authState: "unauthenticated",
    canRun: false,
    statusMessage: "Not signed in",
    models: [],
    rateLimits: [],
    metadataState: {
      models: {
        freshness: "unavailable",
        provenance: null,
        updatedAt: null,
        lastAttemptedAt: null,
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
    ...overrides,
  };
}

async function enabledProfile(
  controller: BackendProfileController,
  store: RuntimeStore,
  time: ReturnType<typeof clock>,
  draft: ModelBackendProfileDraft = anthropicDraft(),
): Promise<PersistedModelBackendProfile> {
  const created = await controller.createProfile(draft);
  await controller.reconcileCredentialRevision(created.id, "generation:one");
  probeCompatibility.mockImplementation(async (request) => successfulProbe(request, time.now()));
  await controller.probe(created.id);
  await controller.updateProfile(created.id, { enabled: true });
  probeCompatibility.mockReset();
  return store.modelBackendProfile(created.id).profile;
}

describe("API key presets", () => {
  it("creates the Anthropic preset from the catalogue", async () => {
    const store = await runtimeStore();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker() });

    const created = await controller.createProfile({ preset: "anthropic-api-key" });

    expect(created).toMatchObject({
      source: "custom",
      preset: "anthropic-api-key",
      harnessId: "claude-agent-sdk",
      protocol: "anthropic-messages",
      authenticationMode: "api-key",
      baseUrl: "https://api.anthropic.com",
      displayName: "Anthropic API key",
      enabled: false,
      configurationRevision: 1,
      allowInsecureLocalhost: false,
      allowPrivateNetwork: false,
      routeKind: "api-key",
      providerId: "claude",
      routing: {
        mode: "advanced",
        primaryModelId: "claude-opus-5-5",
        tierModels: {
          fable: "claude-fable-5-1",
          opus: "claude-opus-5-5",
          sonnet: "claude-sonnet-5-5",
          haiku: "claude-haiku-5-5",
        },
        subagentModelId: "claude-sonnet-5-5",
      },
    });
    expect(created.models.map(({ id }) => id)).toEqual([
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
    ]);
    for (const model of created.models) {
      expect(model.reasoningOptions.map(({ value }) => value)).toEqual(["low", "medium", "high"]);
      expect(model.compatibility).toMatchObject({ backendProfileId: created.id, reasonCode: "profile-disabled" });
      expect(model.latestProbe).toBeNull();
    }
  });

  it("creates the OpenAI preset with the native Codex reasoning choices", async () => {
    const store = await runtimeStore();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker() });
    controller.profiles([installedProvider("codex", {
      models: [{
        id: "gpt-6.1-sol",
        label: "GPT-6.1 Sol",
        description: "Native model",
        isDefault: true,
        inputModalities: ["text"],
        reasoningOptions: ["low", "medium", "high", "xhigh"].map((value) => ({
          value,
          label: value,
          description: `${value} reasoning`,
        })),
        defaultReasoningEffort: "medium",
        fastMode: null,
      }],
    })]);

    const created = await controller.createProfile({
      preset: "openai-api-key",
      displayName: "Work OpenAI key",
    });

    expect(created).toMatchObject({
      preset: "openai-api-key",
      harnessId: "codex-app-server",
      protocol: "openai-responses",
      authenticationMode: "bearer-token",
      baseUrl: "https://api.openai.com/v1",
      displayName: "Work OpenAI key",
      providerId: "codex",
      routeKind: "api-key",
      routing: { mode: "simple", primaryModelId: "gpt-6.1-sol" },
    });
    expect(created.models[0]?.reasoningOptions.map(({ value }) => value))
      .toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("offers no OpenAI reasoning levels without native evidence for the model family", async () => {
    const store = await runtimeStore();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker() });

    const created = await controller.createProfile({ preset: "openai-api-key" });

    expect(created.models[0]?.reasoningOptions).toEqual([]);
  });

  it("copies the native Codex default's reasoning only onto models of the same family", async () => {
    const store = await runtimeStore();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker() });
    controller.profiles([installedProvider("codex", {
      models: [{
        id: "gpt-6.1-sol",
        label: "GPT-6.1 Sol",
        description: "Native model",
        isDefault: true,
        inputModalities: ["text"],
        reasoningOptions: ["minimal", "low", "medium", "high"].map((value) => ({
          value,
          label: value,
          description: `${value} reasoning`,
        })),
        defaultReasoningEffort: "medium",
        fastMode: null,
      }],
    })]);

    const created = await controller.createProfile({
      preset: "openai-api-key",
      models: ["gpt-6.1-mini", "o9-mini"].map((id) => ({
        id,
        displayName: id,
        contextWindowTokens: null,
        reasoningOptions: [],
        capabilities: [],
      })),
    });

    expect(created.models.map(({ id, reasoningOptions }) => [id, reasoningOptions.map(({ value }) => value)]))
      .toEqual([
        ["gpt-6.1-mini", ["minimal", "low", "medium", "high"]],
        ["o9-mini", []],
      ]);
  });

  it("offers extra-high and max Claude levels only where the native catalogue supports them", async () => {
    const store = await runtimeStore();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker() });
    controller.profiles([installedProvider("claude", {
      models: [
        {
          id: "opus",
          label: "Opus",
          description: "Native Opus",
          isDefault: true,
          inputModalities: ["text", "image"],
          reasoningOptions: ["low", "medium", "high", "xhigh", "max"].map((value) => ({
            value,
            label: value,
            description: `${value} reasoning effort`,
          })),
          defaultReasoningEffort: "high",
          fastMode: null,
        },
        {
          id: "haiku",
          label: "Haiku",
          description: "Native Haiku",
          isDefault: false,
          inputModalities: ["text", "image"],
          reasoningOptions: ["low", "medium", "high"].map((value) => ({
            value,
            label: value,
            description: `${value} reasoning effort`,
          })),
          defaultReasoningEffort: "high",
          fastMode: null,
        },
      ],
    })]);

    const created = await controller.createProfile({ preset: "anthropic-api-key" });

    expect(Object.fromEntries(created.models.map(({ id, reasoningOptions }) =>
      [id, reasoningOptions.map(({ value }) => value)]))).toEqual({
      "claude-fable-5-1": ["low", "medium", "high"],
      "claude-opus-5-5": ["low", "medium", "high", "xhigh", "max"],
      "claude-sonnet-5-5": ["low", "medium", "high"],
      "claude-haiku-5-5": ["low", "medium", "high"],
    });
  });

  it("keeps preset models chosen by the person", async () => {
    const store = await runtimeStore();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker() });

    const created = await controller.createProfile({
      preset: "anthropic-api-key",
      models: [{
        id: "claude-sonnet-5-5",
        displayName: "Sonnet",
        contextWindowTokens: null,
        reasoningOptions: [],
        capabilities: [],
      }],
    });

    expect(created.models.map(({ id }) => id)).toEqual(["claude-sonnet-5-5"]);
    expect(created.routing).toEqual({ mode: "simple", primaryModelId: "claude-sonnet-5-5" });
    expect(created.models[0]?.reasoningOptions.length).toBeGreaterThan(0);
  });

  it("normalizes custom endpoints for each protocol on save and update", async () => {
    const store = await runtimeStore();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker() });

    const anthropic = await controller.createProfile(anthropicDraft());
    expect(anthropic.baseUrl).toBe("https://gateway.example.test");
    const openai = await controller.createProfile(anthropicDraft({
      harnessId: "codex-app-server",
      protocol: "openai-responses",
      authenticationMode: "bearer-token",
      baseUrl: "https://responses.example.test/",
    }));
    expect(openai.baseUrl).toBe("https://responses.example.test/v1");

    const updated = await controller.updateProfile(anthropic.id, {
      baseUrl: "https://gateway.example.test/v1",
    });
    expect(updated.baseUrl).toBe("https://gateway.example.test");
    expect(updated.configurationRevision).toBe(anthropic.configurationRevision);
  });

  it("answers invalid drafts with the person-facing validation messages", async () => {
    const store = await runtimeStore();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker() });

    await expect(controller.createProfile(anthropicDraft({ authenticationMode: "none" })))
      .rejects.toThrow("Claude-compatible backends need an API key or bearer token.");
    await expect(controller.createProfile({
      preset: "anthropic-api-key",
      baseUrl: "https://elsewhere.example.test",
    })).rejects.toThrow("Anthropic API key always connects to https://api.anthropic.com.");
    await expect(controller.createProfile(anthropicDraft({ displayName: "  " })))
      .rejects.toThrow("Enter a name for this backend.");
    const created = await controller.createProfile(anthropicDraft());
    await expect(controller.updateProfile(created.id, { authenticationMode: "none" }))
      .rejects.toThrow("Claude-compatible backends need an API key or bearer token.");
    await expect(controller.updateProfile(created.id, { models: [] }))
      .rejects.toThrow("Add at least one model.");
  });
});

describe("profile edits and key rotation", () => {
  it("keeps chats, evidence and defaults through name, model and routing edits", async () => {
    const store = await runtimeStore();
    const time = clock();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker(), now: time.now });
    const profile = await enabledProfile(controller, store, time);
    store.saveModelBackendDefault(null, modelSelectionForBackendProfile(profile, "beta"));

    const renamed = await controller.updateProfile(profile.id, {
      displayName: "Renamed gateway",
      models: [...profile.models, {
        id: "gamma",
        displayName: "Model gamma",
        contextWindowTokens: null,
        reasoningOptions: [],
        capabilities: [],
      }],
      routing: { mode: "simple", primaryModelId: "beta" },
    });

    expect(renamed).toMatchObject({
      configurationRevision: profile.configurationRevision,
      enabled: true,
      displayName: "Renamed gateway",
    });
    expect(store.modelBackendProfile(profile.id).probeResults.map(({ modelId }) => modelId).sort())
      .toEqual(["alpha", "beta"]);
    expect(store.listModelBackendDefaults()).toHaveLength(1);
    expect(renamed.models.find(({ id }) => id === "gamma")?.latestProbe).toBeNull();
    expect(controller.validateSelection(modelSelectionForBackendProfile(profile, "alpha")))
      .toMatchObject({ modelId: "alpha", backendProfileDisplayName: "Renamed gateway" });
  });

  it("invalidates only chats and defaults on a removed model", async () => {
    const store = await runtimeStore();
    const time = clock();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker(), now: time.now });
    const profile = await enabledProfile(controller, store, time);
    store.saveModelBackendDefault(null, modelSelectionForBackendProfile(profile, "beta"));

    const updated = await controller.updateProfile(profile.id, {
      models: profile.models.filter(({ id }) => id === "alpha"),
    });

    expect(updated).toMatchObject({ configurationRevision: profile.configurationRevision, enabled: true });
    expect(store.modelBackendProfile(profile.id).probeResults.map(({ modelId }) => modelId)).toEqual(["alpha"]);
    expect(store.modelBackendProfile(profile.id).probeAdmissionHighWater.map(({ modelId }) => modelId))
      .toEqual(["alpha"]);
    expect(store.listModelBackendDefaults()).toEqual([]);
    expect(() => controller.validateSelection(modelSelectionForBackendProfile(profile, "beta")))
      .toThrow("Start a new chat");
    expect(controller.validateSelection(modelSelectionForBackendProfile(profile, "alpha")).modelId)
      .toBe("alpha");
  });

  it("bumps the revision and disables the route only for connection changes", async () => {
    const store = await runtimeStore();
    const time = clock();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker(), now: time.now });
    const profile = await enabledProfile(controller, store, time);

    const privateNetwork = await controller.updateProfile(profile.id, { allowPrivateNetwork: true });
    expect(privateNetwork).toMatchObject({
      configurationRevision: profile.configurationRevision + 1,
      enabled: false,
      allowPrivateNetwork: true,
    });
    expect(store.modelBackendProfile(profile.id).probeResults).toEqual([]);

    const moved = await controller.updateProfile(profile.id, { baseUrl: "https://moved.example.test" });
    expect(moved.configurationRevision).toBe(profile.configurationRevision + 2);
    const sameAddress = await controller.updateProfile(profile.id, { baseUrl: "https://moved.example.test/v1/" });
    expect(sameAddress.configurationRevision).toBe(profile.configurationRevision + 2);
    const bearer = await controller.updateProfile(profile.id, { authenticationMode: "bearer-token" });
    expect(bearer.configurationRevision).toBe(profile.configurationRevision + 3);
  });

  it("refuses to change a backend's preset", async () => {
    const store = await runtimeStore();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker() });
    const preset = await controller.createProfile({ preset: "anthropic-api-key" });
    const custom = await controller.createProfile(anthropicDraft());

    await expect(controller.updateProfile(preset.id, { preset: "custom" }))
      .rejects.toThrow("The backend type cannot be changed. Add a new backend instead.");
    await expect(controller.updateProfile(custom.id, { preset: "anthropic-api-key" }))
      .rejects.toThrow("The backend type cannot be changed. Add a new backend instead.");
    await expect(controller.updateProfile(preset.id, { baseUrl: "https://elsewhere.example.test" }))
      .rejects.toThrow("always connects to https://api.anthropic.com");
    await expect(controller.updateProfile(preset.id, { preset: "anthropic-api-key", displayName: "Work key" }))
      .resolves.toMatchObject({ displayName: "Work key", preset: "anthropic-api-key" });
  });

  it("removes the saved key before a custom backend points somewhere new", async () => {
    const store = await runtimeStore();
    const credentials = credentialBroker();
    const events: string[] = [];
    const forget = vi.fn(async (reference: string) => {
      events.push(`forget:${reference}`);
      credentials.hasSecret = false;
      credentials.generation = "generation:cleared";
      return true;
    });
    credentials.forget = forget;
    const controller = await BackendProfileController.create({ store, credentials });
    const created = await controller.createProfile(anthropicDraft());
    await controller.reconcileCredentialRevision(created.id, "generation:one");

    const renamed = await controller.updateProfileWithOutcome(created.id, { displayName: "Renamed" });
    expect(renamed.credentialCleared).toBe(false);
    expect(forget).not.toHaveBeenCalled();

    const moved = await controller.updateProfileWithOutcome(created.id, { baseUrl: "https://moved.example.test" });
    expect(moved.credentialCleared).toBe(true);
    expect(forget).toHaveBeenCalledTimes(1);
    expect(events[0]).toMatch(/^forget:secret:backend:/u);
    expect(moved.profile).toMatchObject({
      baseUrl: "https://moved.example.test",
      credentialGeneration: null,
      authState: "missing",
    });

    const bearer = await controller.updateProfileWithOutcome(created.id, { authenticationMode: "bearer-token" });
    expect(bearer.credentialCleared).toBe(true);
    const local = await controller.updateProfileWithOutcome(created.id, { allowPrivateNetwork: true });
    expect(local.credentialCleared).toBe(false);
  });

  it("leaves the backend unchanged when the saved key cannot be removed", async () => {
    const store = await runtimeStore();
    const credentials = credentialBroker();
    credentials.forget = async () => {
      throw new Error("vault offline");
    };
    const controller = await BackendProfileController.create({ store, credentials });
    const created = await controller.createProfile(anthropicDraft());

    await expect(controller.updateProfile(created.id, { baseUrl: "https://moved.example.test" }))
      .rejects.toThrow("The saved key could not be removed, so the connection was not changed.");
    expect(store.modelBackendProfile(created.id).profile.baseUrl).toBe("https://gateway.example.test");
  });

  it("keeps the revision, route and evidence when the key is replaced", async () => {
    const store = await runtimeStore();
    const time = clock();
    const credentials = credentialBroker();
    const controller = await BackendProfileController.create({ store, credentials, now: time.now });
    const profile = await enabledProfile(controller, store, time);
    store.saveModelBackendDefault(null, modelSelectionForBackendProfile(profile, "alpha"));
    const evidence = store.modelBackendProfile(profile.id).probeResults;

    credentials.generation = "generation:two";
    const rotated = await controller.reconcileCredentialRevision(profile.id, "generation:two");

    expect(rotated).toMatchObject({
      configurationRevision: profile.configurationRevision,
      enabled: true,
      credentialGeneration: "generation:two",
      authState: "configured",
    });
    expect(store.modelBackendProfile(profile.id).probeResults).toEqual(evidence);
    expect(store.listModelBackendDefaults()).toHaveLength(1);
    expect(store.modelBackendProfile(profile.id).probeRenewalRequestedAt).toBe(time.now().toISOString());

    const renewal = deferredProbe();
    probeCompatibility.mockImplementation(async () => await renewal.promise);
    await expect(controller.readiness(
      modelSelectionForBackendProfile(profile, "alpha"),
      installedProvider("claude"),
    )).resolves.toEqual({ ready: true, message: null });
    expect(probeCompatibility).toHaveBeenCalledTimes(1);
    expect(controller.detail(profile.id)).toMatchObject({ connectionState: "connected", renewing: true });
    time.advance(1_000);
    renewal.resolve(successfulProbe(probeCompatibility.mock.calls[0]![0], time.now()));
    await vi.waitFor(() => {
      expect(store.modelBackendProfile(profile.id).probeResults
        .find(({ modelId }) => modelId === "alpha")?.checkedAt).toBe(time.now().toISOString());
    });
    await vi.waitFor(() => expect(controller.detail(profile.id).connectionState).toBe("connected"));
  });

  it("reconciles a key changed outside the app at send time without refusing", async () => {
    const store = await runtimeStore();
    const time = clock();
    const credentials = credentialBroker();
    const controller = await BackendProfileController.create({ store, credentials, now: time.now });
    const profile = await enabledProfile(controller, store, time);
    credentials.generation = "generation:external";
    probeCompatibility.mockImplementation(async (request) => successfulProbe(request, time.now()));

    await expect(controller.readiness(
      modelSelectionForBackendProfile(profile, "alpha"),
      installedProvider("claude"),
    )).resolves.toEqual({ ready: true, message: null });
    expect(store.modelBackendProfile(profile.id).profile).toMatchObject({
      credentialGeneration: "generation:external",
      configurationRevision: profile.configurationRevision,
      enabled: true,
    });

    credentials.hasSecret = false;
    await expect(controller.readiness(
      modelSelectionForBackendProfile(profile, "alpha"),
      installedProvider("claude"),
    )).resolves.toMatchObject({ ready: false, message: expect.stringContaining("credential") });
  });
});

function deferredProbe(): {
  promise: Promise<BackendCompatibilityProbeResult>;
  resolve(value: BackendCompatibilityProbeResult): void;
} {
  let resolve!: (value: BackendCompatibilityProbeResult) => void;
  const promise = new Promise<BackendCompatibilityProbeResult>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("probing every model", () => {
  it("probes every configured model in order and exposes evidence per model", async () => {
    const store = await runtimeStore();
    const time = clock();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker(), now: time.now });
    const created = await controller.createProfile(anthropicDraft());
    await controller.reconcileCredentialRevision(created.id, "generation:one");
    probeCompatibility.mockImplementation(async (request) => request.modelId === "beta"
      ? failedProbe(request, time.now())
      : successfulProbe(request, time.now()));

    const probed = await controller.probe(created.id);

    expect(probeCompatibility.mock.calls.map(([request]) => request.modelId)).toEqual(["alpha", "beta"]);
    expect(probed.models.map(({ id, latestProbe }) => [id, latestProbe?.failure?.code ?? null]))
      .toEqual([["alpha", null], ["beta", "invalid-credentials"]]);
    expect(probed.models[0]?.latestProbe?.authority?.expiresAt)
      .toBe(new Date(time.now().getTime() + BACKEND_PROBE_FRESHNESS_MS).toISOString());
    expect(probed.latestProbe?.modelId).toBe("alpha");
  });

  it("probes only the requested models", async () => {
    const store = await runtimeStore();
    const time = clock();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker(), now: time.now });
    const created = await controller.createProfile(anthropicDraft());
    await controller.reconcileCredentialRevision(created.id, "generation:one");
    probeCompatibility.mockImplementation(async (request) => successfulProbe(request, time.now()));

    await controller.probe(created.id, ["beta"]);

    expect(probeCompatibility.mock.calls.map(([request]) => request.modelId)).toEqual(["beta"]);
    await expect(controller.probe(created.id, ["missing"]))
      .rejects.toThrow("not configured on this backend");
  });

  it("bounds an all-model probe to sixteen models starting with the primary", async () => {
    const store = await runtimeStore();
    const time = clock();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker(), now: time.now });
    const modelIds = Array.from({ length: 20 }, (_, index) => `model-${String(index).padStart(2, "0")}`);
    const created = await controller.createProfile(anthropicDraft({
      models: modelIds.map((id) => ({
        id,
        displayName: id,
        contextWindowTokens: null,
        reasoningOptions: [],
        capabilities: [],
      })),
      routing: { mode: "simple", primaryModelId: "model-18" },
    }));
    await controller.reconcileCredentialRevision(created.id, "generation:one");
    probeCompatibility.mockImplementation(async (request) => successfulProbe(request, time.now()));

    await controller.probe(created.id);

    const probed = probeCompatibility.mock.calls.map(([request]) => request.modelId);
    expect(probed).toHaveLength(16);
    expect(probed[0]).toBe("model-18");
    expect(new Set(probed).size).toBe(16);
  });

  it("stops starting models before an all-model probe could outlast the request deadline", async () => {
    const store = await runtimeStore();
    const time = clock();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker(), now: time.now });
    const modelIds = Array.from({ length: MAX_BACKEND_PROBE_MODELS }, (_, index) => `slow-${index}`);
    const created = await controller.createProfile(anthropicDraft({
      models: modelIds.map((id) => ({
        id,
        displayName: id,
        contextWindowTokens: null,
        reasoningOptions: [],
        capabilities: [],
      })),
      routing: { mode: "simple", primaryModelId: modelIds[0]! },
    }));
    await controller.reconcileCredentialRevision(created.id, "generation:one");
    const started = time.now().getTime();
    probeCompatibility.mockImplementation(async (request) => {
      time.advance(DEFAULT_TIMEOUT_MS);
      return failedProbe(request, time.now());
    });

    const { profile: probed, skippedModelIds } = await controller.probeWithOutcome(created.id);

    const elapsed = time.now().getTime() - started;
    const probedIds = probeCompatibility.mock.calls.map(([request]) => request.modelId);
    expect(probedIds.length).toBeGreaterThan(0);
    expect(probedIds.length).toBeLessThan(MAX_BACKEND_PROBE_MODELS);
    expect(elapsed).toBeLessThan(BACKEND_PROFILE_PROBE_REQUEST_TIMEOUT_MS);
    expect(skippedModelIds).toEqual(modelIds.filter((id) => !probedIds.includes(id)));
    expect(probed.models.filter(({ latestProbe }) => latestProbe === null).map(({ id }) => id))
      .toEqual(skippedModelIds);

    probeCompatibility.mockClear();
    let remaining = skippedModelIds;
    for (let request = 0; remaining.length > 0 && request < MAX_BACKEND_PROBE_MODELS; request += 1) {
      remaining = (await controller.probeWithOutcome(created.id, remaining)).skippedModelIds;
    }
    expect(remaining).toEqual([]);
    expect(probeCompatibility.mock.calls.map(([request]) => request.modelId)).toEqual(skippedModelIds);
  });

  it("reports verified compatibility only for the official preset endpoints", async () => {
    const store = await runtimeStore();
    const time = clock();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker(), now: time.now });
    probeCompatibility.mockImplementation(async (request) => successfulProbe(request, time.now()));
    const official = await controller.createProfile({ preset: "openai-api-key" });
    await controller.reconcileCredentialRevision(official.id, "generation:one");
    const gateway = await controller.createProfile(anthropicDraft({
      harnessId: "codex-app-server",
      protocol: "openai-responses",
      authenticationMode: "bearer-token",
      baseUrl: "https://gateway.example.test/v1",
    }));
    await controller.reconcileCredentialRevision(gateway.id, "generation:one");

    await controller.probe(official.id);
    await controller.probe(gateway.id, ["alpha"]);
    await controller.updateProfile(official.id, { enabled: true });
    await controller.updateProfile(gateway.id, { enabled: true });

    expect(controller.detail(official.id).models[0]?.compatibility).toMatchObject({
      state: "verified",
      provenance: "probe",
      reasonCode: "responses-probe-verified",
    });
    expect(controller.detail(gateway.id).models[0]?.compatibility).toMatchObject({
      state: "partially-compatible",
      provenance: "probe",
    });
  });

  it("passes the private network switch to the probe", async () => {
    const store = await runtimeStore();
    const time = clock();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker(), now: time.now });
    const created = await controller.createProfile(anthropicDraft({ allowPrivateNetwork: true }));
    await controller.reconcileCredentialRevision(created.id, "generation:one");
    probeCompatibility.mockImplementation(async (request) => successfulProbe(request, time.now()));

    await controller.probe(created.id, ["alpha"]);

    expect(probeCompatibility.mock.calls[0]?.[0]).toMatchObject({
      allowPrivateNetwork: true,
      allowInsecureLocalhost: false,
    });
  });
});

describe("automatic renewal at send time", () => {
  it("renews ageing evidence in the background and proceeds", async () => {
    const store = await runtimeStore();
    const time = clock();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker(), now: time.now });
    const profile = await enabledProfile(controller, store, time);
    time.advance(BACKEND_PROBE_RENEWAL_MS + 1_000);
    const renewal = deferredProbe();
    probeCompatibility.mockImplementation(async () => await renewal.promise);
    const changes = vi.fn();
    controller.attachChangeListener(changes);

    const selection = modelSelectionForBackendProfile(profile, "beta");
    await expect(controller.readiness(selection, installedProvider("claude")))
      .resolves.toEqual({ ready: true, message: null });
    await expect(controller.readiness(selection, installedProvider("claude")))
      .resolves.toEqual({ ready: true, message: null });
    expect(probeCompatibility).toHaveBeenCalledTimes(1);
    expect(probeCompatibility.mock.calls[0]?.[0].modelId).toBe("beta");
    expect(controller.detail(profile.id)).toMatchObject({ connectionState: "connected", renewing: true });
    expect(controller.profiles([]).find(({ id }) => id === profile.id)?.renewing).toBe(true);
    expect(changes).toHaveBeenCalled();

    renewal.resolve(successfulProbe(probeCompatibility.mock.calls[0]![0], time.now()));
    await vi.waitFor(() => {
      expect(store.modelBackendProfile(profile.id).probeResults
        .find(({ modelId }) => modelId === "beta")?.checkedAt).toBe(time.now().toISOString());
    });
    await vi.waitFor(() => expect(controller.detail(profile.id).renewing).toBe(false));
  });

  it("does not report a manual test as a renewal", async () => {
    const store = await runtimeStore();
    const time = clock();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker(), now: time.now });
    const created = await controller.createProfile(anthropicDraft());
    await controller.reconcileCredentialRevision(created.id, "generation:one");
    const pending = deferredProbe();
    probeCompatibility.mockImplementation(async () => await pending.promise);

    const probing = controller.probe(created.id, ["alpha"]);
    await vi.waitFor(() => expect(probeCompatibility).toHaveBeenCalledTimes(1));
    expect(controller.detail(created.id)).toMatchObject({ connectionState: "testing", renewing: false });
    pending.resolve(successfulProbe(probeCompatibility.mock.calls[0]![0], time.now()));
    await probing;
  });

  it("probes expired evidence before launch instead of refusing", async () => {
    const store = await runtimeStore();
    const time = clock();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker(), now: time.now });
    const profile = await enabledProfile(controller, store, time);
    time.advance(BACKEND_PROBE_FRESHNESS_MS + 1_000);
    probeCompatibility.mockImplementation(async (request) => successfulProbe(request, time.now()));

    await expect(controller.readiness(
      modelSelectionForBackendProfile(profile, "alpha"),
      installedProvider("claude"),
    )).resolves.toEqual({ ready: true, message: null });
    expect(probeCompatibility).toHaveBeenCalledTimes(1);
    expect(controller.detail(profile.id).models[0]?.compatibility.state).toBe("partially-compatible");
  });

  it("probes a model that was never checked before launch", async () => {
    const store = await runtimeStore();
    const time = clock();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker(), now: time.now });
    const profile = await enabledProfile(controller, store, time);
    await controller.updateProfile(profile.id, {
      models: [...profile.models, {
        id: "gamma",
        displayName: "Model gamma",
        contextWindowTokens: null,
        reasoningOptions: [],
        capabilities: [],
      }],
    });
    probeCompatibility.mockImplementation(async (request) => successfulProbe(request, time.now()));

    await expect(controller.readiness(
      modelSelectionForBackendProfile(store.modelBackendProfile(profile.id).profile, "gamma"),
      installedProvider("claude"),
    )).resolves.toEqual({ ready: true, message: null });
    expect(probeCompatibility.mock.calls.map(([request]) => request.modelId)).toEqual(["gamma"]);
  });

  it("refuses with the probe failure when the synchronous check fails", async () => {
    const store = await runtimeStore();
    const time = clock();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker(), now: time.now });
    const profile = await enabledProfile(controller, store, time);
    time.advance(BACKEND_PROBE_FRESHNESS_MS + 1_000);
    probeCompatibility.mockImplementation(async (request) => failedProbe(request, time.now()));

    await expect(controller.readiness(
      modelSelectionForBackendProfile(profile, "alpha"),
      installedProvider("claude"),
    )).resolves.toEqual({
      ready: false,
      message: expect.stringContaining("The backend rejected the configured credential."),
    });
  });
});

describe("private network launches", () => {
  it("applies the profile's private network switch to the Claude launch check", async () => {
    const store = await runtimeStore();
    const time = clock();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker(), now: time.now });
    const launch = async (allowPrivateNetwork: boolean) => {
      const profile = await enabledProfile(controller, store, time, anthropicDraft({
        displayName: allowPrivateNetwork ? "LAN gateway" : "Blocked LAN gateway",
        baseUrl: "https://10.0.0.8:8443",
        allowPrivateNetwork,
      }));
      const selection = modelSelectionForBackendProfile(profile, "alpha");
      const backendProfile = safeBackendProfile(profile);
      const input: ProviderRunInput = {
        providerId: "claude",
        harnessId: "claude-agent-sdk",
        backendProfile,
        backendCompatibility: controller.detail(profile.id).models[0]!.compatibility,
        modelSelection: selection,
        continuationIdentity: continuationIdentityForSelection(selection, profile.endpointIdentity),
        conversationId: "conversation",
        runId: "run-conversation",
        turnId: "turn-conversation",
        cwd: "/workspace",
        prompt: "Inspect",
        model: "alpha",
        reasoningEffort: "",
        interactionMode: "build",
        access: "supervised",
      };
      return await controller.providerManagerOptions().resolveBackendLaunchOptions!(
        input,
        {},
        { signal: new AbortController().signal },
      );
    };

    await expect(launch(false)).rejects.toMatchObject({ code: "invalid-profile" });
    await expect(launch(true)).resolves.toMatchObject({
      environment: { ANTHROPIC_BASE_URL: "https://10.0.0.8:8443/" },
    });
  });
});

describe("readiness without a provider account", () => {
  it("depends on the installed CLI and the saved key, not on sign-in", async () => {
    const store = await runtimeStore();
    const time = clock();
    const credentials = credentialBroker();
    const controller = await BackendProfileController.create({ store, credentials, now: time.now });
    const profile = await enabledProfile(controller, store, time);
    const selection = modelSelectionForBackendProfile(profile, "alpha");

    await expect(controller.readiness(selection, installedProvider("claude", {
      authState: "unauthenticated",
      canRun: false,
    }))).resolves.toEqual({ ready: true, message: null });
    await expect(controller.readiness(selection, installedProvider("claude", {
      available: false,
      installState: "not-installed",
      executable: null,
    }))).resolves.toMatchObject({ ready: false, message: expect.stringContaining("not installed") });
    credentials.hasSecret = false;
    await expect(controller.readiness(selection, installedProvider("claude")))
      .resolves.toMatchObject({ ready: false });
  });

  it("exposes route kind and provider for account and key routes", async () => {
    const store = await runtimeStore();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker() });
    await controller.createProfile({ preset: "anthropic-api-key" });

    const views = controller.profiles([installedProvider("claude")]);

    expect(views.find(({ id }) => id === "builtin:anthropic")).toMatchObject({
      routeKind: "account",
      providerId: "claude",
      allowPrivateNetwork: false,
    });
    expect(views.find(({ preset }) => preset === "anthropic-api-key")).toMatchObject({
      routeKind: "api-key",
      providerId: "claude",
      allowPrivateNetwork: false,
    });
  });
});

describe("prompt cache length", () => {
  async function launchFor(
    controller: BackendProfileController,
    profile: PersistedModelBackendProfile,
  ) {
    const selection = modelSelectionForBackendProfile(profile, profile.routing.primaryModelId);
    const input: ProviderRunInput = {
      providerId: "claude",
      harnessId: "claude-agent-sdk",
      backendProfile: safeBackendProfile(profile),
      backendCompatibility: controller.detail(profile.id).models[0]!.compatibility,
      modelSelection: selection,
      continuationIdentity: continuationIdentityForSelection(selection, profile.endpointIdentity),
      conversationId: "conversation",
      runId: "run-conversation",
      turnId: "turn-conversation",
      cwd: "/workspace",
      prompt: "Inspect",
      model: profile.routing.primaryModelId,
      reasoningEffort: "",
      interactionMode: "build",
      access: "supervised",
    };
    return await controller.providerManagerOptions().resolveBackendLaunchOptions!(
      input,
      { CLAUDE_CODE_PROMPT_CACHE_TTL: "5m" },
      { signal: new AbortController().signal },
    );
  }

  const privateGateway = (promptCacheTtl?: "5m" | "1h") => anthropicDraft({
    displayName: "LAN gateway",
    baseUrl: "https://10.0.0.8:8443",
    allowPrivateNetwork: true,
    ...(promptCacheTtl ? { promptCacheTtl } : {}),
  });

  it("persists the one-hour opt-in on the Anthropic key preset", async () => {
    const store = await runtimeStore();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker() });
    const created = await controller.createProfile({ preset: "anthropic-api-key", promptCacheTtl: "1h" });
    expect(created.promptCacheTtl).toBe("1h");
    expect(store.modelBackendProfile(created.id).profile.promptCacheTtl).toBe("1h");
    expect(controller.profiles([]).find(({ id }) => id === created.id)?.promptCacheTtl).toBe("1h");
    expect(controller.detail(created.id).promptCacheTtl).toBe("1h");
  });

  it("passes the cache length to the Claude launch and changes it without a new revision", async () => {
    const store = await runtimeStore();
    const time = clock();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker(), now: time.now });
    const enabled = await enabledProfile(controller, store, time, privateGateway("1h"));
    const created = { id: enabled.id };
    const launch = await launchFor(controller, enabled);
    expect(launch.harnessConfiguration).toEqual({ kind: "claude-messages", promptCacheTtl: "1h" });
    expect(launch.environment).not.toHaveProperty("CLAUDE_CODE_PROMPT_CACHE_TTL");

    const shortened = await controller.updateProfile(created.id, { promptCacheTtl: "5m" });
    expect(shortened).toMatchObject({ promptCacheTtl: "5m", enabled: true, configurationRevision: enabled.configurationRevision });
    expect((await launchFor(controller, store.modelBackendProfile(created.id).profile)).harnessConfiguration)
      .toEqual({ kind: "claude-messages", promptCacheTtl: "5m" });
  });

  it("launches without a cache length when the profile does not set one", async () => {
    const store = await runtimeStore();
    const time = clock();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker(), now: time.now });
    const profile = await enabledProfile(controller, store, time, privateGateway());
    expect(profile).not.toHaveProperty("promptCacheTtl");
    expect(await launchFor(controller, profile)).not.toHaveProperty("harnessConfiguration");
  });

  it("drops the cache length when a Claude backend moves to the Codex harness", async () => {
    const store = await runtimeStore();
    const time = clock();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker(), now: time.now });
    const created = await controller.createProfile(privateGateway("1h"));
    expect(created.promptCacheTtl).toBe("1h");

    const moved = await controller.updateProfile(created.id, {
      harnessId: "codex-app-server",
      protocol: "openai-responses",
      authenticationMode: "bearer-token",
    });
    expect(moved).toMatchObject({ harnessId: "codex-app-server", protocol: "openai-responses" });
    expect(moved).not.toHaveProperty("promptCacheTtl");
    expect(store.modelBackendProfile(created.id).profile).not.toHaveProperty("promptCacheTtl");

    await controller.updateProfile(created.id, {
      harnessId: "claude-agent-sdk",
      protocol: "anthropic-messages",
      authenticationMode: "api-key",
    });
    await controller.reconcileCredentialRevision(created.id, "generation:one");
    probeCompatibility.mockImplementation(async (request) => successfulProbe(request, time.now()));
    await controller.probe(created.id);
    await controller.updateProfile(created.id, { enabled: true });
    const back = store.modelBackendProfile(created.id).profile;
    expect(back).not.toHaveProperty("promptCacheTtl");
    expect(await launchFor(controller, back)).not.toHaveProperty("harnessConfiguration");
  });

  it("clears the cache length with an explicit null and keeps it when the update omits it", async () => {
    const store = await runtimeStore();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker() });
    const created = await controller.createProfile({ preset: "anthropic-api-key", promptCacheTtl: "1h" });
    const renamed = await controller.updateProfile(created.id, { displayName: "Long cache" });
    expect(renamed.promptCacheTtl).toBe("1h");
    const cleared = await controller.updateProfile(created.id, { promptCacheTtl: null });
    expect(cleared).not.toHaveProperty("promptCacheTtl");
    expect(store.modelBackendProfile(created.id).profile).not.toHaveProperty("promptCacheTtl");
  });

  it("never launches Kimi with a cache length and drops one stored on it at the next update", async () => {
    const store = await runtimeStore();
    const kimi = createKimiClaudeBackendProfile({
      id: "kimi:cache-length",
      secretReference: "secret:kimi-cache-length",
      primaryModelId: KIMI_CODING_MODELS[0]!.id,
    });
    const controller = await BackendProfileController.create({
      store,
      credentials: credentialBroker(),
      builtInClaudeProfiles: [kimi],
    });
    const stored = store.modelBackendProfile(kimi.id).profile;
    expect(stored.preset).toBe("kimi-code");
    store.saveModelBackendProfile({ ...stored, promptCacheTtl: "1h" });
    expect(store.modelBackendProfile(kimi.id).profile.promptCacheTtl).toBe("1h");
    const launch = await launchFor(controller, store.modelBackendProfile(kimi.id).profile);
    expect(launch).not.toHaveProperty("harnessConfiguration");
    expect(store.modelBackendProfile(kimi.id).profile.promptCacheTtl).toBe("1h");
    await controller.updateProfile(kimi.id, { enabled: false });
    expect(store.modelBackendProfile(kimi.id).profile).not.toHaveProperty("promptCacheTtl");
    await expect(controller.updateProfile(kimi.id, { promptCacheTtl: "1h" })).rejects.toThrow();
  });

  it("refuses a cache length on an OpenAI key", async () => {
    const store = await runtimeStore();
    const controller = await BackendProfileController.create({ store, credentials: credentialBroker() });
    await expect(controller.createProfile({ preset: "openai-api-key", promptCacheTtl: "1h" }))
      .rejects.toThrow("Prompt cache length can be set only on Claude Agent SDK backends that use Anthropic Messages.");
    const created = await controller.createProfile({ preset: "openai-api-key" });
    await expect(controller.updateProfile(created.id, { promptCacheTtl: "1h" })).rejects.toThrow();
    expect(store.modelBackendProfile(created.id).profile).not.toHaveProperty("promptCacheTtl");
    await expect(controller.updateProfile(created.id, { promptCacheTtl: null })).resolves.not.toHaveProperty("promptCacheTtl");
  });
});
