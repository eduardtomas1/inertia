import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import { buildResponseTimeline } from "../../src/renderer/src/utils/responseTimeline";
import { removeTemporaryDirectory } from "../helpers/temporary-directory";
import { snapshotFixture } from "../helpers/snapshot-fixture";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await removeTemporaryDirectory(directory); });

it.each([69, 70])("upgrades schema%s and retains a compaction receipt across restart without making a turn", (schemaVersion) => {
  const root = mkdtempSync(join(tmpdir(), "inertia-compaction-receipt-")); directories.push(root);
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const path = join(root, "inertia.sqlite");
  const old = new Database(path); migrateRuntimeDatabase(old, schemaVersion);
  expect(old.prepare("PRAGMA table_info(messages)").all()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "compaction_json" })])); old.close();
  const store = new RuntimeStore(path, workspace, { recoverInterruptedRuns: false });
  const project = store.createProject("Compaction", workspace);
  const chat = store.createConversation(project.id, "Keep context");
  const receipt = store.createMessage(chat.id, "/compact remember the tests", "system", [], null, undefined, {
    compaction: { providerId: "claude", beforeTokens: 173000, afterTokens: 5690, instructionForwarded: true },
  });
  const captured = store.createMessage(chat.id, "Inspect the window", "user", [{
    id: "55555555-5555-4555-8555-555555555555", name: "snapshot.png", path: join(root, "snapshot.png"), mimeType: "image/png", size: 100, snapshot: snapshotFixture(),
  }]);
  store.close();
  const reopened = new RuntimeStore(path, workspace, { recoverInterruptedRuns: false });
  try {
    const persisted = reopened.message(receipt.id);
    expect(persisted).toEqual(receipt);
    expect(reopened.message(captured.id).attachments[0]?.snapshot).toEqual(snapshotFixture());
    const timeline = buildResponseTimeline({ turns: [], messages: [persisted], activities: [], reasonings: [], checkpoints: [] });
    expect(timeline).toEqual([{ kind: "compaction", id: receipt.id, message: receipt }]);
    expect(reopened.latestAgentTurnForConversation(chat.id)).toBeNull();
  } finally { reopened.close(); }
});

it("keeps a chat's place when a receipt is written without touching the conversation", () => {
  const root = mkdtempSync(join(tmpdir(), "inertia-compaction-silent-")); directories.push(root);
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const store = new RuntimeStore(join(root, "inertia.sqlite"), workspace, { recoverInterruptedRuns: false });
  try {
    const project = store.createProject("Compaction", workspace);
    const chat = store.createConversation(project.id, "Keep context");
    store.createMessage(chat.id, "Earlier work", "user", [], null, "2026-11-09T08:00:00.000Z");
    store.settleConversation(chat.id, true);
    const before = store.conversation(chat.id);
    const projectBefore = store.shellSnapshot().projects.find(({ id }) => id === project.id)?.updatedAt;
    const receipt = store.createMessage(chat.id, "/compact", "system", [], null, "2026-11-09T08:58:30.000Z", {
      compaction: { providerId: "claude", beforeTokens: 240000, afterTokens: 9000, instructionForwarded: false, trigger: "idle", sessionInstructionDigest: null },
      touchConversation: false,
    });
    expect(store.message(receipt.id)).toEqual(receipt);
    const after = store.conversation(chat.id);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.settledAt ?? null).toBe(before.settledAt ?? null);
    expect(after.lastViewedAt ?? null).toBe(before.lastViewedAt ?? null);
    expect(store.shellSnapshot().projects.find(({ id }) => id === project.id)?.updatedAt).toBe(projectBefore);
    store.createMessage(chat.id, "/compact", "system", [], null, "2026-11-09T09:30:00.000Z", {
      compaction: { providerId: "claude", beforeTokens: 9000, afterTokens: 8000, instructionForwarded: false, trigger: "manual", sessionInstructionDigest: null },
    });
    expect(store.conversation(chat.id).updatedAt).toBe("2026-11-09T09:30:00.000Z");
  } finally { store.close(); }
});
