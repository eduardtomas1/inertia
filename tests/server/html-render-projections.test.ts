import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { PrivateConnectRuntimeGateway } from "../../src/server/private-connect/runtime-gateway";
import { privateConnectStoreReads } from "../../src/server/private-connect/store-detail";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { privateConnectRuntimeGrantsFromProjectIds } from "../../src/shared/private-connect/runtime-grants";

const PAGE = "<!doctype html><svg width=\"10\" height=\"10\"><text>secret layout</text></svg>";
const fixtures: { directory: string; store: RuntimeStore }[] = [];

afterEach(() => {
  for (const { directory, store } of fixtures.splice(0)) {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function seeded() {
  const directory = mkdtempSync(join(tmpdir(), "inertia-html-render-projection-"));
  const store = new RuntimeStore(join(directory, "inertia.sqlite"), directory, { recoverInterruptedRuns: false });
  fixtures.push({ directory, store });
  const project = store.createProject("Visual replies", directory);
  const modelSelection = providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" });
  const source = store.createConversation(project.id, "Charts", { modelSelection });
  const target = store.createConversation(project.id, "Follow-up", { modelSelection });
  const selectionTarget = store.createConversation(project.id, "Selected follow-up", { modelSelection });
  const { turn } = store.beginAgentTurn({
    conversationId: source.id,
    runId: "run-projection",
    content: "Chart revenue by quarter.",
    providerId: "codex",
    modelSelection,
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    configurationRevision: modelSelection.backendConfigurationRevision,
    association: "authoritative",
    requestedAt: "2030-03-01T10:00:00.000Z",
  });
  const { message: render } = store.htmlRenders.create({
    conversationId: source.id, runId: turn.runId, turnId: turn.id,
    title: "Revenue by quarter", html: PAGE, height: 320, createdAt: "2030-03-01T10:00:05.000Z",
  });
  const answer = store.createMessage(source.id, "Q3 carried the year.", "assistant", [], turn.id, "2030-03-01T10:00:08.000Z");
  return { store, project, source, target, selectionTarget, render, answer };
}

describe("visual replies outside the desktop chat", () => {
  it("reach shared context and continuation history as a one-line page note", () => {
    const { store, source, target, selectionTarget, render } = seeded();

    const transcript = store.contextPackets.sourceTranscript(source.id, target.id);
    expect(transcript.messages.map(({ role, content }) => [role, content])).toEqual([
      ["user", "Chart revenue by quarter."],
      ["assistant", "[page: Revenue by quarter]"],
      ["assistant", "Q3 carried the year."],
    ]);
    expect(transcript.messages[1]).toMatchObject({ sourceMessageId: render.id, truncated: false });

    const whole = store.contextPackets.create({
      sourceConversationId: source.id, targetConversationId: target.id, acknowledgedWorkspaceDifference: false,
    });
    expect(whole.excerpts.map(({ content }) => content)).toContain("[page: Revenue by quarter]");

    const selected = store.contextPackets.create({
      sourceConversationId: source.id, targetConversationId: selectionTarget.id,
      sourceMessageIds: [render.id], acknowledgedWorkspaceDifference: false,
    });
    expect(selected.excerpts).toEqual([expect.objectContaining({
      sourceMessageId: render.id, role: "assistant", content: "[page: Revenue by quarter]",
    })]);

    const history = store.continuationHistory(source.id, 64 * 1024, "2030-03-01T10:01:00.000Z");
    expect(history?.messageCount).toBe(3);
    expect(JSON.stringify(history)).toContain("[page: Revenue by quarter]");
    expect(JSON.stringify([transcript, whole, selected, history])).not.toContain("secret layout");
  });

  it("reach Private Connect as a one-line page note from the assistant", async () => {
    const { store, project, source, render, answer } = seeded();
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
      [expect.any(String), "user", "Chart revenue by quarter."],
      [render.id, "assistant", "[page: Revenue by quarter]"],
      [answer.id, "assistant", "Q3 carried the year."],
    ]);
    expect(JSON.stringify(response)).not.toContain("secret layout");
  });
});
