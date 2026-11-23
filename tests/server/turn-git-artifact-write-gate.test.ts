import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import type { DatabaseWriteRunner } from "../../src/server/runtime/database-write-gate";
import { TurnGitArtifactManager } from "../../src/server/turn-git-artifacts";

const roots: string[] = [];
const stores: RuntimeStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function heldGate(): { gate: DatabaseWriteRunner; release: () => void; admitted: () => number } {
  let release!: () => void;
  const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
  let admitted = 0;
  return {
    gate: {
      run: async <T>(operation: () => Promise<T>): Promise<T> => {
        admitted += 1;
        await held;
        return await operation();
      },
    },
    release,
    admitted: () => admitted,
  };
}

async function pending(promise: Promise<unknown>): Promise<boolean> {
  return await Promise.race([
    promise.then(() => false, () => false),
    new Promise<boolean>((resolvePending) => setTimeout(() => resolvePending(true), 30)),
  ]);
}

describe("turn Git artifact database writes", () => {
  it("defers checkpoint pruning and reconciliation behind the database write gate", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-artifact-write-gate-"));
    roots.push(root);
    const data = join(root, "data");
    mkdirSync(data);
    const store = new RuntimeStore(join(data, "inertia.sqlite"), root, { recoverInterruptedRuns: false });
    stores.push(store);
    const writes = heldGate();
    const manager = new TurnGitArtifactManager(store, data, undefined, { databaseWrites: writes.gate });

    const pruning = manager.prune();
    const reconciling = manager.reconcile();

    expect(await pending(pruning)).toBe(true);
    expect(await pending(reconciling)).toBe(true);
    expect(writes.admitted()).toBe(2);

    writes.release();
    await pruning;
    await expect(reconciling).resolves.toBe(false);
  });
});
