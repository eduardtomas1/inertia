// @inertia-test-suite portable

import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { appUpdateCandidateViabilityRequest } from
  "../../src/node/app-update-candidate-viability-protocol";
import { RuntimeGenerationLeaseJournal } from
  "../../src/node/runtime-generation-leases";
import { validateAppUpdateCandidateViability } from
  "../../src/server/app-update-candidate-viability-worker";
import { migrateRuntimeDatabase, runtimeMigrationCatalog } from
  "../../src/server/persistence/migrations/runtime-catalog";
import {
  providerInstallationIdentity,
} from "../../src/server/provider/installation-lease";
import { ProviderMaintenanceJournal } from
  "../../src/server/provider/maintenance-journal";

const roots: string[] = [];
const operationId = "11111111-1111-4111-8111-111111111111";
const runtimeGenerationId = "22222222-2222-4222-8222-222222222222:1";
const systemBootId = "test:33333333-3333-4333-8333-333333333333";

async function dataRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "inertia-update-viability-"));
  roots.push(root);
  const data = join(root, "data");
  await mkdir(data, { mode: 0o700 });
  await chmod(data, 0o700);
  return data;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) =>
    await rm(root, { recursive: true, force: true })));
});

describe("app update candidate viability worker", () => {
  it("validates the native SQLite binding and complete migration catalog for a fresh profile", async () => {
    const dataDirectory = await dataRoot();

    expect(() => validateAppUpdateCandidateViability(
      appUpdateCandidateViabilityRequest({ operationId, dataDirectory }),
    )).not.toThrow();
  });

  it("treats an existing empty SQLite file as a fresh isolated clone", async () => {
    const dataDirectory = await dataRoot();
    const databasePath = join(dataDirectory, "inertia.sqlite");
    await writeFile(databasePath, "", { mode: 0o600 });

    expect(() => validateAppUpdateCandidateViability(
      appUpdateCandidateViabilityRequest({ operationId, dataDirectory }),
    )).not.toThrow();
    await expect(stat(databasePath).then(({ size }) => size)).resolves.toBe(0);
  });

  it("opens an existing database read-only and validates its exact migration lineage", async () => {
    const dataDirectory = await dataRoot();
    const database = new Database(join(dataDirectory, "inertia.sqlite"));
    migrateRuntimeDatabase(database);
    database.close();

    expect(() => validateAppUpdateCandidateViability(
      appUpdateCandidateViabilityRequest({ operationId, dataDirectory }),
    )).not.toThrow();
  });

  it("migrates an actual N-1 WAL snapshot without changing the live profile", async () => {
    const dataDirectory = await dataRoot();
    const databasePath = join(dataDirectory, "inertia.sqlite");
    const database = new Database(databasePath);
    database.pragma("journal_mode = WAL");
    database.pragma("wal_autocheckpoint = 0");
    const previousVersion = runtimeMigrationCatalog().length - 1;
    migrateRuntimeDatabase(database, previousVersion);
    database.exec(`
      CREATE TABLE app_update_clone_marker (
        value TEXT NOT NULL
      );
      INSERT INTO app_update_clone_marker (value) VALUES ('live-n-minus-one');
    `);

    expect(() => validateAppUpdateCandidateViability(
      appUpdateCandidateViabilityRequest({ operationId, dataDirectory }),
    )).not.toThrow();

    expect(database.prepare(
      "SELECT MAX(version) FROM schema_migrations",
    ).pluck().get()).toBe(previousVersion);
    expect(database.prepare(
      "SELECT value FROM app_update_clone_marker",
    ).pluck().get()).toBe("live-n-minus-one");
    expect(database.prepare(
      "SELECT 1 FROM pragma_table_info('agent_turns') WHERE name = 'continuation_reason_code'",
    ).get()).toBeUndefined();
    database.close();
  });

  it("rejects a failing N-1 migration while leaving live schema and data untouched", async () => {
    const dataDirectory = await dataRoot();
    const databasePath = join(dataDirectory, "inertia.sqlite");
    const database = new Database(databasePath);
    const previousVersion = runtimeMigrationCatalog().length - 1;
    migrateRuntimeDatabase(database, previousVersion);
    database.exec(`
      ALTER TABLE agent_turns RENAME TO agent_turns_live;
      CREATE VIEW agent_turns AS SELECT * FROM agent_turns_live;
      CREATE TABLE app_update_clone_marker (marker TEXT NOT NULL);
      INSERT INTO app_update_clone_marker (marker) VALUES ('live-only');
    `);
    database.close();

    expect(() => validateAppUpdateCandidateViability(
      appUpdateCandidateViabilityRequest({ operationId, dataDirectory }),
    )).toThrow("database-incompatible");

    const unchanged = new Database(databasePath, { readonly: true });
    expect(unchanged.prepare(
      "SELECT MAX(version) FROM schema_migrations",
    ).pluck().get()).toBe(previousVersion);
    expect(unchanged.prepare(
      "SELECT marker FROM app_update_clone_marker",
    ).pluck().get()).toBe("live-only");
    expect((unchanged.prepare(
      "PRAGMA table_info(agent_turns)",
    ).all() as Array<{ name: string }>).some(
      ({ name }) => name === "suspended_duration_ms",
    )).toBe(true);
    expect((unchanged.prepare(
      "PRAGMA table_info(agent_turns)",
    ).all() as Array<{ name: string }>).some(
      ({ name }) => name === "continuation_reason_code",
    )).toBe(false);
    unchanged.close();
  });

  it("rejects future database lineage without changing the live profile", async () => {
    const dataDirectory = await dataRoot();
    const databasePath = join(dataDirectory, "inertia.sqlite");
    const database = new Database(databasePath);
    database.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    database.prepare(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    ).run(99_999, new Date(0).toISOString());
    database.close();

    expect(() => validateAppUpdateCandidateViability(
      appUpdateCandidateViabilityRequest({ operationId, dataDirectory }),
    )).toThrow("database-incompatible");
    const unchanged = new Database(databasePath, { readonly: true });
    expect(unchanged.prepare(
      "SELECT version FROM schema_migrations",
    ).pluck().get()).toBe(99_999);
    unchanged.close();
  });

  it("fails closed on redirected recovery authority", async () => {
    const dataDirectory = await dataRoot();
    const target = join(dataDirectory, "outside.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(
      target,
      join(dataDirectory, `.runtime-generation-lease-${"a".repeat(64)}.json`),
    );

    expect(() => validateAppUpdateCandidateViability(
      appUpdateCandidateViabilityRequest({ operationId, dataDirectory }),
    )).toThrow("recovery-storage-invalid");
  });

  it("authenticates runtime and maintenance journals without mutating them", async () => {
    const dataDirectory = await dataRoot();
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).publish(
      runtimeGenerationId,
      systemBootId,
    )).toBe(true);
    const identity = providerInstallationIdentity({
      providerId: "claude",
      executable: "/tools/claude",
      installationRootIdentity: null,
      packageIdentity: "@anthropic-ai/claude-code",
      version: "1.0.0",
      environmentIdentity: "candidate-viability-test",
    });
    const maintenance = new ProviderMaintenanceJournal(dataDirectory, {
      runtimeGenerationId,
      systemBootId,
    });
    expect(maintenance.begin("candidate-maintenance", identity)).toBe(true);
    const names = (await readdir(dataDirectory)).filter((name) =>
      name.startsWith(".runtime-")
      || name.startsWith(".provider-maintenance-"));
    const before = await Promise.all(names.map(async (name) => ({
      name,
      bytes: await readFile(join(dataDirectory, name)),
    })));

    expect(() => validateAppUpdateCandidateViability(
      appUpdateCandidateViabilityRequest({ operationId, dataDirectory }),
    )).not.toThrow();
    await expect(Promise.all(before.map(async ({ name, bytes }) =>
      (await readFile(join(dataDirectory, name))).equals(bytes),
    ))).resolves.toEqual(before.map(() => true));

    const maintenanceName = names.find((name) =>
      name.startsWith(".provider-maintenance-"));
    expect(maintenanceName).toBeDefined();
    const damaged = JSON.parse((await readFile(
      join(dataDirectory, maintenanceName!),
      "utf8",
    ))) as Record<string, unknown>;
    damaged.fingerprint = "f".repeat(64);
    await writeFile(
      join(dataDirectory, maintenanceName!),
      JSON.stringify(damaged),
      { mode: 0o600 },
    );
    expect(() => validateAppUpdateCandidateViability(
      appUpdateCandidateViabilityRequest({ operationId, dataDirectory }),
    )).toThrow("recovery-storage-invalid");
  });

  it("rejects corrupt and incomplete runtime journals without repairing them", async () => {
    const dataDirectory = await dataRoot();
    const hash = createHash("sha256").update(runtimeGenerationId).digest("hex");
    const canonical = join(
      dataDirectory,
      `.runtime-generation-lease-${hash}.json`,
    );
    await writeFile(canonical, JSON.stringify({
      version: 2,
      runtimeGenerationId,
      systemBootId,
      createdAt: new Date(0).toISOString(),
    }), { mode: 0o600 });
    expect(() => validateAppUpdateCandidateViability(
      appUpdateCandidateViabilityRequest({ operationId, dataDirectory }),
    )).toThrow("recovery-storage-invalid");

    await rm(canonical);
    const transient = join(
      dataDirectory,
      `.runtime-generation-lease-${hash}.publish.tmp`,
    );
    await writeFile(transient, "{", { mode: 0o600 });
    expect(() => validateAppUpdateCandidateViability(
      appUpdateCandidateViabilityRequest({ operationId, dataDirectory }),
    )).toThrow("recovery-storage-invalid");
    await expect(readFile(transient, "utf8")).resolves.toBe("{");
  });

  it("leaves an incomplete maintenance publication for its recovery owner", async () => {
    const dataDirectory = await dataRoot();
    const identity = providerInstallationIdentity({
      providerId: "claude",
      executable: "/tools/claude",
      installationRootIdentity: null,
      packageIdentity: "@anthropic-ai/claude-code",
      version: "1.0.0",
      environmentIdentity: "candidate-viability-test",
    });
    const maintenance = new ProviderMaintenanceJournal(dataDirectory, {
      runtimeGenerationId,
      systemBootId,
      testHooks: {
        afterTemporaryFileClosed: () => {
          throw new Error("simulated interrupted publication");
        },
      },
    });
    expect(maintenance.begin("candidate-interrupted", identity)).toBe(false);
    const transientName = (await readdir(dataDirectory)).find((name) =>
      name.startsWith(".provider-maintenance-")
      && name.endsWith(".publish.tmp"));
    expect(transientName).toBeDefined();
    const before = await readFile(join(dataDirectory, transientName!));

    expect(() => validateAppUpdateCandidateViability(
      appUpdateCandidateViabilityRequest({ operationId, dataDirectory }),
    )).toThrow("recovery-storage-invalid");
    await expect(readFile(join(dataDirectory, transientName!))).resolves
      .toEqual(before);
  });
});
