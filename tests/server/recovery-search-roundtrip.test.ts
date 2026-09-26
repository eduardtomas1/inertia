import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { parseDatabaseRecoveryExport } from "../../src/server/persistence/database-export";
import { searchMessages } from "../../src/server/persistence/message-search";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "inertia-recovered-search-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "inertia.sqlite");
  const store = new RuntimeStore(databasePath, directory);
  cleanup.push(() => store.close());
  const database = new Database(databasePath, { readonly: true });
  cleanup.push(() => { database.close(); });
  const root = join(directory, "recovered");
  await mkdir(root);
  return { directory, store, database, root, databasePath };
}

describe("recovery answer provenance", () => {
  it("preserves final-answer search and reveal across recovery, restart and re-export", async () => {
    const source = await fixture();
    const target = await fixture();
    const project = source.store.createProject("Recovery", source.directory);
    const conversation = source.store.createConversation(project.id, "Round trip");
    const user = source.store.createMessage(conversation.id, "user marker");
    const turn = source.store.createAgentTurn({
      conversationId: conversation.id, runId: randomUUID(), userMessageId: user.id,
      providerId: "codex", harnessId: "codex-app-server", backendProfileId: "native:codex:app-server",
      model: "test", reasoningEffort: "", interactionMode: "build", accessMode: "supervised",
      configurationRevision: 0, association: "authoritative",
    });
    const timestamp = "2026-09-26T00:00:00.000Z";
    source.store.createMessage(conversation.id, "hidden commentary marker", "assistant", [], turn.id, timestamp);
    const answer = source.store.createMessage(conversation.id, "final answer marker", "assistant", [], turn.id, timestamp);
    source.store.updateAgentTurnLifecycle(turn.id, {
      status: "completed", terminalAssistantMessageId: answer.id, terminalReason: "provider-completed",
    });
    expect(searchMessages(source.database, "final answer marker").hits).toHaveLength(1);
    const exported = source.store.exportRecoveryData();
    const parsed = parseDatabaseRecoveryExport(exported);
    expect(parsed.version).toBe(3);
    expect(parsed.projects[0]!.conversations[0]!.messages.filter((message) => message.finalAnswer))
      .toMatchObject([{ content: "final answer marker" }]);
    await target.store.importRecoveryData(exported, target.root);
    expect((await target.store.importRecoveryData(exported, target.root)).alreadyImported).toBe(true);
    expect(searchMessages(target.database, "user marker").hits).toHaveLength(1);
    expect(searchMessages(target.database, "hidden commentary marker").hits).toHaveLength(0);
    const hit = searchMessages(target.database, "final answer marker").hits[0]!;
    expect(hit).toBeDefined();
    expect(hit.turnId).toBeNull();
    expect(target.store.messageSearchTarget(hit.messageId)).toMatchObject({ messageId: hit.messageId });
    target.database.close();
    target.store.close();
    const reopened = new RuntimeStore(target.databasePath, target.directory);
    cleanup.push(() => reopened.close());
    const reader = new Database(target.databasePath, { readonly: true });
    cleanup.push(() => { reader.close(); });
    expect(searchMessages(reader, "final answer marker").hits).toHaveLength(1);
    const reexported = parseDatabaseRecoveryExport(reopened.exportRecoveryData());
    expect(reexported.projects[0]!.conversations[0]!.messages.filter((message) => message.finalAnswer))
      .toMatchObject([{ content: "final answer marker" }]);
  });

  it.each([1, 2])("retains v%s compatibility without inventing final-answer evidence", async (version) => {
    const target = await fixture();
    const exported = {
      format: "inertia-recovery-export", version, exportedAt: "2026-09-26T00:00:00.000Z",
      projects: [{ name: "Old export", path: target.directory, conversations: [{
        title: "Old chat", providerId: "codex", model: "", reasoningEffort: "",
        interactionMode: "build", accessMode: "supervised",
        messages: [{ role: "assistant", content: "unknown commentary", createdAt: "2026-09-26T00:00:00.000Z",
          ...(version === 2 ? { ordinal: 0 } : {}) }],
      }] }],
    };
    await target.store.importRecoveryData(JSON.stringify(exported), target.root);
    expect(searchMessages(target.database, "unknown commentary").hits).toHaveLength(0);
    expect(target.store.conversationDetail(target.store.shellSnapshot().conversations[0]!.id)?.messages)
      .toMatchObject([{ content: "unknown commentary" }]);
  });
});
