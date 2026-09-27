import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeStore } from "../../../src/server/database";
import { privateConnectStoreReads } from "../../../src/server/private-connect/store-detail";
import { PRIVATE_CONNECT_RUNTIME_LIMITS } from "../../../src/shared/private-connect/runtime-contract";
import {
  PRIVATE_CONNECT_INSPECTION_CHARACTERS,
  sanitizePrivateConnectContent,
} from "../../../src/shared/private-connect/sanitizer";

const fixtures: { directory: string; store: RuntimeStore }[] = [];
afterEach(() => {
  for (const { directory, store } of fixtures.splice(0)) {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "inertia-private-connect-detail-"));
  const store = new RuntimeStore(join(directory, "inertia.sqlite"), directory);
  fixtures.push({ directory, store });
  const project = store.createProject("Mobile", directory);
  return { store, conversation: store.createConversation(project.id, "Mobile chat") };
}

describe("Private Connect bounded store projection", () => {
  it("keeps the newest 200 transcript messages beyond one desktop history page with bounded content", () => {
    const { store, conversation } = fixture();
    const long = `${"Visible answer. ".repeat(6_000)}`;
    for (let index = 0; index < 130; index++) {
      const at = new Date(Date.UTC(2030, 0, 1, 0, 0, index)).toISOString();
      const { turn } = store.beginAgentTurn({ id: `turn-${index}`, runId: `run-${index}`, conversationId: conversation.id,
        content: `Request ${index}`, providerId: "codex", harnessId: "codex-app-server",
        backendProfileId: "native:codex:app-server", model: "gpt-test", reasoningEffort: "high",
        interactionMode: "build", accessMode: "supervised", configurationRevision: 1,
        association: "authoritative", requestedAt: at });
      store.createMessage(conversation.id, index === 129 ? long : `Answer ${index}`, "assistant", [], turn.id, at);
      store.createMessage(conversation.id, `System ${index}`, "system", [], turn.id, at);
      for (let activity = 0; activity < 2; activity++) {
        store.addActivity({ conversationId: conversation.id, runId: turn.runId, turnId: turn.id, kind: "command",
          title: `Command ${index}.${activity}`, detail: "output ".repeat(1_000), status: "completed", createdAt: at });
      }
      store.upsertSubagentTrace({ conversationId: conversation.id, runId: turn.runId, turnId: turn.id,
        providerId: "codex", providerTaskId: `task-${index}`, providerAgentId: `agent-${index}`,
        parentProviderAgentId: null, parentProviderToolUseId: null, providerToolUseId: `tool-${index}`,
        providerRole: "reviewer", providerName: `Reviewer ${index}`, providerStatus: "completed", status: "completed",
        isLive: false, description: "Private description", progress: "Private progress", result: "Private result",
        sequence: index, updatedAt: at });
      store.upsertAgentPlan({ conversationId: conversation.id, runId: turn.runId, turnId: turn.id,
        explanation: `Plan ${index}`, steps: [] });
    }
    const full = store.conversationDetail(conversation.id)!;
    const detail = privateConnectStoreReads(store).detail(conversation.id)!;

    expect(store.conversationHistory(conversation.id)!.agentTurns).toHaveLength(40);
    expect(detail.conversation).toEqual(full.conversation);
    expect(detail.messages).toHaveLength(PRIVATE_CONNECT_RUNTIME_LIMITS.transcriptMessages);
    expect(detail.messages).toEqual(full.messages
      .filter(({ role }) => role === "user" || role === "assistant")
      .slice(-PRIVATE_CONNECT_RUNTIME_LIMITS.transcriptMessages)
      .map((message) => ({ ...message, content: message.content.slice(0, PRIVATE_CONNECT_INSPECTION_CHARACTERS) })));
    expect(long.length).toBeGreaterThan(PRIVATE_CONNECT_INSPECTION_CHARACTERS);
    const bounded = detail.messages.find(({ content }) => content.startsWith("Visible answer."))!;
    expect(bounded.content).toHaveLength(PRIVATE_CONNECT_INSPECTION_CHARACTERS);
    expect(sanitizePrivateConnectContent(bounded.content)).toBe(sanitizePrivateConnectContent(long));
    expect(detail.activities).toEqual(full.activities
      .slice(-PRIVATE_CONNECT_RUNTIME_LIMITS.activities).map((activity) => ({ ...activity, detail: null })));
    expect(detail.subagents).toEqual(full.subagents.slice(-PRIVATE_CONNECT_RUNTIME_LIMITS.subagents)
      .map((subagent) => ({ ...subagent, description: null, progress: null, result: null })));
    expect(detail.plans).toEqual([full.plans.at(-1)]);
    expect([detail.reasonings, detail.checkpoints, detail.usage, detail.reviewNotes, detail.contextPackets])
      .toEqual([[], [], [], [], []]);
  });

  it("authorizes actions from the conversation row and preserves missing conversations", () => {
    const { store, conversation } = fixture();
    const reads = privateConnectStoreReads(store);
    expect(reads.conversation(conversation.id)).toMatchObject({ id: conversation.id, projectId: conversation.projectId });
    expect(reads.conversation("missing")).toBeNull();
    expect(reads.detail("missing")).toBeNull();
  });
});
