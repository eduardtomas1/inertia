// @inertia-test-suite portable

import { mkdtempSync, rmSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { appUpdateCandidateViabilityRequest } from
  "../../src/node/app-update-candidate-viability-protocol";
import { createAppUpdateScratch } from "../../src/node/app-update-validation-scratch";
import {
  candidateDatabaseError,
  diskAppUpdateDatabaseClone,
} from "../../src/server/app-update-database-clone";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, statfsSync: vi.fn(fs.statfsSync) };
});

const operationId = "11111111-1111-4111-8111-111111111111";
afterEach(() => { vi.mocked(statfsSync).mockReset(); });

describe("private disk update rehearsal", () => {
  it("backs up the held WAL snapshot while a later commit remains outside that snapshot", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-update-clone-test-"));
    const scratch = createAppUpdateScratch(operationId);
    const path = join(root, "live.sqlite");
    const writer = new Database(path);
    let reader: Database.Database | null = null;
    let clone: Database.Database | null = null;
    try {
      writer.pragma("journal_mode = WAL");
      writer.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('snapshot');");
      reader = new Database(path, { readonly: true });
      reader.pragma("query_only = ON");
      reader.exec("BEGIN");
      expect(reader.prepare("SELECT COUNT(*) FROM marker").pluck().get()).toBe(1);
      const pageCount = reader.pragma("page_count", { simple: true }) as number;
      const pageSize = reader.pragma("page_size", { simple: true }) as number;
      const backup = diskAppUpdateDatabaseClone(reader, appUpdateCandidateViabilityRequest({
        operationId, dataDirectory: root, scratch: scratch.identity,
      }), pageCount * pageSize);
      writer.exec("INSERT INTO marker VALUES ('later');");
      clone = await backup;
      expect(clone.prepare("SELECT value FROM marker").pluck().all()).toEqual(["snapshot"]);
      expect(writer.prepare("SELECT value FROM marker").pluck().all()).toEqual(["snapshot", "later"]);
      expect(clone.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      clone?.close();
      reader?.close();
      writer.close();
      scratch.remove();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a resource limit before backup when storage or the disk budget is insufficient", async () => {
    const scratch = createAppUpdateScratch(operationId);
    const database = new Database(":memory:");
    const backup = vi.spyOn(database, "backup");
    const request = appUpdateCandidateViabilityRequest({
      operationId, dataDirectory: tmpdir(), scratch: scratch.identity,
    });
    try {
      vi.mocked(statfsSync).mockReturnValueOnce({
        type: 1n, bsize: 4096n, blocks: 0n, bfree: 0n, bavail: 0n, files: 0n, ffree: 0n,
      });
      await expect(diskAppUpdateDatabaseClone(database, request, 257 * 1024 * 1024))
        .rejects.toMatchObject({ code: "validation-resource-limit" });
      await expect(diskAppUpdateDatabaseClone(database, request, 4 * 1024 * 1024 * 1024 + 1))
        .rejects.toMatchObject({ code: "validation-resource-limit" });
      expect(backup).not.toHaveBeenCalled();
    } finally {
      database.close();
      scratch.remove();
    }
  });

  it("distinguishes exhausted storage in a wrapped migration failure from invalid schema", () => {
    expect(candidateDatabaseError(new Error("migration failed", {
      cause: Object.assign(new Error("full"), { code: "SQLITE_FULL" }),
    })).code).toBe("validation-resource-limit");
    expect(candidateDatabaseError(Object.assign(new Error("invalid"), {
      code: "SQLITE_CORRUPT",
    })).code).toBe("database-incompatible");
  });
});
