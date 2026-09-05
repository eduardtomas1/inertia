import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

import type { ModelBackendProfileDraft, PersistedModelBackendProfile } from "../../src/shared/backend-profile-settings";
import type {
  BackendCompatibilityProbeRequest,
  BackendCompatibilityProbeResult,
} from "../../src/shared/backend-probe";
import {
  MODEL_CAPABILITY_IDS,
  modelSelectionSchema,
} from "../../src/shared/model-routing";
import { RuntimeStore } from "../../src/server/database";
import { ProviderManager } from "../../src/server/providers";
import { backendProbeTestAuthority } from "../helpers/backend-probe-authority";

const PROBE_NOW = new Date("2030-01-01T00:00:03.000Z");

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
} from "../../src/server/runtime/backends/backend-profile-controller";

const temporaryDirectories: string[] = [];
const openStores = new Set<RuntimeStore>();

async function databaseSubject(): Promise<{
  directory: string;
  databasePath: string;
  store: RuntimeStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-probe-order-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "runtime.sqlite");
  const store = new RuntimeStore(databasePath, directory);
  openStores.add(store);
  return { directory, databasePath, store };
}

function closeStore(store: RuntimeStore): void {
  store.close();
  openStores.delete(store);
}

function draft(): ModelBackendProfileDraft {
  return {
    displayName: "Concurrent probe gateway",
    harnessId: "claude-agent-sdk",
    protocol: "anthropic-messages",
    authenticationMode: "none",
    preset: "custom",
    baseUrl: "https://probe-order.example.test/v1",
    allowInsecureLocalhost: false,
    models: ["probe-model", "probe-model-b"].map((id) => ({
      id,
      displayName: id,
      contextWindowTokens: null,
      reasoningOptions: [],
      capabilities: [],
    })),
    routing: { mode: "simple", primaryModelId: "probe-model" },
    capabilityHints: [],
  };
}

function compatibleProbe(
  profile: PersistedModelBackendProfile,
  checkedAt: string,
  contextWindowTokens: number,
  modelId = "probe-model",
): BackendCompatibilityProbeResult {
  return {
    profileId: profile.id,
    backendConfigurationRevision: profile.configurationRevision,
    endpointIdentity: profile.endpointIdentity,
    protocol: profile.protocol,
    modelId,
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
      tokens: contextWindowTokens,
      state: "verified",
      provenance: "probe",
      detail: null,
      checkedAt,
    },
    failure: null,
    checkedAt,
  };
}

function bulkyCompatibleProbe(
  profile: PersistedModelBackendProfile,
  checkedAt: string,
  contextWindowTokens: number,
  modelId: string,
): BackendCompatibilityProbeResult {
  const result = compatibleProbe(
    profile,
    checkedAt,
    contextWindowTokens,
    modelId,
  );
  const detail = "x".repeat(1_000);
  return {
    ...result,
    capabilities: result.capabilities.map((capability) => ({
      ...capability,
      detail,
    })),
    contextWindow: { ...result.contextWindow, detail },
  };
}

