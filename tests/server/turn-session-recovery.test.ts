import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import { turnSessionRecoveryMigration } from "../../src/server/persistence/migrations/turn-session-recovery";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { isTurnSessionRecovery } from "../../src/shared/continuation-policy";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<{ directory: string; workspacePath: string; databasePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-session-recovery-"));
  directories.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  return { directory, workspacePath, databasePath: join(directory, "inertia.sqlite") };
}

describe("turn session recovery persistence", () => {
  it("adds a nullable bounded column once and leaves existing turns unrecovered", async () => {
    const { databasePath } = await workspace();
    const database = new Database(databasePath);
    try {
      migrateRuntimeDatabase(database, CURRENT_DATABASE_SCHEMA_VERSION - 1);
      const columns = () => (database.prepare("PRAGMA table_info(agent_turns)").all() as Array<{ name: string }>)
        .map(({ name }) => name);
      expect(columns()).not.toContain("session_recovery_json");
      migrateRuntimeDatabase(database);
      expect(columns().filter((name) => name === "session_recovery_json")).toHaveLength(1);
      if (typeof turnSessionRecoveryMigration.up === "function") {
        turnSessionRecoveryMigration.up(database, {
          sourceSchemaVersion: CURRENT_DATABASE_SCHEMA_VERSION,
          sourceReleases: [],
          setLegacyBackfillDiagnostics: () => undefined,
        });
      }
      expect(columns().filter((name) => name === "session_recovery_json")).toHaveLength(1);
      expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
        .toEqual({ version: CURRENT_DATABASE_SCHEMA_VERSION });
    } finally {
      database.close();
    }
  });

  it("round-trips recovery counts and tolerates a malformed stored value", async () => {
    const { workspacePath, databasePath } = await workspace();
    const store = new RuntimeStore(databasePath, workspacePath, { recoverInterruptedRuns: false });
    const project = store.createProject("Recovery", workspacePath);
    const conversation = store.createConversation(project.id, "Recovered", {
      modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" }),
    });
    const begin = (content: string, sessionRecovery?: unknown) => store.beginAgentTurn({
      conversationId: conversation.id,
      runId: `run-${content}`,
      content,
      providerId: "codex",
      modelSelection: conversation.modelSelection,
      reasoningEffort: "",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: conversation.modelSelection.backendConfigurationRevision,
      association: "authoritative",
      ...(sessionRecovery === undefined ? {} : { sessionRecovery: sessionRecovery as never }),
    });
    const plain = begin("plain");
    const recovered = begin("recovered", { restoredMessageCount: 113, omittedMessageCount: 20 });
    expect(plain.turn.sessionRecovery).toBeNull();
    expect(store.agentTurn(recovered.turn.id).sessionRecovery)
      .toEqual({ restoredMessageCount: 113, omittedMessageCount: 20 });
    expect(() => begin("invalid", { restoredMessageCount: -1, omittedMessageCount: 0 }))
      .toThrow("The turn session recovery is invalid.");
    expect(() => begin("extra", { restoredMessageCount: 1, omittedMessageCount: 0, transcript: "x" }))
      .toThrow("The turn session recovery is invalid.");
    store.close();

    const database = new Database(databasePath);
    try {
      database.prepare("UPDATE agent_turns SET session_recovery_json = ? WHERE id = ?")
        .run("{not json", recovered.turn.id);
      database.prepare("UPDATE agent_turns SET session_recovery_json = ? WHERE id = ?")
        .run(JSON.stringify({ restoredMessageCount: "many" }), plain.turn.id);
      expect(() => database.prepare("UPDATE agent_turns SET session_recovery_json = ? WHERE id = ?")
        .run(JSON.stringify({ padding: "x".repeat(300) }), plain.turn.id)).toThrow(/CHECK constraint/u);
    } finally {
      database.close();
    }
    const reopened = new RuntimeStore(databasePath, workspacePath, { recoverInterruptedRuns: false });
    try {
      expect(reopened.agentTurn(recovered.turn.id).sessionRecovery).toBeNull();
      expect(reopened.agentTurn(plain.turn.id).sessionRecovery).toBeNull();
    } finally {
      reopened.close();
    }
  });

  it("validates recovery counts as a closed two-field record", () => {
    expect(isTurnSessionRecovery({ restoredMessageCount: 0, omittedMessageCount: 0 })).toBe(true);
    expect(isTurnSessionRecovery({ restoredMessageCount: 2_000, omittedMessageCount: 1_000_000 })).toBe(true);
    expect(isTurnSessionRecovery(null)).toBe(false);
    expect(isTurnSessionRecovery([0, 0])).toBe(false);
    expect(isTurnSessionRecovery({ restoredMessageCount: 1 })).toBe(false);
    expect(isTurnSessionRecovery({ restoredMessageCount: 1, omittedMessageCount: Number.NaN })).toBe(false);
  });
});
