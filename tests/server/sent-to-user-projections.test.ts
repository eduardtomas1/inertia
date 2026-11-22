import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { searchMessages } from "../../src/server/persistence/message-search";
import { PrivateConnectRuntimeGateway } from "../../src/server/private-connect/runtime-gateway";
import { privateConnectStoreReads } from "../../src/server/private-connect/store-detail";
import { messageSearchResultSchema } from "../../src/shared/message-search-schema";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { privateConnectRuntimeGrantsFromProjectIds } from "../../src/shared/private-connect/runtime-grants";

const DRAFT = "## Release note\n\nExports keep UTF-8 in every locale.";
const fixtures: { directory: string; store: RuntimeStore }[] = [];

afterEach(() => {
  for (const { directory, store } of fixtures.splice(0)) {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function seeded() {
  const directory = mkdtempSync(join(tmpdir(), "inertia-sent-to-user-projection-"));
  const databasePath = join(directory, "inertia.sqlite");
  const store = new RuntimeStore(databasePath, directory, { recoverInterruptedRuns: false });
  fixtures.push({ directory, store });
  const project = store.createProject("Messages", directory);
  const modelSelection = providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" });
  const source = store.createConversation(project.id, "Release", { modelSelection });
  const target = store.createConversation(project.id, "Follow-up", { modelSelection });
  const { turn } = store.beginAgentTurn({
    conversationId: source.id,
    runId: "run-projection",
    content: "Draft the release note.",
    providerId: "codex",
    modelSelection,
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    configurationRevision: modelSelection.backendConfigurationRevision,
    association: "authoritative",
    requestedAt: "2030-03-01T10:00:00.000Z",
  });
  const notice = store.createMessage(source.id, "Provider reconnected.", "system", [], turn.id, "2030-03-01T10:00:02.000Z");
  const sent = store.sentToUser.create({
    conversationId: source.id, runId: turn.runId, turnId: turn.id, content: DRAFT, createdAt: "2030-03-01T10:00:05.000Z",
  });
  const answer = store.createMessage(source.id, "Should I publish it?", "assistant", [], turn.id, "2030-03-01T10:00:08.000Z");
  store.updateAgentTurnLifecycle(turn.id, {
    status: "completed",
    terminalAssistantMessageId: answer.id,
    startedAt: "2030-03-01T10:00:01.000Z",
    completedAt: "2030-03-01T10:00:09.000Z",
    updatedAt: "2030-03-01T10:00:09.000Z",
    terminalReason: "provider-completed",
  });
  return { store, databasePath, project, source, target, turn, notice, sent, answer };
}

describe("messages the agent showed mid-turn, outside the desktop chat", () => {
  it("reach shared context in full as the assistant's words, and can be shared on their own", () => {
    const { store, source, target, sent } = seeded();
    const transcript = store.contextPackets.sourceTranscript(source.id, target.id);
    expect(transcript.messages.map(({ role, content }) => [role, content])).toEqual([
      ["user", "Draft the release note."],
      ["assistant", DRAFT],
      ["assistant", "Should I publish it?"],
    ]);
    const selected = store.contextPackets.create({
      sourceConversationId: source.id, targetConversationId: target.id,
      sourceMessageIds: [sent.id], acknowledgedWorkspaceDifference: false,
    });
    expect(selected.excerpts).toEqual([expect.objectContaining({ sourceMessageId: sent.id, role: "assistant", content: DRAFT })]);
  });

  it("reach Private Connect as the assistant's text, while other system notices stay local", async () => {
    const { store, project, source, sent, answer } = seeded();
    const reads = privateConnectStoreReads(store);
    const gateway = new PrivateConnectRuntimeGateway({
      shell: () => store.shellSnapshot(),
      conversation: reads.conversation,
      detail: reads.detail,
      isConversationActive: () => false,
      preparePrompt: async () => undefined,
      queuePrompt: () => ({ turnId: "unused" }),
    });
    const response = await gateway.request({
      deviceId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      scopes: ["view"],
      projectIds: [project.id],
      grants: privateConnectRuntimeGrantsFromProjectIds([project.id]),
      grantVersion: 1,
      expiresAt: "2030-01-01T00:00:00.000Z",
    }, {
      type: "conversation.get", requestId: "33333333-3333-4333-8333-333333333333", conversationId: source.id,
    });
    if (!response.ok || response.result.kind !== "conversation") throw new Error("Expected a conversation detail.");
    expect(response.result.detail.messages.map(({ id, role, content }) => [id, role, content])).toEqual([
      [expect.any(String), "user", "Draft the release note."],
      [sent.id, "assistant", DRAFT],
      [answer.id, "assistant", "Should I publish it?"],
    ]);
  });

  it("are found by message search as the assistant's words and open at their turn", () => {
    const { store, databasePath, source, turn, sent, notice } = seeded();
    const database = new Database(databasePath, { readonly: true });
    try {
      const result = searchMessages(database, "every locale");
      expect(messageSearchResultSchema.safeParse(result).success).toBe(true);
      expect(result.hits).toEqual([expect.objectContaining({
        messageId: sent.id, conversationId: source.id, turnId: turn.id, role: "assistant",
      })]);
      expect(searchMessages(database, "Provider reconnected").hits).toEqual([]);
    } finally {
      database.close();
    }
    expect(store.messageSearchTarget(sent.id)).toMatchObject({ conversationId: source.id, turnId: turn.id, messageId: sent.id });
    expect(store.messageSearchTarget(notice.id)).toBeNull();
  });
});
