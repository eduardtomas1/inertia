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
import { SENT_TO_USER_MESSAGES_SCHEMA_VERSION } from "../../src/server/persistence/migrations/sent-to-user-messages";
import { AGENT_THREAD_QUESTION_ANSWERS_SCHEMA_VERSION } from "../../src/server/persistence/migrations/agent-thread-question-answers";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import {
  RuntimeStartupBlockerError,
  runtimeStartupBlockerCode,
  runtimeStartupFailureMessage,
} from "../../src/shared/runtime-startup-diagnostics";
import { type PreMergeSync, simulatePreMergeOrchestratorV2Database } from "../support/pre-merge-orchestrator-v2-database";

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

describe("orchestrator-v2 development databases from before a main sync", () => {
  it.each([
    ["92e23166", 118],
    ["e37ff42b", 123],
  ] as const satisfies readonly (readonly [PreMergeSync, number])[])(
    "refuses a database from before the %s sync with a typed blocker and leaves it and its backups unchanged",
    (sync, latest) => {
      const root = directory();
      const path = join(root, "inertia.sqlite");
      const legacy = new Database(path);
      simulatePreMergeOrchestratorV2Database(legacy, sync);
      expect(legacy.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()).toBe(latest);
      // This build would treat the recorded numbers as main's migrations and skip them.
      expect(legacy.prepare("SELECT 1 FROM pragma_table_info('messages') WHERE name = 'sent_to_user'").get()).toBeUndefined();
      if (sync === "e37ff42b") {
        expect(legacy.prepare("SELECT 1 FROM sqlite_master WHERE name = 'custom_agents'").get()).toBeDefined();
        const operations = legacy.prepare("SELECT sql FROM sqlite_master WHERE name = 'agent_thread_operations'").pluck().get() as string;
        expect(operations).toContain("'inertia_delegate_task'");
        expect(operations).not.toContain("'inertia_answer_question'");
      }
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
        expect(reopened.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()).toBe(latest);
      } finally {
        reopened.close();
      }
    },
  );

  it("leaves every released and merged numbering alone", () => {
    for (const version of [
      CUSTOM_AGENTS_SCHEMA_VERSION - 1,
      CUSTOM_AGENTS_SCHEMA_VERSION,
      SENT_TO_USER_MESSAGES_SCHEMA_VERSION - 1,
      SENT_TO_USER_MESSAGES_SCHEMA_VERSION,
      AGENT_THREAD_QUESTION_ANSWERS_SCHEMA_VERSION,
      ORCHESTRATION_V2_SCHEMA_VERSION,
      CURRENT_DATABASE_SCHEMA_VERSION - 1,
      undefined,
    ]) {
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
