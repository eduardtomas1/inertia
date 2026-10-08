import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { ConversationContextTurnReads } from "../../src/server/persistence/conversation-context-turn-reads";
import type { ConversationRow } from "../../src/server/persistence/rows";
import type { Conversation } from "../../src/shared/contracts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inertia-context-turn-reads-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const databasePath = join(root, "inertia.sqlite");
  const store = new RuntimeStore(databasePath, workspace);
  const project = store.createProject("Billing", workspace);
  const begin = (conversation: Conversation, content: string, packetIds?: string[]) => store.beginAgentTurn({
    id: randomUUID(),
    conversationId: conversation.id,
    runId: randomUUID(),
    content,
    activateConversation: false,
    providerId: conversation.providerId,
    harnessId: conversation.modelSelection.harnessId,
    backendProfileId: conversation.modelSelection.backendProfileId,
    model: conversation.modelSelection.modelId,
    modelAlias: null,
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: null,
    usageAtStart: null,
    configurationRevision: conversation.modelSelection.backendConfigurationRevision,
    association: "authoritative",
    ...(packetIds ? { conversationContextPacketIds: packetIds, contextRequestId: randomUUID() } : {}),
  }).turn;
  const target = store.createConversation(project.id, "Current work", { activate: false });
  const source = store.createConversation(project.id, "Export fix", { activate: false });
  begin(source, "Fix the export.");
  const packet = store.contextPackets.create({
    sourceConversationId: source.id,
    targetConversationId: target.id,
    acknowledgedWorkspaceDifference: false,
  });
  const turn = begin(target, "Port the export fix.", [packet.id]);
  return { begin, databasePath, source, store, target, turn, workspace };
}

function readsWithPaths(databasePath: string, path: (conversationId: string) => string) {
  const database = new Database(databasePath, { readonly: true });
  return {
    database,
    reads: new ConversationContextTurnReads({
      database,
      conversationPath: path,
      requireConversation: (conversationId) => database.prepare(
        "SELECT * FROM conversations WHERE id = ?",
      ).get(conversationId) as ConversationRow,
    }),
  };
}

describe("ConversationContextTurnReads", () => {
  it("pre-authorises a reference only while its confirmed workspace relation still holds", async () => {
    const { databasePath, source, store, target, turn, workspace } = await fixture();
    try {
      const scope = {
        targetConversationId: target.id,
        targetTurnId: turn.id,
        targetUserMessageId: turn.userMessageId,
        sourceConversationId: source.id,
      };
      const unchanged = readsWithPaths(databasePath, () => workspace);
      const moved = readsWithPaths(databasePath, (id) => id === source.id ? join(workspace, "..", "elsewhere") : workspace);
      try {
        expect(unchanged.reads.access(scope)).toBe("referenced");
        expect(moved.reads.access(scope)).toBeNull();
        expect(unchanged.reads.access({ ...scope, sourceConversationId: target.id })).toBe("own");
      } finally {
        unchanged.database.close();
        moved.database.close();
      }
    } finally {
      store.close();
    }
  });

  it("bounds the records one turn read loads and says when later ones were left out", async () => {
    const { source, store } = await fixture();
    try {
      const turn = store.contextPackets.turnReads.turn(source.id, store.latestAgentTurnForConversation(source.id)!.id)!;
      const sourceTurn = store.agentTurn(turn.id);
      const add = (index: number) => store.addActivity({
        conversationId: source.id, runId: sourceTurn.runId, turnId: turn.id, kind: "tool",
        title: `Tool ${index}`, detail: null, status: "completed",
        createdAt: new Date(Date.parse("2030-01-01T00:00:00.000Z") + index).toISOString(),
      });
      for (let index = 0; index < 2_000; index += 1) add(index);
      expect(store.contextPackets.turnReads.entries(source.id, turn)).toMatchObject({ recordsOmitted: false });
      add(2_000);
      const read = store.contextPackets.turnReads.entries(source.id, turn);
      expect(read.recordsOmitted).toBe(true);
      expect(read.entries).toHaveLength(2_001);
      expect(read.entries.at(-1)).toMatchObject({ kind: "activity", title: "Tool 1999" });
    } finally {
      store.close();
    }
  });

  it("records each chat and turn once per turn and reports it with the target message", async () => {
    const { source, store, target, turn } = await fixture();
    try {
      const reads = store.contextPackets.turnReads;
      const sourceTurn = store.latestAgentTurnForConversation(source.id)!;
      const record = (sourceTurnId: string | null, now: string) => reads.recordRead({
        targetConversationId: target.id,
        targetTurnId: turn.id,
        targetUserMessageId: turn.userMessageId,
        sourceConversationId: source.id,
        sourceTurnId,
        access: "referenced",
        now,
      });
      expect(record(null, "2030-01-01T00:00:01.000Z")).toBe(true);
      expect(record(sourceTurn.id, "2030-01-01T00:00:02.000Z")).toBe(true);
      expect(record(sourceTurn.id, "2030-01-01T00:00:03.000Z")).toBe(false);

      const expected = {
        targetMessageId: turn.userMessageId,
        targetTurnId: turn.id,
        sourceConversationId: source.id,
        sourceConversationTitle: "Export fix",
        sourceState: "available",
        access: "referenced",
        listedTurns: true,
        turnIds: [sourceTurn.id],
        firstReadAt: "2030-01-01T00:00:01.000Z",
        lastReadAt: "2030-01-01T00:00:03.000Z",
      };
      expect(store.conversationDetail(target.id)?.contextReads).toEqual([expected]);

      store.deleteConversation(source.id);
      expect(store.conversationDetail(target.id)?.contextReads).toEqual([{ ...expected, sourceState: "deleted" }]);
      store.deleteConversation(target.id);
      expect(store.conversationDetail(target.id)).toBeNull();
    } finally {
      store.close();
    }
  });
});
