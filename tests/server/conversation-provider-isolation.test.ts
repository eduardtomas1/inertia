import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { publicRuntimeError } from "../../src/server/runtime-errors";
import {
  CONVERSATION_HAS_HISTORY_SQL,
  CONVERSATION_MIXED_PROVIDER_SQL,
} from "../../src/server/persistence/conversation-provider-policy";
import { ConversationProviderChangeError } from "../../src/server/persistence/errors";
import {
  CHAT_PROVIDER_CHANGE_MESSAGE,
  MIXED_PROVIDER_HISTORY_MESSAGE,
  conversationContinuationRefusal,
} from "../../src/shared/continuation-policy";
import type { BeginAgentTurnInput } from "../../src/server/persistence/types";
import { createConversationCommandHandler, type ConversationCommandDependencies } from "../../src/server/runtime/commands/conversation-commands";
import { resolveTurnRequest, type PrepareTurnRequestDependencies } from "../../src/server/runtime/turns/turn-request-preparation";
import { modelRouteTransitionContext, resolveModelRouteTransition } from "../../src/renderer/src/utils/modelRouteTransition";
import {
  continuationIdentityForSelection,
  modelSelectionSchema,
  providerNativeBackendProfile,
  providerNativeModelSelection,
  resolveHarnessBackendCompatibility,
} from "../../src/shared/model-routing";
import type { ProviderId } from "../../src/shared/contracts";
import { resolveNativeModelRoute } from "./model-route-fixture";

const directories: string[] = [];
const stores: RuntimeStore[] = [];
const guidance = "Start a new chat to use a different provider.";

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "inertia-provider-isolation-"));
  directories.push(directory);
  const workspace = join(directory, "workspace");
  mkdirSync(workspace);
  const databasePath = join(directory, "runtime.sqlite");
  const store = new RuntimeStore(databasePath, workspace, { recoverInterruptedRuns: false });
  stores.push(store);
  const project = store.createProject("Provider isolation", workspace);
  const conversation = store.createConversation(project.id, "Original chat", { providerId: "codex" });
  const commandDependencies = {
    store,
    providers: { resolveModelRoute: resolveNativeModelRoute },
    backendProfileController: {
      isExternalSelection: () => false,
      validateSelection: (selection: unknown) => selection,
      supportsNativeFastModeControl: () => false,
    },
  } as unknown as ConversationCommandDependencies;
  const update = (providerId: ProviderId, legacy = false) => createConversationCommandHandler(commandDependencies)({} as never, {
    type: "conversation.update",
    requestId: "11111111-1111-4111-8111-111111111111",
    payload: {
      conversationId: conversation.id,
      ...(legacy ? { providerId } : { modelSelection: modelSelectionSchema.parse(providerNativeModelSelection({ providerId })) }),
    },
  });
  const turnInput = (providerId: ProviderId): BeginAgentTurnInput => ({
    conversationId: conversation.id,
    runId: `run-${providerId}`,
    content: "Keep this request with its provider.",
    providerId,
    modelSelection: providerNativeModelSelection({ providerId }),
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    configurationRevision: 0,
    association: "authoritative",
  });
  const preparation = {
    store,
    providers: { resolveModelRoute: resolveNativeModelRoute, harnessIdFor: (input: { harnessId: string }) => input.harnessId },
    hooks: { providerInfo: () => [], broadcast: vi.fn(), broadcastSnapshot: vi.fn() },
    id: () => "prepared-turn",
    now: () => new Date().toISOString(),
    clock: () => new Date(),
  } as unknown as PrepareTurnRequestDependencies;
  return { store, conversation, update, turnInput, databasePath, preparation };
}

