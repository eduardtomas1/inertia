import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { ConversationWorktreeRemovalError } from "../../src/server/persistence/conversation-worktree-repository";
import { publicRuntimeError } from "../../src/server/runtime-errors";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("runtime persistence failure injection", () => {
  it("surfaces owned-worktree project-removal guidance", () => {
    const guidance = "Delete each isolated chat and remove its retained worktree manually.";
    expect(publicRuntimeError(new ConversationWorktreeRemovalError(guidance)))
      .toBe(guidance);
  });

  it("surfaces SQLite busy safely without a partial mutation and remains usable after the lock clears", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-sqlite-busy-"));
    directories.push(directory);
    const workspace = join(directory, "workspace");
    const databasePath = join(directory, "inertia.sqlite");
    await mkdir(workspace);
    const store = new RuntimeStore(databasePath, workspace);
    const project = store.createProject("Before lock", workspace);
    const writer = new Database(databasePath);
    try {
      // Keep this deterministic and fast while exercising the same configured
      // SQLite connection used by RuntimeStore.
      const connection = (store as unknown as {
        database: Database.Database;
      }).database;
      connection.pragma("busy_timeout = 1");
      writer.pragma("busy_timeout = 1");
      writer.exec("BEGIN IMMEDIATE");

      let failure: unknown = null;
      try {
        store.updateProject(project.id, { name: "Must not persist" });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "SQLITE_BUSY" });
      expect(publicRuntimeError(failure)).toBe("The request could not be completed.");
      expect(store.project(project.id).name).toBe("Before lock");

      writer.exec("ROLLBACK");
      store.updateProject(project.id, { name: "After lock" });
      expect(store.project(project.id).name).toBe("After lock");
    } finally {
      if (writer.inTransaction) writer.exec("ROLLBACK");
      writer.close();
      store.close();
    }
  });
});
