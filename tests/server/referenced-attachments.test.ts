import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function attachment(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name: "reference.png",
    path: id,
    mimeType: "image/png",
    size: 8,
    ...overrides,
  };
}

function fullHistoryReferences(
  store: RuntimeStore,
  candidates: readonly string[],
): string[] {
  const referenced = new Set(store.attachments().map(({ id }) => id));
  return candidates.filter((id) => referenced.has(id)).sort();
}

describe("targeted attachment reference lookup", () => {
  it("matches the strict full-history projection for representative and adversarial rows", () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-attachment-references-"));
    directories.push(directory);
    const databasePath = join(directory, "inertia.sqlite");
    const store = new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
    });
    try {
      const project = store.createProject("References", directory);
      const deleted = store.createConversation(project.id, "Deleted");
      const retained = store.createConversation(project.id, "Retained");
      const id = (): string => randomUUID();
      const shared = id();
      const onlyDeleted = id();
      const malformedJson = id();
      const nonArray = id();
      const rejectedEntry = id();
      const lastDuplicateKey = id();
      const firstDuplicateKey = id();
      const escaped = id();
      const deeplyNested = id();
      const overCount = id();
      const overBytes = id();
      const nonIdMember = id();
      const differentCase = id();
      const bareString = id();
      const repeatedInRow = id();

      store.createMessage(deleted.id, "Deleted history", "user", [
        attachment(shared),
        attachment(onlyDeleted),
      ] as never);
      store.createMessage(retained.id, "Shared history", "user", [
        attachment(shared),
      ] as never);

      const escapedId = [...escaped]
        .map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
        .join("");
      const depth = 1_001;
      const rawRows = [
        `not-json ${malformedJson}`,
        JSON.stringify({ nested: attachment(nonArray) }),
        JSON.stringify([attachment(rejectedEntry, { mimeType: "application/zip" })]),
        `[{"id":"${id()}","id":"${lastDuplicateKey}","name":"reference.png","path":"${lastDuplicateKey}","mimeType":"image/png","size":8}]`,
        `[{"id":"${firstDuplicateKey}","id":"${id()}","name":"reference.png","path":"${firstDuplicateKey}","mimeType":"image/png","size":8}]`,
        JSON.stringify([attachment(escaped)]).replaceAll(escaped, escapedId),
        `${JSON.stringify([attachment(deeplyNested)]).slice(0, -2)},"extra":${"[".repeat(depth)}${"]".repeat(depth)}}]`,
        JSON.stringify([
          ...Array.from({ length: 8 }, () => attachment(id())),
          attachment(overCount),
        ]),
        JSON.stringify([
          ...Array.from({ length: 6 }, () => attachment(id(), { size: 3 * 1024 * 1024 })),
          attachment(overBytes, { size: 3 * 1024 * 1024 }),
        ]),
        JSON.stringify([attachment(id(), { note: nonIdMember })]),
        JSON.stringify([attachment(differentCase.toUpperCase())]),
        JSON.stringify([bareString]),
        JSON.stringify([attachment(repeatedInRow), attachment(repeatedInRow)]),
      ];
      const raw = new Database(databasePath);
      try {
        const insert = raw.prepare(`
          INSERT INTO messages (id, conversation_id, turn_id, role, content, attachments_json, created_at)
          VALUES (?, ?, NULL, 'user', 'raw', ?, ?)
        `);
        for (const [index, attachmentsJson] of rawRows.entries()) {
          insert.run(
            id(),
            retained.id,
            attachmentsJson,
            new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
          );
        }
        const validity = raw.prepare("SELECT json_valid(?) AS valid");
        expect(validity.get(rawRows[0])).toEqual({ valid: 0 });
        expect(validity.get(rawRows[6])).toEqual({ valid: 0 });
        expect(() => JSON.parse(rawRows[6]!)).not.toThrow();
      } finally {
        raw.close();
      }

      const candidates = [
        shared,
        onlyDeleted,
        malformedJson,
        nonArray,
        rejectedEntry,
        lastDuplicateKey,
        firstDuplicateKey,
        escaped,
        deeplyNested,
        overCount,
        overBytes,
        nonIdMember,
        differentCase,
        bareString,
        repeatedInRow,
        shared,
      ];
      const beforeDeletion = [...store.referencedAttachmentIds(candidates)].sort();
      expect(beforeDeletion).toEqual(fullHistoryReferences(store, [...new Set(candidates)]));
      expect(beforeDeletion).toContain(onlyDeleted);

      store.deleteConversation(deleted.id);
      const targeted = [...store.referencedAttachmentIds(candidates)].sort();
      expect(targeted).toEqual(fullHistoryReferences(store, [...new Set(candidates)]));
      expect(targeted).toEqual([
        shared,
        lastDuplicateKey,
        escaped,
        deeplyNested,
        repeatedInRow,
      ].sort());

      const prepare = vi.spyOn(Database.prototype, "prepare");
      expect(store.referencedAttachmentIds([])).toEqual(new Set());
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it("orders finished-chat files oldest first and protects all files in chats with non-terminal turns", () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-attachment-evictions-"));
    directories.push(directory);
    const store = new RuntimeStore(join(directory, "inertia.sqlite"), directory, {
      recoverInterruptedRuns: false,
    });
    try {
      const conversation = store.createConversation(
        store.createProject("Evictions", directory).id,
        "Evictions",
      );
      const [other, oldest, reused, untracked, followUp, queued] = Array.from(
        { length: 6 },
        () => randomUUID(),
      );
      const at = (second: number): string =>
        new Date(Date.UTC(2026, 8, 22, 8, 0, second)).toISOString();
      const archived = store.createConversation(conversation.projectId, "Finished archived chat");
      store.createMessage(archived.id, "Archived", "user", [
        attachment(other!), attachment(reused!),
      ] as never, null, at(0));
      store.archiveConversation(archived.id, true);
      const turn = (userMessageId: string, requestedAt: string) => store.createAgentTurn({
        conversationId: conversation.id,
        requestedAt,
        runId: randomUUID(),
        userMessageId,
        providerId: "codex",
        harnessId: "codex-app-server",
        backendProfileId: "codex-local",
        model: "gpt-test",
        reasoningEffort: "",
        interactionMode: "build",
        accessMode: "supervised",
        configurationRevision: 0,
        association: "authoritative",
      });
      const completedMessage = store.createMessage(conversation.id, "Old", "user", [
        attachment(oldest!), attachment(reused!),
      ] as never, null, at(1));
      const completed = turn(completedMessage.id, at(1));
      store.updateAgentTurnLifecycle(completed.id, { status: "completed", updatedAt: at(2) });
      store.createMessage(conversation.id, "Untracked", "user", [
        attachment(untracked!),
      ] as never, null, at(3));
      const runningMessage = store.createMessage(conversation.id, "Running", "user", [], null, at(4));
      const running = turn(runningMessage.id, at(4));
      store.updateAgentTurnLifecycle(running.id, { status: "running", updatedAt: at(5) });
      store.createAcknowledgedFollowUpMessage(conversation.id, running.id, "Steered", at(6), at(6), [
        attachment(followUp!), attachment(reused!),
      ] as never);
      const queuedMessage = store.createMessage(conversation.id, "Queued", "user", [
        attachment(queued!),
      ] as never, null, at(7));
      const queuedTurn = turn(queuedMessage.id, at(7));

      expect(store.evictableAttachmentIds()).toEqual([other]);

      store.updateAgentTurnLifecycle(running.id, { status: "interrupted", updatedAt: at(8) });
      expect(store.evictableAttachmentIds()).toEqual([other]);
      store.updateAgentTurnLifecycle(queuedTurn.id, { status: "interrupted", updatedAt: at(9) });
      expect(store.evictableAttachmentIds()).toEqual([other, reused, oldest, untracked, followUp, queued]);
    } finally {
      store.close();
    }
  });
});