describe("chat provider isolation", () => {
  it("clears a provider session explicitly but rejects changing an established provider", () => {
    const { store, conversation } = fixture();

    store.updateConversation(conversation.id, { providerSessionId: "codex-session" });
    expect(store.updateConversation(conversation.id, { model: "gpt-test" }).providerSessionId).toBe("codex-session");
    expect(store.updateConversation(conversation.id, { providerSessionId: null })).toMatchObject({
      providerSessionId: null,
      continuationIdentity: null,
    });
    store.updateConversation(conversation.id, { providerSessionId: "replacement-session" });
    expect(() => store.updateConversation(conversation.id, { providerId: "claude" }))
      .toThrow("Start a new chat to use a different provider.");
    expect(store.conversation(conversation.id).providerSessionId).toBe("replacement-session");
  });

  it.each([false, true])("rejects a direct provider update after a turn (legacy payload: %s)", async (legacy) => {
    const { store, conversation, update, turnInput } = fixture();
    const queued = store.beginAgentTurn(turnInput("codex"));
    const before = store.conversation(conversation.id);
    await expect(update("claude", legacy)).rejects.toThrow(guidance);
    expect(store.conversation(conversation.id)).toEqual(before);
    expect(store.agentTurn(queued.turn.id)).toEqual(queued.turn);
  });

  it.each(["message", "session", "turn"] as const)("protects persisted %s evidence from selection-only and session-clearing writes", (evidence) => {
    const { store, conversation, turnInput } = fixture();
    if (evidence === "message") store.createMessage(conversation.id, "Restored history");
    if (evidence === "session") store.updateConversation(conversation.id, { providerSessionId: "original-session" });
    if (evidence === "turn") store.beginAgentTurn(turnInput("codex"));
    const before = store.conversation(conversation.id);
    expect(() => store.updateConversation(conversation.id, {
      modelSelection: providerNativeModelSelection({ providerId: "claude" }),
      providerSessionId: null,
      continuationIdentity: null,
    })).toThrow(guidance);
    expect(store.conversation(conversation.id)).toEqual(before);
  });

  it("allows switching an unused draft after rejected first-send persistence", async () => {
    const { store, conversation, update, turnInput } = fixture();
    expect(() => store.beginAgentTurn({ ...turnInput("codex"), configurationRevision: -1 })).toThrow();
    expect(store.hasConversationMessages(conversation.id)).toBe(false);
    expect(store.hasConversationTurns(conversation.id)).toBe(false);
    await expect(update("claude")).resolves.toBe("mutation");
    expect(store.beginAgentTurn(turnInput("claude")).turn.providerId).toBe("claude");
    await expect(update("codex")).rejects.toThrow(guidance);
  });

  it("rejects a stale prepared first send after the unused draft chooses another provider", () => {
    const { store, conversation, turnInput } = fixture();
    const staleInput = turnInput("codex");
    store.updateConversation(conversation.id, { providerId: "claude" });
    expect(() => store.beginAgentTurn(staleInput)).toThrow(guidance);
    expect(store.hasConversationMessages(conversation.id)).toBe(false);
    expect(store.hasConversationTurns(conversation.id)).toBe(false);
    expect(store.conversation(conversation.id).providerId).toBe("claude");
  });

  it("does not clear a session or append a message on rejected cross-provider admission", () => {
    const { store, conversation, turnInput } = fixture();
    store.updateConversation(conversation.id, { providerSessionId: "original-session" });
    expect(() => store.beginAgentTurn({
      ...turnInput("claude"),
      providerSessionInvalidation: { expectedSessionId: "original-session" },
    })).toThrow(guidance);
    expect(store.hasConversationMessages(conversation.id)).toBe(false);
    expect(store.conversation(conversation.id).providerSessionId).toBe("original-session");
  });

  it("fails closed when a restored conversation selection disagrees with immutable turn history", () => {
    const { store, conversation, turnInput, databasePath, preparation } = fixture();
    const original = store.beginAgentTurn(turnInput("codex"));
    const database = new Database(databasePath);
    database.prepare("UPDATE conversations SET provider_id = ?, model_selection_json = ? WHERE id = ?")
      .run("claude", JSON.stringify(providerNativeModelSelection({ providerId: "claude" })), conversation.id);
    database.close();
    expect(() => resolveTurnRequest(preparation, { conversationId: conversation.id, content: "Do not cross providers" }))
      .toThrow(MIXED_PROVIDER_HISTORY_MESSAGE);
    expect(() => store.beginAgentTurn(turnInput("claude"))).toThrow(MIXED_PROVIDER_HISTORY_MESSAGE);
    expect(store.latestAgentTurnForConversation(conversation.id)?.id).toBe(original.turn.id);
  });

  it("rejects direct turn creation with another provider", () => {
    const { store, conversation, turnInput } = fixture();
    const message = store.createMessage(conversation.id, "Original request");
    expect(() => store.createAgentTurn({ ...turnInput("claude"), userMessageId: message.id })).toThrow(guidance);
    expect(store.hasConversationTurns(conversation.id)).toBe(false);
  });

  it("keeps title and archive operations available for existing mixed histories", () => {
    const { store, conversation, turnInput, databasePath, preparation } = fixture();
    const first = store.beginAgentTurn(turnInput("codex"));
    const second = store.beginAgentTurn({ ...turnInput("codex"), runId: "second-run" });
    const database = new Database(databasePath);
    database.prepare("UPDATE agent_turns SET provider_id = ? WHERE id = ?").run("claude", first.turn.id);
    database.close();
    const before = [store.agentTurn(first.turn.id), store.agentTurn(second.turn.id)];
    expect(() => resolveTurnRequest(preparation, { conversationId: conversation.id, content: "Keep history intact" }))
      .toThrow(MIXED_PROVIDER_HISTORY_MESSAGE);
    expect(() => store.beginAgentTurn(turnInput("claude"))).toThrow(guidance);
    expect(store.updateConversation(conversation.id, { title: "Archived mixed history" }).title).toBe("Archived mixed history");
    store.archiveConversation(conversation.id, true);
    expect(store.conversation(conversation.id).archivedAt).not.toBeNull();
    expect([store.agentTurn(first.turn.id), store.agentTurn(second.turn.id)]).toEqual(before);
  });

  it.each([
    ["an unused draft", false],
    ["a system-only history", true],
    ["a user message", true],
    ["a provider session", true],
    ["a continuation identity", true],
    ["a turn", true],
  ] as const)("publishes the durable history fact the chooser and server share for %s", (evidence, established) => {
    const { store, conversation, turnInput, databasePath } = fixture();
    const codexSelection = providerNativeModelSelection({ providerId: "codex" });
    if (evidence === "a system-only history") store.createMessage(conversation.id, "Context marker", "system");
    if (evidence === "a user message") store.createMessage(conversation.id, "Restored history");
    if (evidence === "a provider session") store.updateConversation(conversation.id, { providerSessionId: "codex-session" });
    if (evidence === "a turn") store.beginAgentTurn(turnInput("codex"));
    if (evidence === "a continuation identity") {
      const database = new Database(databasePath);
      database.prepare("UPDATE conversations SET continuation_identity_json = ? WHERE id = ?")
        .run(JSON.stringify(continuationIdentityForSelection(codexSelection)), conversation.id);
      database.close();
    }
    const shell = store.conversationShell(conversation.id)!;
    const database = new Database(databasePath, { readonly: true });
    const { has_history: policy } = database.prepare(
      `SELECT ${CONVERSATION_HAS_HISTORY_SQL} AS has_history FROM conversations WHERE id = ?`,
    ).get(conversation.id) as { has_history: number };
    database.close();
    expect(policy === 1).toBe(established);
    expect({
      shell: shell.hasHistory,
      shellSnapshot: store.shellSnapshot().conversations.find(({ id }) => id === conversation.id)?.hasHistory,
      history: store.conversationHistory(conversation.id)?.conversation.hasHistory,
      olderHistoryPage: store.conversationHistory(conversation.id, {
        before: { at: "9999-01-01T00:00:00.000Z", id: "older", kind: "message" },
      })?.conversation.hasHistory,
      detail: store.conversationDetail(conversation.id)?.conversation.hasHistory,
      recentDetail: store.recentConversationDetail(conversation.id, {
        messages: 1, activities: 1, subagents: 1, contentCharacters: 1,
      })?.conversation.hasHistory,
    }).toEqual({
      shell: established,
      shellSnapshot: established,
      history: established,
      olderHistoryPage: established,
      detail: established,
      recentDetail: established,
    });
    let serverRejects = false;
    try {
      store.assertConversationProvider(conversation.id, "claude", true);
    } catch (error) {
      expect((error as Error).message).toContain(guidance);
      serverRejects = true;
    }
    const claudeSelection = providerNativeModelSelection({ providerId: "claude" });
    const transition = resolveModelRouteTransition(modelRouteTransitionContext(shell, shell.latestTurn), {
      selection: claudeSelection,
      continuationIdentity: continuationIdentityForSelection(claudeSelection),
      compatibility: resolveHarnessBackendCompatibility("claude-agent-sdk", providerNativeBackendProfile("claude")),
    });
    expect(serverRejects).toBe(established);
    expect(transition.kind === "create-new-conversation").toBe(established);
  });

  it.each([
    ["an unused chat", false],
    ["a single-provider history", false],
    ["a mixed-provider history", true],
    ["a history whose provider differs from the saved selection", true],
  ] as const)("publishes the mixed-provider fact on conversation details for %s", (evidence, mixed) => {
    const { store, conversation, turnInput, databasePath } = fixture();
    if (evidence !== "an unused chat") store.beginAgentTurn(turnInput("codex"));
    const database = new Database(databasePath);
    if (evidence === "a mixed-provider history") {
      store.beginAgentTurn({ ...turnInput("codex"), runId: "second-run" });
      database.prepare("UPDATE agent_turns SET provider_id = 'claude' WHERE run_id = 'run-codex'").run();
    }
    if (evidence === "a history whose provider differs from the saved selection") {
      database.prepare("UPDATE conversations SET provider_id = ?, model_selection_json = ? WHERE id = ?")
        .run("claude", JSON.stringify(providerNativeModelSelection({ providerId: "claude" })), conversation.id);
    }
    const { mixed_provider_history: policy } = database.prepare(`
      SELECT ${CONVERSATION_MIXED_PROVIDER_SQL} AS mixed_provider_history FROM conversations WHERE id = ?
    `).get(conversation.id) as { mixed_provider_history: number };
    database.close();
    expect(policy === 1).toBe(mixed);
    expect({
      history: store.conversationHistory(conversation.id)?.conversation.mixedProviderHistory,
      olderHistoryPage: store.conversationHistory(conversation.id, {
        before: { at: "9999-01-01T00:00:00.000Z", id: "older", kind: "message" },
      })?.conversation.mixedProviderHistory,
      detail: store.conversationDetail(conversation.id)?.conversation.mixedProviderHistory,
      recentDetail: store.recentConversationDetail(conversation.id, {
        messages: 1, activities: 1, subagents: 1, contentCharacters: 1,
      })?.conversation.mixedProviderHistory,
    }).toEqual({ history: mixed, olderHistoryPage: mixed, detail: mixed, recentDetail: mixed });
    expect(store.conversationShell(conversation.id)).not.toHaveProperty("mixedProviderHistory");
    const saved = store.conversation(conversation.id).providerId;
    for (const providerId of ["codex", "claude", "kimi"] as const) {
      let message: string | null = null;
      try {
        store.assertConversationProvider(conversation.id, providerId, true);
      } catch (error) {
        expect(error).toBeInstanceOf(ConversationProviderChangeError);
        message = publicRuntimeError(error);
      }
      if (mixed) {
        expect(message).toBe(providerId === saved ? MIXED_PROVIDER_HISTORY_MESSAGE : CHAT_PROVIDER_CHANGE_MESSAGE);
      } else if (evidence === "an unused chat" || providerId === saved) {
        expect(message).toBeNull();
      } else {
        expect(message).toBe(CHAT_PROVIDER_CHANGE_MESSAGE);
      }
    }
  });

  it.each([
    "a history whose provider differs from the saved selection",
    "a mixed-provider history",
  ] as const)("explains the refusal truthfully for %s", (evidence) => {
    const { store, conversation, turnInput, databasePath, preparation } = fixture();
    store.beginAgentTurn(turnInput("codex"));
    const database = new Database(databasePath);
    if (evidence === "a mixed-provider history") {
      store.beginAgentTurn({ ...turnInput("codex"), runId: "second-run" });
      database.prepare("UPDATE agent_turns SET provider_id = 'claude' WHERE run_id = 'run-codex'").run();
    } else {
      database.prepare("UPDATE conversations SET provider_id = ?, model_selection_json = ? WHERE id = ?")
        .run("claude", JSON.stringify(providerNativeModelSelection({ providerId: "claude" })), conversation.id);
    }
    database.close();
    const explanation = "This chat's provider changed after some of its turns ran, so it can't continue here. "
      + "Start a new chat to keep working; this chat keeps its history.";
    const saved = store.conversation(conversation.id).providerId;
    let message: string | null = null;
    try {
      store.assertConversationProvider(conversation.id, saved);
    } catch (error) {
      message = publicRuntimeError(error);
    }
    expect(message).toBe(explanation);
    expect(() => resolveTurnRequest(preparation, { conversationId: conversation.id, content: "Continue here" }))
      .toThrow(explanation);
    expect(conversationContinuationRefusal(store.conversationDetail(conversation.id)?.conversation))
      .toBe(explanation);
  });

  it("keeps the in-flight configuration guard for same-provider updates", async () => {
    const { store, update } = fixture();
    vi.spyOn(store, "hasActiveWorkspaceRunForConversation").mockReturnValue(true);
    await expect(update("codex")).rejects.toThrow("Stop the active run or review");
  });

  it("allows model and reasoning changes with the same provider", async () => {
    const { store, conversation, turnInput, update } = fixture();
    store.beginAgentTurn(turnInput("codex"));
    await expect(update("codex")).resolves.toBe("mutation");
    expect(store.updateConversation(conversation.id, { model: "gpt-next", reasoningEffort: "high" }))
      .toMatchObject({ providerId: "codex", model: "gpt-next", reasoningEffort: "high" });
  });
});
