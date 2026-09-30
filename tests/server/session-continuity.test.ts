import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeStore } from "../../src/server/database";
import { RESTORED_CHAT_HISTORY_LABEL } from "../../src/server/persistence/conversation-context-transport";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { MAX_CONVERSATION_CONTEXT_BLOCK_BYTES, MAX_CONVERSATION_CONTEXT_TURN_BYTES } from "../../src/shared/conversation-context";
import { resolveTurnRequest } from "../../src/server/runtime/turns/turn-request-preparation";
import type { QueueTurnRequest, TurnProviderRuntime } from "../../src/server/runtime/turns/turn-controller-types";
import { resolveNativeModelRoute } from "./model-route-fixture";

const providers = ["codex", "claude", "cursor", "kimi", "opencode", "antigravity"] as const;
const capturedAt = "2030-01-01T00:01:00.000Z";
const stores: RuntimeStore[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(providerId: (typeof providers)[number] = "claude") {
  const directory = await mkdtemp(join(tmpdir(), "inertia-session-continuity-"));
  directories.push(directory);
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const openStore = () => {
    const result = new RuntimeStore(join(directory, "runtime.sqlite"), workspace, { recoverInterruptedRuns: false });
    stores.push(result);
    return result;
  };
  const store = openStore();
  const project = store.createProject("Continuity", workspace);
  const selection = providerNativeModelSelection({ providerId, modelId: "provider-default" });
  const conversation = store.createConversation(project.id, "Existing work", { modelSelection: selection });
  const route = resolveNativeModelRoute(selection);
  store.createMessage(conversation.id, "The export must preserve accented names.", "user", [], null, "2030-01-01T00:00:00.000Z");
  const answer = store.createMessage(conversation.id, "I will use UTF-8", "assistant", [], null, "2030-01-01T00:00:01.000Z");
  store.appendMessageContent(answer.id, " and verify café.");
  const other = store.createConversation(project.id, "Unrelated", { modelSelection: selection });
  store.createMessage(other.id, "OTHER_CHAT_PRIVATE_SENTINEL");
  const previous = { ...route.continuationIdentity, providerCompatibilityToken: "b".repeat(64) };
  let sequence = 0;
  const resolve = (activeStore = store, request: Partial<QueueTurnRequest> = {}) => resolveTurnRequest({
    store: activeStore,
    providers: {
      resolveModelRoute: () => route,
      harnessIdFor: () => route.harnessId,
    } as unknown as TurnProviderRuntime,
    hooks: { broadcast: () => undefined, broadcastSnapshot: () => undefined, providerInfo: () => [] },
    id: () => `continuity-${++sequence}`,
    now: () => capturedAt,
    clock: () => new Date(capturedAt),
  }, { conversationId: conversation.id, content: "Continue the export.", ...request });
  const history = (capacityBytes = MAX_CONVERSATION_CONTEXT_TURN_BYTES, excludedMessageId?: string) =>
    store.continuationHistory(conversation.id, capacityBytes, capturedAt, excludedMessageId);
  const restoredReferences = (turnId: string) => store.turnExecutionManifest(turnId)?.references
    .filter(({ label }) => label.startsWith(RESTORED_CHAT_HISTORY_LABEL)) ?? [];
  return { store, conversation, route, previous, resolve, openStore, history, restoredReferences };
}

describe("provider session continuity", () => {
  it.each(providers)("resumes the saved %s session after its installation changes", async (providerId) => {
    const f = await fixture(providerId);
    f.store.updateConversation(f.conversation.id, { providerSessionId: "before-update", continuationIdentity: f.previous });
    const resolved = f.resolve();
    const queued = f.store.beginAgentTurn(resolved.input);
    const active = resolved.adopt(queued).active;
    expect(active.providerInput.sessionId).toBe("before-update");
    expect(active.providerInput.prompt).not.toContain("The export must preserve accented names.");
    expect(queued.turn).toMatchObject({
      continuationReasonCode: "same-continuation",
      providerSessionBefore: "before-update",
      sessionRecovery: null,
    });
    expect(f.store.conversation(f.conversation.id).providerSessionId).toBe("before-update");
    expect(f.restoredReferences(queued.turn.id)).toEqual([]);
  });

  it("resumes a native session whose installation identity was never verified", async () => {
    const f = await fixture();
    const { providerCompatibilityToken: _omitted, ...unverified } = f.previous;
    f.store.updateConversation(f.conversation.id, { providerSessionId: "before-update", continuationIdentity: unverified });
    const resolved = f.resolve();
    const active = resolved.adopt(f.store.beginAgentTurn(resolved.input)).active;
    expect(active.providerInput.sessionId).toBe("before-update");
  });

  it.each(providers)("restores earlier messages when a %s chat has to start a fresh session", async (providerId) => {
    const f = await fixture(providerId);
    f.store.updateConversation(f.conversation.id, { providerSessionId: "before-update", continuationIdentity: f.previous });
    const first = f.resolve();
    const earlier = f.store.beginAgentTurn(first.input);
    first.adopt(earlier);
    f.store.settleAgentTurn(earlier.turn.id, {
      status: "failed", terminalReason: "provider-error",
      startedAt: earlier.turn.requestedAt, completedAt: earlier.turn.requestedAt,
      updatedAt: earlier.turn.requestedAt,
    });
    f.store.updateConversation(f.conversation.id, { providerSessionId: null, continuationIdentity: null });

    const resolved = f.resolve(f.store, { content: "Try the export again." });
    const queued = f.store.beginAgentTurn(resolved.input);
    const input = resolved.adopt(queued).active.providerInput;
    expect(input.sessionId).toBeUndefined();
    expect(input.prompt).toContain("The export must preserve accented names.");
    expect(input.prompt).toContain("I will use UTF-8 and verify café.");
    expect(input.prompt).toContain("Continue the export.");
    expect(input.prompt).toContain("restored automatically");
    expect(input.prompt).not.toContain("OTHER_CHAT_PRIVATE_SENTINEL");
    expect(queued.turn).toMatchObject({
      continuationReasonCode: "missing-continuation-identity",
      sessionRecovery: { restoredMessageCount: 3, omittedMessageCount: 0 },
    });
    expect(f.restoredReferences(queued.turn.id)).toEqual([expect.objectContaining({
      kind: "attachment",
      label: `${RESTORED_CHAT_HISTORY_LABEL} · 3 messages`,
      truncated: false,
    })]);
    expect(queued.message.content).toBe("Try the export again.");
  });

  it.each(["backend", "endpoint"] as const)("restores earlier messages when the %s changes under an established chat", async (boundary) => {
    const f = await fixture();
    const previous: typeof f.route.continuationIdentity = { ...f.previous };
    if (boundary === "backend") previous.backendConfigurationRevision += 1;
    if (boundary === "endpoint") previous.endpointIdentity = "different-account-endpoint";
    f.store.updateConversation(f.conversation.id, { providerSessionId: "before-update", continuationIdentity: previous });
    const resolved = f.resolve();
    const queued = f.store.beginAgentTurn(resolved.input);
    const input = resolved.adopt(queued).active.providerInput;
    expect(input.sessionId).toBeUndefined();
    expect(input.prompt).toContain("The export must preserve accented names.");
    expect(queued.turn.continuationReasonCode).toBe(
      boundary === "backend" ? "backend-configuration-changed" : "backend-endpoint-changed",
    );
    expect(queued.turn.sessionRecovery).toEqual({ restoredMessageCount: 2, omittedMessageCount: 0 });
    expect(f.store.conversation(f.conversation.id).providerSessionId).toBeNull();
  });

  it("keeps restoring after a failed fresh launch and a runtime restart", async () => {
    const f = await fixture();
    f.store.updateConversation(f.conversation.id, {
      providerSessionId: "before-update",
      continuationIdentity: { ...f.previous, endpointIdentity: "different-account-endpoint" },
    });
    const first = f.resolve();
    const queued = f.store.beginAgentTurn(first.input);
    first.adopt(queued);
    f.store.settleAgentTurn(queued.turn.id, {
      status: "failed", terminalReason: "turn-start-failed",
      startedAt: queued.turn.requestedAt, completedAt: queued.turn.requestedAt,
      updatedAt: queued.turn.requestedAt,
    });
    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const restarted = f.openStore();
    const next = f.resolve(restarted);
    const resumed = restarted.beginAgentTurn(next.input);
    const input = next.adopt(resumed).active.providerInput;
    expect(input.sessionId).toBeUndefined();
    expect(input.prompt).toContain("The export must preserve accented names.");
    expect(input.prompt).not.toContain("OTHER_CHAT_PRIVATE_SENTINEL");
    expect(resumed.turn.sessionRecovery).toEqual({ restoredMessageCount: 3, omittedMessageCount: 0 });
  });

  it("does not restore history into the first turn of a new chat", async () => {
    const f = await fixture();
    const resolved = f.resolve();
    const queued = f.store.beginAgentTurn(resolved.input);
    expect(queued.turn).toMatchObject({ continuationReasonCode: "first-turn", sessionRecovery: null });
    expect(resolved.adopt(queued).active.providerInput.prompt).not.toContain("accented names");
  });

  it("leaves an explicit reference to this chat as the only copy of its history", async () => {
    const f = await fixture();
    f.store.updateConversation(f.conversation.id, {
      providerSessionId: "before-update",
      continuationIdentity: { ...f.previous, endpointIdentity: "different-account-endpoint" },
    });
    const packet = f.store.contextPackets.create({
      sourceConversationId: f.conversation.id,
      targetConversationId: f.conversation.id,
      acknowledgedWorkspaceDifference: false,
    });
    const resolved = f.resolve(f.store, {
      context: { conversationContextPacketIds: [packet.id] },
      contextRequestId: "11111111-1111-4111-8111-111111111111",
    });
    const queued = f.store.beginAgentTurn(resolved.input);
    const prompt = resolved.adopt(queued).active.providerInput.prompt;
    expect(prompt.split("The export must preserve accented names.")).toHaveLength(2);
    expect(f.restoredReferences(queued.turn.id)).toEqual([]);
    expect(queued.turn.sessionRecovery).toEqual({ restoredMessageCount: 0, omittedMessageCount: 0 });
  });

  it("prepares a fresh-session request that replaces a rejected resume inside the same turn", async () => {
    const f = await fixture("codex");
    f.store.updateConversation(f.conversation.id, { providerSessionId: "before-update", continuationIdentity: f.previous });
    const resolved = f.resolve();
    const queued = f.store.beginAgentTurn(resolved.input);
    const active = resolved.adopt(queued).active;
    expect(active.freshSessionRequest).toBeTypeOf("function");
    const fresh = active.freshSessionRequest!(queued.message.id);
    expect(fresh.executionPrompt).toContain("The export must preserve accented names.");
    expect(fresh.executionPrompt.split("Continue the export.")).toHaveLength(2);
    expect(fresh.sessionRecovery).toEqual({ restoredMessageCount: 2, omittedMessageCount: 0 });

    const restarted = f.store.restartAgentTurnOnFreshSession(queued.turn.id, {
      expectedSessionId: "before-update",
      executionContext: fresh.persistence,
      sessionRecovery: fresh.sessionRecovery,
      restartedAt: capturedAt,
    });
    expect(restarted).toMatchObject({
      continuationReasonCode: "stale-provider-session",
      providerSessionBefore: null,
      usageAtStart: null,
      sessionRecovery: { restoredMessageCount: 2, omittedMessageCount: 0 },
    });
    expect(f.store.conversation(f.conversation.id)).toMatchObject({
      providerSessionId: null,
      continuationIdentity: null,
    });
    expect(f.restoredReferences(queued.turn.id)).toHaveLength(1);
    expect(() => f.store.restartAgentTurnOnFreshSession(queued.turn.id, {
      expectedSessionId: "before-update",
      executionContext: fresh.persistence,
      sessionRecovery: fresh.sessionRecovery,
      restartedAt: capturedAt,
    })).toThrow("can no longer restart on a fresh provider session");
  });

  it("refuses to restart a settled turn or one whose session already changed", async () => {
    const f = await fixture("codex");
    f.store.updateConversation(f.conversation.id, { providerSessionId: "before-update", continuationIdentity: f.previous });
    const resolved = f.resolve();
    const queued = f.store.beginAgentTurn(resolved.input);
    const fresh = resolved.adopt(queued).active.freshSessionRequest!(queued.message.id);
    const restart = () => f.store.restartAgentTurnOnFreshSession(queued.turn.id, {
      expectedSessionId: "before-update",
      executionContext: fresh.persistence,
      sessionRecovery: fresh.sessionRecovery,
      restartedAt: capturedAt,
    });
    f.store.updateConversation(f.conversation.id, { providerSessionId: "replaced-elsewhere" });
    expect(restart).toThrow("provider session changed before the turn could restart");
    expect(f.store.agentTurn(queued.turn.id).continuationReasonCode).toBe("same-continuation");
    f.store.updateConversation(f.conversation.id, { providerSessionId: "before-update" });
    f.store.settleAgentTurn(queued.turn.id, {
      status: "failed", terminalReason: "provider-error",
      startedAt: queued.turn.requestedAt, completedAt: queued.turn.requestedAt,
      updatedAt: queued.turn.requestedAt,
    });
    expect(restart).toThrow("can no longer restart on a fresh provider session");
  });
});

describe("a saved session that keeps failing to open", () => {
  async function failedResumes(
    count: number,
    outcome: { terminalReason?: string; activityKind?: "status" | "error"; answered?: boolean } = {},
  ) {
    const f = await fixture("codex");
    f.store.updateConversation(f.conversation.id, { providerSessionId: "before-update", continuationIdentity: f.previous });
    for (let attempt = 0; attempt < count; attempt += 1) {
      const resolved = f.resolve(f.store, { content: `Attempt ${attempt + 1}.` });
      const queued = f.store.beginAgentTurn(resolved.input);
      resolved.adopt(queued);
      expect(queued.turn.providerSessionBefore).toBe("before-update");
      f.store.addActivity({
        conversationId: f.conversation.id,
        runId: queued.turn.runId,
        turnId: queued.turn.id,
        kind: outcome.activityKind ?? "error",
        title: "Codex could not complete the request.",
        detail: null,
        status: "failed",
      });
      const answer = outcome.answered
        ? f.store.createMessage(f.conversation.id, "Partial answer", "assistant", [], queued.turn.id)
        : null;
      f.store.settleAgentTurn(queued.turn.id, {
        status: "failed",
        terminalReason: outcome.terminalReason ?? "provider-error",
        providerSessionAfter: "before-update",
        ...(answer ? { terminalAssistantMessageId: answer.id } : {}),
        startedAt: queued.turn.requestedAt, completedAt: queued.turn.requestedAt,
        updatedAt: queued.turn.requestedAt,
      });
    }
    return f;
  }

  it("starts fresh with the chat's history after two resumes fail before the provider does anything", async () => {
    const f = await failedResumes(2);
    expect(f.store.savedSessionKeepsFailing(f.conversation.id, "before-update")).toBe(true);
    const resolved = f.resolve(f.store, { content: "Third attempt." });
    const queued = f.store.beginAgentTurn(resolved.input);
    const input = resolved.adopt(queued).active.providerInput;
    expect(input.sessionId).toBeUndefined();
    expect(input.prompt).toContain("The export must preserve accented names.");
    expect(queued.turn).toMatchObject({
      providerSessionBefore: null,
      continuationReasonCode: "stale-provider-session",
      sessionRecovery: { restoredMessageCount: 4, omittedMessageCount: 0 },
    });
    expect(f.store.conversation(f.conversation.id).providerSessionId).toBeNull();
  });

  it.each([
    ["only one resume has failed", 1, {}],
    ["the provider made progress before failing", 2, { activityKind: "status" }],
    ["the provider had started answering", 2, { answered: true }],
    ["the turn never reached the provider", 2, { terminalReason: "turn-start-failed" }],
  ] as const)("keeps resuming when %s", async (_label, count, outcome) => {
    const f = await failedResumes(count, outcome);
    expect(f.store.savedSessionKeepsFailing(f.conversation.id, "before-update")).toBe(false);
    const resolved = f.resolve(f.store, { content: "Next attempt." });
    const queued = f.store.beginAgentTurn(resolved.input);
    expect(resolved.adopt(queued).active.providerInput.sessionId).toBe("before-update");
    expect(queued.turn.continuationReasonCode).toBe("same-continuation");
  });

  it("does not count failures that belonged to a different session", async () => {
    const f = await failedResumes(2);
    expect(f.store.savedSessionKeepsFailing(f.conversation.id, "another-session")).toBe(false);
  });
});

describe("restored history on a custom backend", () => {
  it("restores a bounded share of a long chat instead of the full budget", async () => {
    const f = await fixture();
    for (let i = 0; i < 40; i += 1) {
      f.store.createMessage(f.conversation.id, `message-${i}: ${"x".repeat(4_000)}`, i % 2 === 0 ? "user" : "assistant", [], null, new Date(Date.UTC(2030, 0, 2, 0, 0, i)).toISOString());
    }
    f.store.updateConversation(f.conversation.id, {
      providerSessionId: "before-update",
      continuationIdentity: { ...f.previous, endpointIdentity: "different-account-endpoint" },
    });
    const restoredBytes = (custom: boolean) => {
      const resolved = resolveTurnRequest({
        store: f.store,
        providers: {
          resolveModelRoute: () => custom
            ? { ...f.route, backendProfile: { ...f.route.backendProfile, source: "custom" } }
            : f.route,
          harnessIdFor: () => f.route.harnessId,
        } as unknown as TurnProviderRuntime,
        hooks: { broadcast: () => undefined, broadcastSnapshot: () => undefined, providerInfo: () => [] },
        id: () => `bounded-${custom}`,
        now: () => capturedAt,
        clock: () => new Date(capturedAt),
      }, { conversationId: f.conversation.id, content: "Continue the export." });
      return {
        bytes: resolved.input.executionContext!.manifest.references
          .filter(({ label }) => label.startsWith(RESTORED_CHAT_HISTORY_LABEL))
          .reduce((total, { byteSize }) => total + byteSize, 0),
        recovery: resolved.input.sessionRecovery,
      };
    };
    const native = restoredBytes(false);
    const custom = restoredBytes(true);
    expect(native.recovery).toEqual({ restoredMessageCount: 42, omittedMessageCount: 0 });
    expect(native.bytes).toBeGreaterThan(150 * 1_024);
    expect(custom.bytes).toBeGreaterThan(0);
    expect(custom.bytes).toBeLessThanOrEqual(48 * 1_024);
    expect(custom.recovery!.restoredMessageCount).toBeGreaterThan(0);
    expect(custom.recovery!.restoredMessageCount + custom.recovery!.omittedMessageCount).toBe(42);
  });
});

describe("restored chat history", () => {
  it("recovers text after NULs in stored and streamed messages", async () => {
    const f = await fixture();
    const answer = f.store.createMessage(f.conversation.id, "Before\0 preserve the first requirement. ", "assistant");
    f.store.appendMessageContent(answer.id, "Next\0 preserve the second requirement.");
    const history = f.history();
    expect(history).toMatchObject({ messageCount: 3, omittedMessageCount: 0 });
    const content = history!.blocks.map((block) => block.content).join("\n");
    expect(content).toContain("preserve the first requirement");
    expect(content).toContain("preserve the second requirement");
    expect(content).not.toContain("\\u0000");
  });

  it.each([false, true])("drops partial credentials at the byte boundary before redaction (streamed: %s)", async (streamed) => {
    const f = await fixture();
    const prefix = "OPENAI_API_KEY=synthetic-credential ".repeat(100);
    const body = prefix + " ".repeat(16_381 - prefix.length) + "sk-" + "Q".repeat(50);
    const message = f.store.createMessage(f.conversation.id, streamed ? "" : body, "assistant");
    if (streamed) f.store.appendMessageContent(message.id, body);
    const content = f.history()!.blocks.map((block) => block.content).join("\n");
    expect(content).not.toContain("synthetic-credential");
    expect(content).not.toMatch(/sk-Q{20}/u);
    expect(content).toContain("[redacted]");
    expect(content).toContain("\"shortened\":true");
  });

  it("joins streamed chunks before redacting", async () => {
    const f = await fixture();
    const answer = f.store.createMessage(f.conversation.id, "", "assistant");
    for (const text of "Start OPENAI_API_KEY=synthetic-credential End 😀") f.store.appendMessageContent(answer.id, text);
    const content = f.history()!.blocks.map((block) => block.content).join("\n");
    expect(content).toContain("Start [redacted] End 😀");
    expect(content).not.toContain("synthetic-credential");
  });

  it("keeps the opening request and the newest turns when a long chat exceeds the budget", async () => {
    const f = await fixture();
    for (let i = 0; i < 60; i += 1) {
      f.store.createMessage(
        f.conversation.id,
        `message-${i}: ${"🚀".repeat(1_500)}`,
        i % 2 === 0 ? "user" : "assistant",
        [],
        null,
        new Date(Date.UTC(2030, 0, 2, 0, 0, i)).toISOString(),
      );
    }
    const history = f.history()!;
    expect(history.messageCount).toBeGreaterThan(24);
    expect(history.omittedMessageCount).toBeGreaterThan(0);
    expect(history.messageCount + history.omittedMessageCount).toBe(62);
    expect(history.blocks.length).toBeGreaterThan(1);
    for (const block of history.blocks) {
      expect(Buffer.byteLength(block.content, "utf8")).toBeLessThanOrEqual(MAX_CONVERSATION_CONTEXT_BLOCK_BYTES);
      expect(block.label.startsWith(`${RESTORED_CHAT_HISTORY_LABEL} · `)).toBe(true);
      expect(block.content).not.toContain("�");
    }
    const content = history.blocks.map((block) => block.content).join("\n");
    expect(content).toContain("The export must preserve accented names.");
    expect(content).toContain("message-59:");
    expect(content).not.toContain("message-0:");
    expect(JSON.parse(history.blocks[0]!.content)).toMatchObject({
      reference: "this-chat",
      source: { conversationId: f.conversation.id, capturedAt },
    });
  });

  it("shrinks to the capacity it is given and reports when nothing fits", async () => {
    const f = await fixture();
    for (let i = 0; i < 20; i += 1) {
      f.store.createMessage(f.conversation.id, `message-${i}: ${"x".repeat(4_000)}`, i % 2 === 0 ? "user" : "assistant", [], null, new Date(Date.UTC(2030, 0, 2, 0, 0, i)).toISOString());
    }
    const complete = f.history()!;
    expect(complete).toMatchObject({ messageCount: 22, omittedMessageCount: 0 });
    const tight = f.history(16 * 1_024)!;
    expect(tight.messageCount).toBeGreaterThan(0);
    expect(tight.messageCount).toBeLessThan(22);
    expect(tight.messageCount + tight.omittedMessageCount).toBe(22);
    expect(tight.blocks.reduce((total, block) => total + Buffer.byteLength(JSON.stringify(block.content), "utf8"), 0))
      .toBeLessThanOrEqual(16 * 1_024);
    expect(f.history(256)).toEqual({ blocks: [], messageCount: 0, omittedMessageCount: 22 });
    expect(f.history(0)).toEqual({ blocks: [], messageCount: 0, omittedMessageCount: 22 });
  });

  it("excludes the message being sent and returns nothing for an empty chat", async () => {
    const f = await fixture();
    const current = f.store.createMessage(f.conversation.id, "CURRENT_REQUEST_SENTINEL", "user");
    const history = f.history(undefined, current.id)!;
    expect(history.messageCount).toBe(2);
    expect(history.blocks.map((block) => block.content).join("\n")).not.toContain("CURRENT_REQUEST_SENTINEL");
    const empty = f.store.createConversation(f.conversation.projectId, "Empty", {
      modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "provider-default" }),
    });
    expect(f.store.continuationHistory(empty.id, MAX_CONVERSATION_CONTEXT_TURN_BYTES, capturedAt)).toBeNull();
    expect(f.store.continuationHistory("missing-conversation", MAX_CONVERSATION_CONTEXT_TURN_BYTES, capturedAt)).toBeNull();
  });
});
