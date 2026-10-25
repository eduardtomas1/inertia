import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { backendEndpointIdentity } from "../../src/shared/backend-endpoint-identity";
import { modelSelectionForBackendProfile } from "../../src/shared/backend-profile-settings";
import type { ProviderInfo } from "../../src/shared/contracts";
import {
  continuationIdentityForSelection,
  MODEL_CAPABILITY_IDS,
} from "../../src/shared/model-routing";
import { createCustomClaudeBackendProfile } from "../../src/shared/claude-backend-profiles";
import { RuntimeStore } from "../../src/server/database";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import type { ProviderRunInput } from "../../src/server/provider/contracts";
import { ProviderManager } from "../../src/server/providers";
import { BackendProfileController } from "../../src/server/runtime/backends/backend-profile-controller";
import { safeBackendProfile } from "../../src/server/runtime/backends/backend-profile-model";
import { backendProbeTestAuthority } from "../helpers/backend-probe-authority";

const fixture = resolve(import.meta.dirname, "..", "fixtures", "database", "v0.0.6.sqlite");
const PROFILE_ID = "custom:legacy-no-auth";
const BASE_URL = "https://legacy-gateway.example.test/v1";
const TIMESTAMP = "2026-09-20T08:00:00.000Z";
const CREDENTIAL_MESSAGE = "Add an API key or bearer token to use this backend.";
const directories: string[] = [];
const stores = new Set<RuntimeStore>();

