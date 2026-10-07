import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";

const fixtures: { directory: string; store: RuntimeStore }[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "inertia-subagent-revival-"));
  const store = new RuntimeStore(join(directory, "test.sqlite"), directory);
  fixtures.push({ directory, store });
  const project = store.createProject("Revival", directory);
  const conversation = store.createConversation(project.id, "Revival chat");
  return { store, conversation };
}
afterEach(() => {
  for (const { directory, store } of fixtures.splice(0)) { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

describe("delegated task revival", () => {
  it("revives a settled delegated task only when the provider starts a new turn on it", async () => {
    const { store, conversation } = fixture();
    const userMessage = store.createMessage(conversation.id, "Revive the delegated task.");
    const turn = store.createAgentTurn({
      id: "turn-subagent-revival",
      conversationId: conversation.id,
      runId: "run-subagent-revival",
      userMessageId: userMessage.id,
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "legacy:codex:codex-app-server",
      model: "gpt-test",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: 0,
      association: "authoritative",
    });
    const update = (sequence: number, patch: Partial<Parameters<typeof store.upsertSubagentTrace>[0]>) =>
      store.upsertSubagentTrace({
        conversationId: conversation.id,
        runId: turn.runId,
        turnId: turn.id,
        providerId: "codex",
        providerTaskId: null,
        providerAgentId: "child-revival",
        parentProviderAgentId: null,
        parentProviderToolUseId: null,
        providerToolUseId: null,
        providerRole: null,
        providerName: null,
        status: "running",
        isLive: true,
        description: null,
        progress: null,
        result: null,
        sequence,
        ...patch,
      });
    expect(update(1, {})?.trace).toMatchObject({ status: "running", isLive: true });
    expect(update(2, { status: "completed", isLive: false, result: "First answer" })?.trace)
      .toMatchObject({ status: "completed", isLive: false, result: "First answer" });
    expect(update(3, {})).toMatchObject({ changed: false, trace: { status: "completed", isLive: false } });
    expect(update(4, { revived: true })?.trace)
      .toMatchObject({ status: "running", isLive: true, result: null, sequence: 4 });
    expect(update(5, { revived: true, status: "completed", isLive: false, result: "Second answer" })?.trace)
      .toMatchObject({ status: "completed", isLive: false, result: "Second answer" });
  });
});
