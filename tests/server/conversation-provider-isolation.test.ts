import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { publicRuntimeError } from "../../src/server/runtime-errors";
import {
  CONVERSATION_HAS_HISTORY_SQL,
  CONVERSATION_PROVIDER_MISMATCH_MESSAGE,
} from "../../src/server/persistence/conversation-provider-policy";
import { ConversationProviderChangeError } from "../../src/server/persistence/errors";
import type { BeginAgentTurnInput } from "../../src/server/persistence/types";
import { createConversationCommandHandler, type ConversationCommandDependencies } from "../../src/server/runtime/commands/conversation-commands";
import { resolveTurnRequest, type PrepareTurnRequestDependencies } from "../../src/server/runtime/turns/turn-request-preparation";
import {
  conversationHasHistory,
  officiallyAllowsModelSwitchWithinSession,
  resolveContinuationDecision,
} from "../../src/shared/continuation-policy";
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
const mismatch = CONVERSATION_PROVIDER_MISMATCH_MESSAGE;

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

describe("chat provider handoff", () => {
  it("clears the provider session when an established chat changes provider", () => {
    const { store, conversation } = fixture();

    store.updateConversation(conversation.id, { providerSessionId: "codex-session" });
    expect(store.updateConversation(conversation.id, { model: "gpt-test" }).providerSessionId).toBe("codex-session");
    expect(store.updateConversation(conversation.id, { providerSessionId: null })).toMatchObject({
      providerSessionId: null,
      continuationIdentity: null,
    });
    store.updateConversation(conversation.id, { providerSessionId: "replacement-session" });
    expect(store.updateConversation(conversation.id, { providerId: "claude" })).toMatchObject({
      providerId: "claude",
      providerSessionId: null,
      continuationIdentity: null,
    });
  });

  it.each([false, true])("accepts a provider update after a turn (legacy payload: %s)", async (legacy) => {
    const { store, conversation, update, turnInput } = fixture();
    const queued = store.beginAgentTurn(turnInput("codex"));
    store.updateConversation(conversation.id, { providerSessionId: "codex-session" });
    await expect(update("claude", legacy)).resolves.toBe("mutation");
    expect(store.conversation(conversation.id)).toMatchObject({
      providerId: "claude",
      modelSelection: { harnessId: "claude-agent-sdk" },
      providerSessionId: null,
      continuationIdentity: null,
    });
    expect(store.agentTurn(queued.turn.id)).toEqual(queued.turn);
  });

  it.each(["message", "session", "turn"] as const)("keeps persisted %s evidence when the provider changes", (evidence) => {
    const { store, conversation, turnInput } = fixture();
    const message = evidence === "message" ? store.createMessage(conversation.id, "Restored history") : null;
    if (evidence === "session") store.updateConversation(conversation.id, { providerSessionId: "original-session" });
    const queued = evidence === "turn" ? store.beginAgentTurn(turnInput("codex")) : null;
    expect(store.updateConversation(conversation.id, {
      modelSelection: providerNativeModelSelection({ providerId: "claude" }),
    })).toMatchObject({ providerId: "claude", providerSessionId: null });
    if (message) expect(store.message(message.id)).toEqual(message);
    if (queued) expect(store.agentTurn(queued.turn.id)).toEqual(queued.turn);
    // A bare saved session is provider-owned state, so it does not survive the switch.
    expect(store.conversationShell(conversation.id)?.hasHistory).toBe(evidence !== "session");
  });

  it("switches an unused draft in either direction", async () => {
    const { store, conversation, update, turnInput } = fixture();
    expect(() => store.beginAgentTurn({ ...turnInput("codex"), configurationRevision: -1 })).toThrow();
    await expect(update("claude")).resolves.toBe("mutation");
    await expect(update("codex")).resolves.toBe("mutation");
    expect(store.beginAgentTurn(turnInput("codex")).turn.providerId).toBe("codex");
    expect(store.conversation(conversation.id).providerId).toBe("codex");
  });

  it("rejects a stale prepared send after the chat chooses another provider", () => {
    const { store, conversation, turnInput } = fixture();
    const staleInput = turnInput("codex");
    store.updateConversation(conversation.id, { providerId: "claude" });
    expect(() => store.beginAgentTurn(staleInput)).toThrow(mismatch);
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
    })).toThrow(mismatch);
    expect(store.hasConversationMessages(conversation.id)).toBe(false);
    expect(store.conversation(conversation.id).providerSessionId).toBe("original-session");
  });

  it("rejects direct turn creation with a provider the chat does not use", () => {
    const { store, conversation, turnInput } = fixture();
    const message = store.createMessage(conversation.id, "Original request");
    expect(() => store.createAgentTurn({ ...turnInput("claude"), userMessageId: message.id })).toThrow(mismatch);
    expect(store.hasConversationTurns(conversation.id)).toBe(false);
  });

  it("reports a route that disagrees with the chat's provider as a typed public error", () => {
    const { store, conversation } = fixture();
    let caught: unknown = null;
    try {
      store.assertConversationProvider(conversation.id, "claude");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConversationProviderChangeError);
    expect(publicRuntimeError(caught)).toBe(mismatch);
    expect(() => store.assertConversationProvider(conversation.id, "codex")).not.toThrow();
  });

  it("continues a chat whose earlier turns ran on another provider", () => {
    const { store, conversation, turnInput, preparation } = fixture();
    const first = store.beginAgentTurn(turnInput("codex"));
    store.updateConversation(conversation.id, { providerId: "claude" });
    const resolved = resolveTurnRequest(preparation, { conversationId: conversation.id, content: "Continue on Claude" });
    expect(resolved.input).toMatchObject({ providerId: "claude", continuationReasonCode: "harness-changed" });
    const second = store.beginAgentTurn(resolved.input);
    expect(second.turn.providerId).toBe("claude");
    expect(store.agentTurn(first.turn.id)).toEqual(first.turn);
    expect(store.updateConversation(conversation.id, { title: "Handed off" }).title).toBe("Handed off");
    store.archiveConversation(conversation.id, true);
    expect(store.conversation(conversation.id).archivedAt).not.toBeNull();
  });

  it("no longer publishes a mixed-provider fact on conversation projections", () => {
    const { store, conversation, turnInput } = fixture();
    store.beginAgentTurn(turnInput("codex"));
    store.updateConversation(conversation.id, { providerId: "claude" });
    store.beginAgentTurn(turnInput("claude"));
    for (const projection of [
      store.conversationHistory(conversation.id)?.conversation,
      store.conversationDetail(conversation.id)?.conversation,
      store.recentConversationDetail(conversation.id, {
        messages: 1, activities: 1, subagents: 1, contentCharacters: 1,
      })?.conversation,
      store.conversationShell(conversation.id),
    ]) {
      expect(projection).toBeDefined();
      expect(projection).not.toHaveProperty("mixedProviderHistory");
    }
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
    const claudeSelection = providerNativeModelSelection({ providerId: "claude" });
    const previousIdentity = shell.latestTurn?.continuationIdentity ?? shell.continuationIdentity;
    const decision = resolveContinuationDecision({
      previousProviderId: shell.latestTurn?.providerId ?? shell.providerId,
      hasHistory: conversationHasHistory(shell),
      previousIdentity,
      nextIdentity: continuationIdentityForSelection(claudeSelection),
      previousModelId: previousIdentity ? shell.modelSelection.modelId : null,
      nextModelId: claudeSelection.modelId,
      hasProviderSession: Boolean(shell.providerSessionId),
      hasTurns: shell.latestTurn !== null,
      allowsModelSwitchWithinSession: officiallyAllowsModelSwitchWithinSession(
        resolveHarnessBackendCompatibility("claude-agent-sdk", providerNativeBackendProfile("claude")),
      ),
      allowsPerformanceModeSwitchWithinSession: false,
    });
    expect(decision).toMatchObject({
      action: "start-session",
      reasonCode: established ? "harness-changed" : "first-turn",
    });
  });

  it("keeps the in-flight configuration guard for same-provider updates", async () => {
    const { store, update } = fixture();
    vi.spyOn(store, "hasActiveWorkspaceRunForConversation").mockReturnValue(true);
    await expect(update("codex")).rejects.toThrow("Stop the active run or review");
  });

  it("keeps the in-flight configuration guard for provider changes", async () => {
    const { store, update, turnInput } = fixture();
    store.beginAgentTurn(turnInput("codex"));
    vi.spyOn(store, "hasActiveWorkspaceRunForConversation").mockReturnValue(true);
    await expect(update("claude")).rejects.toThrow("Stop the active run or review");
  });

  it("allows model and reasoning changes with the same provider", async () => {
    const { store, conversation, turnInput, update } = fixture();
    store.beginAgentTurn(turnInput("codex"));
    await expect(update("codex")).resolves.toBe("mutation");
    expect(store.updateConversation(conversation.id, { model: "gpt-next", reasoningEffort: "high" }))
      .toMatchObject({ providerId: "codex", model: "gpt-next", reasoningEffort: "high" });
  });
});
