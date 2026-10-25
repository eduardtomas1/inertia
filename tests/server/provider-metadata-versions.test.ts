import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type Database from "better-sqlite3";

import { RuntimeStore } from "../../src/server/database";
import type { PersistedProviderMetadata } from "../../src/server/provider/metadata";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function metadata(
  modelId: string,
  executable: string,
  version: string | null,
): PersistedProviderMetadata {
  return {
    scope: {
      providerId: "claude",
      harnessId: "claude-agent-sdk",
      backendProfileId: "builtin:anthropic",
      modelId,
      executable,
      version,
      backendConfigurationRevision: 0,
      authState: version === null ? "unknown" : "authenticated",
    },
    models: [],
    modelsUpdatedAt: "2026-10-25T10:00:00.000Z",
    modelsLastAttemptedAt: "2026-10-25T10:00:00.000Z",
    modelsProvenance: "provider",
    modelsStale: false,
    rateLimits: [],
    rateLimitsUpdatedAt: null,
    rateLimitsLastAttemptedAt: null,
    rateLimitsProvenance: null,
    rateLimitsStale: false,
  };
}

function saved(store: RuntimeStore): string[] {
  return store.loadProviderMetadata().map(({ scope }) =>
    `${scope.modelId} ${scope.executable} ${scope.version ?? "unversioned"}`).sort();
}

async function createStore(): Promise<{ databasePath: string; workspacePath: string; store: RuntimeStore }> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-provider-metadata-versions-"));
  directories.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const databasePath = join(directory, "inertia.sqlite");
  return { databasePath, workspacePath, store: new RuntimeStore(databasePath, workspacePath) };
}

describe("provider metadata scope versions", () => {
  it("keeps only the newest saved CLI version of each provider model scope", async () => {
    const { databasePath, workspacePath, store } = await createStore();
    const saved = (
      modelId: string,
      version: string,
      authState: "authenticated" | "unauthenticated" | "configured" = "authenticated",
      backendProfileId = "builtin:anthropic",
    ) =>
      store.saveProviderMetadata({
        scope: {
          providerId: "claude",
          harnessId: "claude-agent-sdk",
          backendProfileId,
          modelId,
          executable: "/home/user/.local/bin/claude",
          version,
          backendConfigurationRevision: 0,
          authState,
        },
        models: [],
        modelsUpdatedAt: "2026-10-25T10:00:00.000Z",
        modelsLastAttemptedAt: "2026-10-25T10:00:00.000Z",
        modelsProvenance: "provider",
        modelsStale: false,
        rateLimits: [],
        rateLimitsUpdatedAt: null,
        rateLimitsLastAttemptedAt: null,
        rateLimitsProvenance: null,
        rateLimitsStale: false,
      });
    saved("provider-catalog", "2.1.0");
    saved("provider-catalog", "2.1.0", "unauthenticated");
    saved("sonnet", "2.1.0");
    saved("k3", "2.1.0", "configured", "builtin:kimi-code");
    saved("provider-catalog", "2.1.1");
    store.close();

    const reopened = new RuntimeStore(databasePath, workspacePath);
    expect(reopened.loadProviderMetadata().map(({ scope }) =>
      `${scope.backendProfileId} ${scope.modelId} ${scope.version} ${scope.authState}`).sort()).toEqual([
      "builtin:anthropic provider-catalog 2.1.1 authenticated",
      "builtin:anthropic sonnet 2.1.0 authenticated",
      "builtin:kimi-code k3 2.1.0 configured",
    ]);
    reopened.close();
  });

  it("keeps each executable's newest version and the unversioned rows of other executables", async () => {
    const { store } = await createStore();
    try {
      store.saveProviderMetadata(metadata("sonnet", "/usr/local/bin/claude", "2.1.0"));
      store.saveProviderMetadata(metadata("sonnet", "/opt/tools/claude-wrapper", null));
      store.saveProviderMetadata(metadata("sonnet", "/home/user/.local/bin/claude", "2.2.0"));
      store.saveProviderMetadata(metadata("sonnet", "/usr/local/bin/claude", "2.1.1"));
      expect(saved(store)).toEqual([
        "sonnet /home/user/.local/bin/claude 2.2.0",
        "sonnet /opt/tools/claude-wrapper unversioned",
        "sonnet /usr/local/bin/claude 2.1.1",
      ]);
    } finally {
      store.close();
    }
  });

  it("keeps the previous version when saving the new version fails", async () => {
    const { store } = await createStore();
    try {
      store.saveProviderMetadata(metadata("sonnet", "/usr/local/bin/claude", "2.1.0"));
      const database = (store as unknown as { database: Database.Database }).database;
      database.exec(`
        CREATE TEMP TRIGGER refuse_metadata BEFORE INSERT ON main.provider_metadata_scoped_cache
        BEGIN SELECT RAISE(ABORT, 'refused'); END
      `);
      expect(() => store.saveProviderMetadata(metadata("sonnet", "/usr/local/bin/claude", "2.1.1"))).toThrow("refused");
      database.exec("DROP TRIGGER temp.refuse_metadata");
      expect(saved(store)).toEqual(["sonnet /usr/local/bin/claude 2.1.0"]);
    } finally {
      store.close();
    }
  });
});
