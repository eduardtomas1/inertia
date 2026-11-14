// @inertia-test-suite portable
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import {
  ORCHESTRATOR_V2_DEVELOPMENT_DATABASE_MESSAGE,
  preMergeOrchestratorV2Database,
} from "../../src/server/persistence/orchestrator-v2-development-database";
import { CUSTOM_AGENTS_SCHEMA_VERSION } from "../../src/server/persistence/migrations/custom-agents";
import { ORCHESTRATION_V2_SCHEMA_VERSION } from "../../src/server/persistence/migrations/orchestration-v2";
import {
  RuntimeStartupBlockerError,
  runtimeStartupBlockerCode,
  runtimeStartupFailureMessage,
} from "../../src/shared/runtime-startup-diagnostics";
import { simulatePreMergeOrchestratorV2Database } from "../support/pre-merge-orchestrator-v2-database";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "inertia-pre-merge-v2-"));
  directories.push(path);
  return path;
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("orchestrator-v2 development database from before the 92e23166 main sync", () => {
  it("refuses to start with a typed blocker and leaves the database and its backups unchanged", () => {
    const root = directory();
    const path = join(root, "inertia.sqlite");
    const legacy = new Database(path);
    simulatePreMergeOrchestratorV2Database(legacy);
    expect(legacy.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()).toBe(118);
    legacy.close();
    const before = { files: readdirSync(root).sort(), database: digest(path) };

    let failure: unknown;
    try {
      new RuntimeStore(path, root).close();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RuntimeStartupBlockerError);
    expect((failure as Error).message).toBe(ORCHESTRATOR_V2_DEVELOPMENT_DATABASE_MESSAGE);
    expect(runtimeStartupBlockerCode(failure)).toBe("orchestrator-v2-development-database");
    expect(runtimeStartupFailureMessage("orchestrator-v2-development-database")).toBe(ORCHESTRATOR_V2_DEVELOPMENT_DATABASE_MESSAGE);
    expect({ files: readdirSync(root).sort(), database: digest(path) }).toEqual(before);
    const reopened = new Database(path, { readonly: true });
    try {
      expect(reopened.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()).toBe(118);
    } finally {
      reopened.close();
    }
  });

  it("leaves every released and merged numbering alone", () => {
    for (const version of [CUSTOM_AGENTS_SCHEMA_VERSION - 1, CUSTOM_AGENTS_SCHEMA_VERSION, ORCHESTRATION_V2_SCHEMA_VERSION, undefined]) {
      const database = new Database(":memory:");
      try {
        migrateRuntimeDatabase(database, version);
        expect(preMergeOrchestratorV2Database(database), String(version)).toBe(false);
      } finally {
        database.close();
      }
    }
    const root = directory();
    const store = new RuntimeStore(join(root, "inertia.sqlite"), root);
    store.close();
    expect(() => new RuntimeStore(join(root, "inertia.sqlite"), root).close()).not.toThrow();
  });
});