function authorizedProbe(
  result: BackendCompatibilityProbeResult,
  admissionSequence: number,
): BackendCompatibilityProbeResult {
  return {
    ...result,
    authority: backendProbeTestAuthority(result.checkedAt, admissionSequence),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

afterEach(async () => {
  probeCompatibility.mockReset();
  for (const store of openStores) store.close();
  openStores.clear();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("durable backend probe ordering", () => {
  it("preserves the newer evidence when overlapping probes complete out of order", async () => {
    const subject = await databaseSubject();
    const controller = await BackendProfileController.create({
      store: subject.store,
      now: () => PROBE_NOW,
    });
    const created = await controller.createProfile(draft());
    const profile = subject.store.modelBackendProfile(created.id).profile;
    const olderResult = compatibleProbe(
      profile,
      "2030-01-01T00:00:01.000Z",
      100_000,
    );
    const newerResult = compatibleProbe(
      profile,
      "2030-01-01T00:00:02.000Z",
      200_000,
    );
    const older = deferred<BackendCompatibilityProbeResult>();
    const newer = deferred<BackendCompatibilityProbeResult>();
    probeCompatibility
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    const olderCompletion = controller.probe(profile.id, "probe-model");
    expect(probeCompatibility).toHaveBeenCalledTimes(1);
    const newerCompletion = controller.probe(profile.id, "probe-model");
    expect(probeCompatibility).toHaveBeenCalledTimes(2);

    newer.resolve(newerResult);
    await expect(newerCompletion).resolves.toMatchObject({
      latestProbe: {
        checkedAt: newerResult.checkedAt,
        contextWindow: { tokens: 200_000 },
      },
    });
    older.resolve(olderResult);
    await expect(olderCompletion).resolves.toMatchObject({
      latestProbe: {
        checkedAt: newerResult.checkedAt,
        contextWindow: { tokens: 200_000 },
      },
    });
    expect(subject.store.modelBackendProfile(profile.id).latestProbe)
      .toMatchObject(newerResult);
    expect(subject.store.modelBackendProfile(profile.id).probeResults)
      .toMatchObject([newerResult]);
  });

  it("hydrates the preserved newest evidence after the runtime store reopens", async () => {
    const subject = await databaseSubject();
    const controller = await BackendProfileController.create({
      store: subject.store,
      now: () => PROBE_NOW,
    });
    const created = await controller.createProfile(draft());
    const profile = subject.store.modelBackendProfile(created.id).profile;
    const newerResult = compatibleProbe(
      profile,
      "2030-01-01T00:00:02.000Z",
      200_000,
    );
    const olderResult = compatibleProbe(
      profile,
      "2030-01-01T00:00:01.000Z",
      100_000,
    );

    const authorizedNewer = authorizedProbe(newerResult, 2);
    const authorizedOlder = authorizedProbe(olderResult, 1);
    subject.store.recordModelBackendProbe(profile.id, authorizedNewer);
    subject.store.recordModelBackendProbe(profile.id, authorizedOlder);
    closeStore(subject.store);

    const reopened = new RuntimeStore(subject.databasePath, subject.directory);
    openStores.add(reopened);
    const hydrated = BackendProfileController.open({
      store: reopened,
      now: () => PROBE_NOW,
    })
      .providerManagerOptions();

    expect(reopened.modelBackendProfile(profile.id).latestProbe)
      .toEqual(authorizedNewer);
    expect(hydrated.backendProbeResults).toEqual([authorizedNewer]);
  });

  it("orders A/B model probes independently and hydrates both after restart", async () => {
    const subject = await databaseSubject();
    const controller = await BackendProfileController.create({
      store: subject.store,
      now: () => PROBE_NOW,
    });
    const created = await controller.createProfile(draft());
    const profile = subject.store.modelBackendProfile(created.id).profile;
    const olderA = compatibleProbe(
      profile,
      "2030-01-01T00:00:01.000Z",
      100_000,
      "probe-model",
    );
    const newerB = compatibleProbe(
      profile,
      "2030-01-01T00:00:02.000Z",
      200_000,
      "probe-model-b",
    );
    const a = deferred<BackendCompatibilityProbeResult>();
    const b = deferred<BackendCompatibilityProbeResult>();
    probeCompatibility.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);

    const aCompletion = controller.probe(profile.id, "probe-model");
    const bCompletion = controller.probe(profile.id, "probe-model-b");
    b.resolve(newerB);
    await bCompletion;
    a.resolve(olderA);
    await aCompletion;

    expect(subject.store.modelBackendProfile(profile.id).probeResults)
      .toMatchObject([newerB, olderA]);
    subject.store.saveModelBackendProfile({
      ...profile,
      enabled: true,
      updatedAt: "2030-01-01T00:00:03.000Z",
    });
    closeStore(subject.store);

    const reopened = new RuntimeStore(subject.databasePath, subject.directory);
    openStores.add(reopened);
    const hydrated = BackendProfileController.open({
      store: reopened,
      now: () => PROBE_NOW,
    })
      .providerManagerOptions();
    expect(reopened.modelBackendProfile(profile.id).probeResults)
      .toMatchObject([newerB, olderA]);
    expect(hydrated.backendProbeResults).toMatchObject([newerB, olderA]);
    const manager = ProviderManager.createForTests(hydrated);
    for (const modelId of ["probe-model", "probe-model-b"]) {
      const route = manager.resolveModelRoute(modelSelectionSchema.parse({
        harnessId: profile.harnessId,
        backendProfileId: profile.id,
        backendProfileDisplayName: profile.displayName,
        modelId,
        alias: null,
        reasoningEffort: null,
        contextWindowOverride: null,
        providerOptions: {},
        capabilities: [],
        backendConfigurationRevision: profile.configurationRevision,
      }));
      expect(route.compatibility).toMatchObject({
        state: "partially-compatible",
        provenance: "probe",
      });
    }
  });

  it("reads the released single-result JSON shape and migrates on the next write", async () => {
    const subject = await databaseSubject();
    const controller = await BackendProfileController.create({
      store: subject.store,
      now: () => PROBE_NOW,
    });
    const created = await controller.createProfile(draft());
    const profile = subject.store.modelBackendProfile(created.id).profile;
    const legacy = compatibleProbe(
      profile,
      "2030-01-01T00:00:01.000Z",
      100_000,
    );
    subject.store.saveModelBackendProfile({
      ...profile,
      enabled: true,
      updatedAt: "2030-01-01T00:00:01.500Z",
    });
    closeStore(subject.store);
    const database = new Database(subject.databasePath);
    database.prepare(`
      UPDATE model_backend_profiles SET latest_probe_json = ? WHERE profile_id = ?
    `).run(JSON.stringify(legacy), profile.id);
    database.close();

    const reopened = new RuntimeStore(subject.databasePath, subject.directory);
    openStores.add(reopened);
    expect(reopened.modelBackendProfile(profile.id)).toMatchObject({
      probeResults: [legacy],
      latestProbe: legacy,
    });
    const legacyController = BackendProfileController.open({
      store: reopened,
      now: () => PROBE_NOW,
    });
    expect(legacyController.detail(profile.id).compatibility).toMatchObject({
      state: "unknown",
      reasonCode: "probe-stale",
    });
    const newerB = compatibleProbe(
      profile,
      "2030-01-01T00:00:02.000Z",
      200_000,
      "probe-model-b",
    );
    const authorizedNewerB = authorizedProbe(newerB, 1);
    reopened.recordModelBackendProbe(profile.id, authorizedNewerB);
    closeStore(reopened);

    const inspection = new Database(subject.databasePath, { readonly: true });
    const row = inspection.prepare(`
      SELECT latest_probe_json FROM model_backend_profiles WHERE profile_id = ?
    `).get(profile.id) as { latest_probe_json: string };
    inspection.close();
    expect(JSON.parse(row.latest_probe_json)).toMatchObject({
      schemaVersion: 1,
      results: [authorizedNewerB, legacy],
      admissionHighWater: [{
        modelId: "probe-model-b",
        admissionSequence: 1,
      }],
    });
  });

  it("bounds the durable per-model cache by model count and serialized size", async () => {
    const subject = await databaseSubject();
    const modelIds = Array.from(
      { length: 128 },
      (_, index) => `model-${String(index).padStart(3, "0")}`,
    );
    const controller = await BackendProfileController.create({
      store: subject.store,
      now: () => PROBE_NOW,
    });
    const created = await controller.createProfile({
      ...draft(),
      models: modelIds.map((id) => ({
        id,
        displayName: id,
        contextWindowTokens: null,
        reasoningOptions: [],
        capabilities: [],
      })),
      routing: { mode: "simple", primaryModelId: modelIds[0]! },
    });
    const profile = subject.store.modelBackendProfile(created.id).profile;
    for (const [index, modelId] of modelIds.entries()) {
      subject.store.recordModelBackendProbe(profile.id, authorizedProbe(
        bulkyCompatibleProbe(
          profile,
          new Date(Date.UTC(2030, 0, 1, 0, 0, index)).toISOString(),
          100_000 + index,
          modelId,
        ),
        1,
      ));
    }

    const stored = subject.store.modelBackendProfile(profile.id);
    expect(stored.probeResults.length).toBeGreaterThan(0);
    expect(stored.probeResults.length).toBeLessThanOrEqual(128);
    expect(new Set(stored.probeResults.map(({ modelId }) => modelId)).size)
      .toBe(stored.probeResults.length);
    expect(stored.probeResults.some(({ modelId }) => modelId === modelIds.at(-1)))
      .toBe(true);
    expect(stored.probeResults.length).toBeLessThan(modelIds.length);
    expect(stored.probeAdmissionHighWater).toHaveLength(modelIds.length);
    const evictedModelId = modelIds.find((modelId) =>
      !stored.probeResults.some((result) => result.modelId === modelId));
    expect(evictedModelId).toBeDefined();
    expect(stored.probeAdmissionHighWater.find(
      ({ modelId }) => modelId === evictedModelId,
    )?.admissionSequence).toBe(1);

    closeStore(subject.store);
    const reopened = new RuntimeStore(subject.databasePath, subject.directory);
    openStores.add(reopened);
    reopened.recordModelBackendProbe(profile.id, authorizedProbe(
      compatibleProbe(
        profile,
        PROBE_NOW.toISOString(),
        250_000,
        evictedModelId!,
      ),
      1,
    ));
    expect(reopened.modelBackendProfile(profile.id).probeResults.some(
      ({ modelId }) => modelId === evictedModelId,
    )).toBe(false);
    const restartedController = BackendProfileController.open({
      store: reopened,
      now: () => PROBE_NOW,
    });
    probeCompatibility.mockResolvedValueOnce(compatibleProbe(
      profile,
      PROBE_NOW.toISOString(),
      300_000,
      evictedModelId!,
    ));
    await restartedController.probe(profile.id, evictedModelId!);

    const afterRestart = reopened.modelBackendProfile(profile.id);
    expect(afterRestart.probeResults.find(
      ({ modelId }) => modelId === evictedModelId,
    )?.authority?.admissionSequence).toBe(2);
    expect(afterRestart.probeAdmissionHighWater.find(
      ({ modelId }) => modelId === evictedModelId,
    )?.admissionSequence).toBe(2);
  });
});