afterEach(async () => {
  for (const store of stores) store.close();
  stores.clear();
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function legacyProfile() {
  return {
    id: PROFILE_ID,
    displayName: "Legacy gateway",
    harnessId: "claude-agent-sdk" as const,
    protocol: "anthropic-messages" as const,
    authenticationMode: "none" as const,
    source: "custom" as const,
    enabled: true,
    configurationRevision: 2,
    endpointIdentity: backendEndpointIdentity(BASE_URL),
    preset: "custom" as const,
    baseUrl: BASE_URL,
    allowInsecureLocalhost: false,
    credentialGeneration: null,
    models: [{
      id: "legacy-model",
      displayName: "Legacy model",
      contextWindowTokens: null,
      reasoningOptions: [],
      capabilities: [],
    }],
    routing: { mode: "simple" as const, primaryModelId: "legacy-model" },
    capabilityHints: [],
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function legacyEvidence() {
  const checkedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    results: [{
      profileId: PROFILE_ID,
      backendConfigurationRevision: 2,
      endpointIdentity: backendEndpointIdentity(BASE_URL),
      protocol: "anthropic-messages",
      modelId: "legacy-model",
      compatibility: "protocol-compatible",
      protocolVerified: true,
      modelVerified: true,
      capabilities: MODEL_CAPABILITY_IDS.map((id) => ({
        id,
        state: "verified",
        provenance: "probe",
        detail: null,
        checkedAt,
      })),
      contextWindow: {
        tokens: 200_000,
        state: "verified",
        provenance: "probe",
        detail: null,
        checkedAt,
      },
      failure: null,
      checkedAt,
      authority: backendProbeTestAuthority(checkedAt),
    }],
    admissionHighWater: [{ modelId: "legacy-model", admissionSequence: 1 }],
  };
}

async function upgradedStore(): Promise<RuntimeStore> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-no-auth-claude-"));
  directories.push(directory);
  const databasePath = join(directory, "published.sqlite");
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  await copyFile(fixture, databasePath);
  const database = new Database(databasePath);
  try {
    migrateRuntimeDatabase(database, 100);
    const profile = legacyProfile();
    database.prepare(`
      INSERT INTO model_backend_profiles (
        profile_id, harness_id, preset, protocol, source, enabled,
        configuration_revision, endpoint_identity, credential_generation,
        configuration_json, latest_probe_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL, ?, ?, ?, ?)
    `).run(
      profile.id,
      profile.harnessId,
      profile.preset,
      profile.protocol,
      profile.source,
      profile.configurationRevision,
      profile.endpointIdentity,
      JSON.stringify(profile),
      JSON.stringify(legacyEvidence()),
      TIMESTAMP,
      TIMESTAMP,
    );
  } finally {
    database.close();
  }
  const store = new RuntimeStore(databasePath, workspacePath);
  stores.add(store);
  return store;
}

function claudeProvider(): ProviderInfo {
  return {
    id: "claude",
    label: "Claude",
    command: "claude",
    available: true,
    version: "1.0.0",
    executable: "/opt/bin/claude",
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    statusMessage: null,
    models: [],
    rateLimits: [],
    metadataState: {
      models: { freshness: "unavailable", provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false },
      rateLimits: { freshness: "unavailable", provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false },
    },
  };
}

describe("stored Claude-compatible profiles without a key", () => {
  it("keeps the stored row readable but refuses readiness, probing and launch", async () => {
    const store = await upgradedStore();
    const controller = await BackendProfileController.create({ store });
    const stored = store.modelBackendProfile(PROFILE_ID).profile;
    const selection = modelSelectionForBackendProfile(stored, "legacy-model");

    const view = controller.profiles([claudeProvider()]).find(({ id }) => id === PROFILE_ID);
    expect(view).toMatchObject({ authenticationMode: "none", enabled: true });
    expect(view?.models[0]?.compatibility).toMatchObject({
      state: "unavailable",
      reasonCode: "credential-required",
      reason: CREDENTIAL_MESSAGE,
    });
    await expect(controller.readiness(selection, claudeProvider()))
      .resolves.toEqual({ ready: false, message: CREDENTIAL_MESSAGE });
    await expect(controller.probe(PROFILE_ID)).rejects.toThrow(CREDENTIAL_MESSAGE);

    const options = controller.providerManagerOptions();
    const manager = ProviderManager.createForTests(options);
    expect(manager.resolveModelRoute(selection).compatibility).toMatchObject({
      state: "unavailable",
      reasonCode: "credential-required",
    });
    const input: ProviderRunInput = {
      providerId: "claude",
      harnessId: "claude-agent-sdk",
      backendProfile: safeBackendProfile(stored),
      backendCompatibility: {
        harnessId: "claude-agent-sdk",
        backendProfileId: PROFILE_ID,
        backendProtocol: "anthropic-messages",
        state: "partially-compatible",
        provenance: "probe",
        allowsModelSwitchWithinSession: false,
        reasonCode: "anthropic-probe-verified",
        reason: "Forged evidence.",
      },
      modelSelection: selection,
      continuationIdentity: continuationIdentityForSelection(selection, stored.endpointIdentity),
      conversationId: "conversation",
      runId: "run-conversation",
      turnId: "turn-conversation",
      cwd: "/workspace",
      prompt: "Inspect",
      model: "legacy-model",
      reasoningEffort: "",
      interactionMode: "build",
      access: "supervised",
    };
    await expect(Promise.resolve().then(() => options.resolveBackendLaunchOptions!(
      input,
      { CLAUDE_CODE_OAUTH_TOKEN: "account-token" },
      { signal: new AbortController().signal },
    ))).rejects.toMatchObject({ message: CREDENTIAL_MESSAGE });
  });

  it("lets the person switch the stored row to a key", async () => {
    const store = await upgradedStore();
    const controller = await BackendProfileController.create({
      store,
      credentials: {
        resolve: async () => "replacement-key",
        status: async () => ({ hasSecret: true, credentialGeneration: "generation:new" }),
        forget: async () => true,
      },
    });

    const updated = await controller.updateProfile(PROFILE_ID, { authenticationMode: "api-key" });

    expect(updated).toMatchObject({ authenticationMode: "api-key", enabled: false });
    expect(updated.models[0]?.compatibility.reasonCode).not.toBe("credential-required");
  });

  it("refuses a keyless custom Claude-compatible launch profile", () => {
    expect(() => createCustomClaudeBackendProfile({
      id: "custom:keyless",
      displayName: "Keyless",
      baseUrl: "https://gateway.example.test",
      authenticationMode: "none",
      secretReference: null,
      primaryModelId: "model",
    })).toThrow(CREDENTIAL_MESSAGE);
  });
});
