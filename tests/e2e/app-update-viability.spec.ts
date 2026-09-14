// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { appUpdateCandidateViabilityRequest } from "../../src/node/app-update-candidate-viability-protocol";
import { createAppUpdateScratch } from "../../src/node/app-update-validation-scratch";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import { createAppFixture } from "./support/app-fixture";

test("the real update validator decodes Electron message envelopes and acknowledges its result", async () => {
  const fixture = await createAppFixture({ name: "update-viability-transport", initialState: "empty" });
  try {
    const data = join(fixture.testDirectory, "candidate-data");
    await mkdir(data, { mode: 0o700 });
    const request = appUpdateCandidateViabilityRequest({ operationId: randomUUID(),
      dataDirectory: await realpath(data), expectedActiveRuntimeOwner: null });
    for (const exact of [true, false]) {
      const result = await fixture.electronApp.evaluate(async ({ utilityProcess }, input) => {
        const child = utilityProcess.fork(input.worker, [], { env: {}, stdio: "ignore" });
        return await new Promise<{ event: unknown; code: number; acknowledged: boolean }>((resolveProbe, reject) => {
          let event: unknown;
          let acknowledged = false;
          const timeout = setTimeout(() => { child.kill(); reject(new Error("Update validator transport timed out.")); }, 5_000);
          child.once("error", (error) => { clearTimeout(timeout); child.kill(); reject(error); });
          child.once("spawn", () => child.postMessage(input.request));
          child.once("message", (value) => {
            event = value;
            acknowledged = true;
            child.postMessage({ schemaVersion: input.request.schemaVersion, type: "result-ack",
              operationId: input.exact ? input.request.operationId : "00000000-0000-4000-8000-000000000000" });
          });
          child.once("exit", (code) => {
            clearTimeout(timeout);
            resolveProbe({ event, code, acknowledged });
          });
        });
      }, { worker: resolve("out/main/app-update-candidate-viability-worker.js"), request, exact });
      expect(result.event).toEqual({ schemaVersion: request.schemaVersion, operationId: request.operationId,
        status: "validated", code: null });
      expect(result.acknowledged).toBe(true);
      expect(result.code).toBe(exact ? 0 : 1);
    }
  } finally { await fixture.close(); }
});

test("the real update validator rehearses a large WAL profile in private storage and exits before cleanup", async () => {
  const fixture = await createAppFixture({ name: "update-viability-large", initialState: "empty" });
  const operationId = randomUUID();
  const scratch = createAppUpdateScratch(operationId);
  let database: Database.Database | null = null;
  try {
    const data = join(fixture.testDirectory, "candidate-data");
    await mkdir(data, { mode: 0o700 });
    database = new Database(join(data, "inertia.sqlite"));
    database.pragma("journal_mode = WAL");
    database.pragma("wal_autocheckpoint = 0");
    database.pragma("cache_size = -2048");
    migrateRuntimeDatabase(database, 74);
    database.exec(`CREATE TABLE large_fixture(payload BLOB NOT NULL);
      WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < 257)
      INSERT INTO large_fixture SELECT zeroblob(1048576) FROM rows;`);
    const request = appUpdateCandidateViabilityRequest({
      operationId, dataDirectory: await realpath(data), scratch: scratch.identity,
    });
    const result = await fixture.electronApp.evaluate(async ({ utilityProcess }, input) => {
      const child = utilityProcess.fork(input.worker, [], { env: {}, stdio: "ignore" });
      return await new Promise<{ event: unknown; code: number }>((resolveProbe, reject) => {
        let event: unknown;
        const timeout = setTimeout(() => { child.kill(); reject(new Error("Large profile validation timed out.")); }, 30_000);
        child.once("error", (error) => { clearTimeout(timeout); child.kill(); reject(error); });
        child.once("spawn", () => child.postMessage(input.request));
        child.once("message", (value) => {
          event = value;
          child.postMessage({ schemaVersion: input.request.schemaVersion, type: "result-ack",
            operationId: input.request.operationId });
        });
        child.once("exit", (code) => { clearTimeout(timeout); resolveProbe({ event, code }); });
      });
    }, { worker: resolve("out/main/app-update-candidate-viability-worker.js"), request });
    expect(result).toEqual({ code: 0, event: {
      schemaVersion: request.schemaVersion, operationId, status: "validated", code: null,
    } });
    expect(database.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()).toBe(74);
    expect(database.prepare("SELECT COUNT(*) FROM large_fixture").pluck().get()).toBe(257);
    const clone = new Database(join(scratch.identity.directory, "candidate.sqlite"), { readonly: true });
    try {
      expect(clone.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()).toBe(CURRENT_DATABASE_SCHEMA_VERSION);
      expect(clone.prepare("SELECT COUNT(*) FROM large_fixture").pluck().get()).toBe(257);
    } finally { clone.close(); }
    scratch.remove();
    await expect(stat(scratch.identity.directory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    database?.close();
    await fixture.close();
    scratch.remove();
  }
});
