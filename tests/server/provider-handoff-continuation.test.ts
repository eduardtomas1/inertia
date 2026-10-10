import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import {
  MAX_PROVIDER_HANDOFF_FILES,
  MAX_PROVIDER_HANDOFF_FILES_BYTES,
  PROVIDER_HANDOFF_FILES_LABEL,
  providerHandoffFilesBlock,
} from "../../src/server/persistence/provider-handoff-files";
import {
  createConversationCommandHandler,
  type ConversationCommandDependencies,
} from "../../src/server/runtime/commands/conversation-commands";
import { RuntimeRequestError } from "../../src/server/runtime-errors";
import { prepareTurnRequest, resolveTurnRequest } from "../../src/server/runtime/turns/turn-request-preparation";
import type { QueueTurnRequest, TurnProviderRuntime } from "../../src/server/runtime/turns/turn-controller-types";
import type { ProviderId, TurnGitArtifactFile } from "../../src/shared/contracts";
import { modelSelectionSchema, providerNativeModelSelection, type ModelSelection } from "../../src/shared/model-routing";
import { resolveNativeModelRoute } from "./model-route-fixture";

const stores: RuntimeStore[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

type Route = ReturnType<typeof resolveNativeModelRoute>;

function changedFile(path: string, status: string, insertions: number, deletions: number): TurnGitArtifactFile {
  return {
    path,
    previousPath: null,
    status,
    insertions,
    deletions,
    binary: false,
    untracked: false,
    staged: false,
    unstaged: true,
    indexStatus: ".",
    worktreeStatus: status.slice(0, 1),
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "inertia-provider-handoff-"));
  directories.push(directory);
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const databasePath = join(directory, "runtime.sqlite");
  const store = new RuntimeStore(databasePath, workspace, { recoverInterruptedRuns: false });
  stores.push(store);
  const project = store.createProject("Handoff", workspace);
  const conversation = store.createConversation(project.id, "Export work", {
    modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "provider-default" }),
  });
  let sequence = 0;
  let clock = Date.parse("2030-01-01T00:00:00.000Z");
  const tick = () => new Date(clock += 1_000).toISOString();
  const routeFor = (selection: ModelSelection, endpointIdentity?: string): Route => {
    const route = resolveNativeModelRoute(selection);
    return endpointIdentity === undefined
      ? route
      : { ...route, continuationIdentity: { ...route.continuationIdentity, endpointIdentity } };
  };
  const dependencies = (endpointIdentity?: string) => ({
    store,
    providers: {
      resolveModelRoute: (selection: ModelSelection) => routeFor(selection, endpointIdentity),
      harnessIdFor: (input: { harnessId: string }) => input.harnessId,
    } as unknown as TurnProviderRuntime,
    hooks: { broadcast: () => undefined, broadcastSnapshot: () => undefined, providerInfo: () => [] },
    id: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    now: tick,
    clock: () => new Date(clock),
  });
  const resolve = (request: Partial<QueueTurnRequest> = {}, endpointIdentity?: string) => resolveTurnRequest(
    dependencies(endpointIdentity),
    { conversationId: conversation.id, content: "Continue the export.", ...request },
  );
  const prepare = (content: string) => prepareTurnRequest(
    dependencies(),
    { conversationId: conversation.id, content },
  );
  const begin = (content: string, endpointIdentity?: string) => {
    const resolved = resolve({ content }, endpointIdentity);
    const queued = store.beginAgentTurn(resolved.input);
    return { queued, providerInput: resolved.adopt(queued).active.providerInput };
  };
  const complete = (turnId: string, reply: string, sessionId: string, files: TurnGitArtifactFile[] = []) => {
    store.createMessage(conversation.id, reply, "assistant", [], turnId, tick());
    if (files.length > 0) {
      const createdAt = tick();
      store.createTurnGitArtifact({ turnId, status: "pending", createdAt });
      store.completeTurnGitArtifact(turnId, {
        files,
        insertions: files.reduce((total, file) => total + file.insertions, 0),
        deletions: files.reduce((total, file) => total + file.deletions, 0),
        status: "ready",
        completeness: "complete",
        updatedAt: createdAt,
      });
    }
    const settledAt = tick();
    store.settleAgentTurn(turnId, {
      status: "completed", terminalReason: "provider-completed", providerSessionAfter: sessionId,
      startedAt: settledAt, completedAt: settledAt, updatedAt: settledAt,
    });
    store.updateConversation(conversation.id, {
      providerSessionId: sessionId,
      continuationIdentity: store.agentTurn(turnId).continuationIdentity,
    });
  };
  const fail = (turnId: string) => {
    const settledAt = tick();
    store.settleAgentTurn(turnId, {
      status: "failed", terminalReason: "turn-start-failed",
      startedAt: settledAt, completedAt: settledAt, updatedAt: settledAt,
    });
  };
  const switchProvider = (providerId: ProviderId) => createConversationCommandHandler({
    store,
    providers: { resolveModelRoute: resolveNativeModelRoute },
    backendProfileController: {
      isExternalSelection: () => false,
      validateSelection: (selection: unknown) => selection,
      supportsNativeFastModeControl: () => false,
    },
  } as unknown as ConversationCommandDependencies)({} as never, {
    type: "conversation.update",
    requestId: "11111111-1111-4111-8111-111111111111",
    payload: {
      conversationId: conversation.id,
      modelSelection: modelSelectionSchema.parse(providerNativeModelSelection({ providerId })),
    },
  });
  const seedClaudeHistory = () => {
    const first = begin("Export the customer list as UTF-8.");
    complete(first.queued.turn.id, "CLAUDE_REPLY_SENTINEL: the exporter now writes UTF-8.", "claude-session", [
      changedFile("src/export.ts", "added", 40, 0),
      changedFile("src/legacy-export.ts", "modified", 2, 5),
    ]);
    const second = begin("Keep accented names intact.");
    complete(second.queued.turn.id, "Accented names now round-trip.", "claude-session", [
      changedFile("src/export.ts", "modified", 3, 1),
    ]);
  };
  const filesBlock = () => {
    const database = new Database(databasePath, { readonly: true });
    try {
      return providerHandoffFilesBlock(database, conversation.id, {
        backendProfileId: providerNativeModelSelection({ providerId: "codex" }).backendProfileId,
        endpointIdentity: null,
        includeUnattributed: true,
        handoff: { before: "2999-01-01T00:00:00.000Z", providerId: "codex" },
      });
    } finally {
      database.close();
    }
  };
  const update = (payload: Record<string, unknown>) => createConversationCommandHandler({
    store,
    providers: { resolveModelRoute: resolveNativeModelRoute },
    backendProfileController: {
      isExternalSelection: () => false,
      validateSelection: (selection: unknown) => selection,
      supportsNativeFastModeControl: () => false,
    },
  } as unknown as ConversationCommandDependencies)({} as never, {
    type: "conversation.update",
    requestId: "11111111-1111-4111-8111-111111111111",
    payload: { conversationId: conversation.id, ...payload },
  } as never);
  const clearSession = () => {
    const database = new Database(databasePath);
    try {
      database.exec(`UPDATE conversations SET provider_session_id = NULL, continuation_identity_json = NULL WHERE id = '${conversation.id}'`);
    } finally {
      database.close();
    }
    expect(store.conversation(conversation.id).providerSessionId).toBeNull();
  };
  return { store, conversation, tick, resolve, prepare, begin, complete, fail, switchProvider, update, clearSession, seedClaudeHistory, filesBlock };
}

describe("provider handoff continuation", () => {
  it("starts a fresh Codex session that receives the Claude messages and changed files", async () => {
    const f = await fixture();
    f.seedClaudeHistory();

    await expect(f.switchProvider("codex")).resolves.toBe("mutation");
    expect(f.store.conversation(f.conversation.id)).toMatchObject({
      providerId: "codex",
      providerSessionId: null,
      continuationIdentity: null,
    });

    const handoff = f.begin("Continue on Codex.");
    expect(handoff.providerInput.providerId).toBe("codex");
    expect(handoff.providerInput.sessionId).toBeUndefined();
    expect(handoff.queued.turn).toMatchObject({
      providerId: "codex",
      continuationReasonCode: "harness-changed",
      providerSessionBefore: null,
      sessionRecovery: { restoredMessageCount: 4, omittedMessageCount: 0 },
    });
    expect(handoff.queued.turn.sessionRecovery).not.toHaveProperty("withheldMessageCount");
    const prompt = handoff.providerInput.prompt;
    expect(prompt).toContain("Export the customer list as UTF-8.");
    expect(prompt).toContain("CLAUDE_REPLY_SENTINEL: the exporter now writes UTF-8.");
    expect(prompt).toContain("Continue on Codex.");
    expect(prompt).toContain(PROVIDER_HANDOFF_FILES_LABEL);
    expect(prompt).toContain('"content":{"files":["A src/export.ts +43 -1","M src/legacy-export.ts +2 -5"]}');
    expect(prompt).toContain('"moved":"from Claude by the user\'s choice"');
    expect(f.store.turnExecutionManifest(handoff.queued.turn.id)?.references.map(({ label }) => label))
      .toContain(PROVIDER_HANDOFF_FILES_LABEL);
  });

  it("keeps restoring the Claude messages after the first Codex turn fails before a session exists", async () => {
    const f = await fixture();
    f.seedClaudeHistory();
    await f.switchProvider("codex");
    const failed = f.begin("Continue on Codex.");
    f.fail(failed.queued.turn.id);

    const retry = f.begin("Try Codex again.");
    expect(retry.providerInput.sessionId).toBeUndefined();
    expect(retry.queued.turn.continuationReasonCode).toBe("missing-continuation-identity");
    expect(retry.queued.turn.sessionRecovery).toEqual({ restoredMessageCount: 5, omittedMessageCount: 0 });
    expect(retry.providerInput.prompt).toContain("CLAUDE_REPLY_SENTINEL: the exporter now writes UTF-8.");
    expect(retry.providerInput.prompt).toContain("Continue on Codex.");
    expect(retry.providerInput.prompt).toContain(PROVIDER_HANDOFF_FILES_LABEL);
  });

  it("does not let messages from a later endpoint leak back through the handoff", async () => {
    const f = await fixture();
    f.seedClaudeHistory();
    await f.switchProvider("codex");
    const handoff = f.begin("Continue on Codex.");
    f.complete(handoff.queued.turn.id, "CODEX_DEFAULT_REPLY", "codex-session");
    const other = f.begin("Continue on another Codex account.", "account-b");
    f.complete(other.queued.turn.id, "ACCOUNT_B_SECRET", "codex-session-b", [
      changedFile("src/account-b-secret.ts", "added", 9, 0),
    ]);

    const back = f.begin("Back on the default account.");
    expect(back.queued.turn).toMatchObject({
      continuationReasonCode: "backend-endpoint-changed",
      sessionRecovery: { restoredMessageCount: 6, omittedMessageCount: 0, withheldMessageCount: 2 },
    });
    expect(back.providerInput.prompt).toContain("CLAUDE_REPLY_SENTINEL");
    expect(back.providerInput.prompt).toContain("CODEX_DEFAULT_REPLY");
    expect(back.providerInput.prompt).not.toContain("ACCOUNT_B_SECRET");
    expect(back.providerInput.prompt).not.toContain("Continue on another Codex account.");
    expect(back.providerInput.prompt).toContain("src/legacy-export.ts");
    expect(back.providerInput.prompt).not.toContain("src/account-b-secret.ts");
  });

  it("keeps the endpoint rule for the target provider's own history across a handoff hop", async () => {
    const f = await fixture();
    f.seedClaudeHistory();
    await f.switchProvider("codex");
    const handoff = f.begin("Continue on Codex.");
    f.complete(handoff.queued.turn.id, "CODEX_REPLY_SENTINEL: header added.", "codex-session");
    await f.switchProvider("claude");

    const hop = f.begin("Continue on the other Claude endpoint.", "endpoint-x");
    expect(hop.queued.turn).toMatchObject({
      providerId: "claude",
      continuationReasonCode: "harness-changed",
      sessionRecovery: { restoredMessageCount: 2, omittedMessageCount: 0, withheldMessageCount: 4 },
    });
    expect(hop.providerInput.prompt).toContain("CODEX_REPLY_SENTINEL: header added.");
    expect(hop.providerInput.prompt).toContain("Continue on Codex.");
    expect(hop.providerInput.prompt).not.toContain("CLAUDE_REPLY_SENTINEL");
    expect(hop.providerInput.prompt).not.toContain("Export the customer list as UTF-8.");
    expect(hop.providerInput.prompt).not.toContain("src/legacy-export.ts");
    f.complete(hop.queued.turn.id, "ENDPOINT_X_REPLY", "claude-x-session", [
      changedFile("src/endpoint-x.ts", "added", 3, 0),
    ]);
    f.store.updateConversation(f.conversation.id, { providerSessionId: null, continuationIdentity: null });

    const fresh = f.begin("Pick it back up on the other endpoint.", "endpoint-x");
    expect(fresh.queued.turn.continuationReasonCode).toBe("missing-continuation-identity");
    expect(fresh.providerInput.prompt).toContain("CODEX_REPLY_SENTINEL: header added.");
    expect(fresh.providerInput.prompt).toContain("ENDPOINT_X_REPLY");
    expect(fresh.providerInput.prompt).not.toContain("CLAUDE_REPLY_SENTINEL");
    expect(fresh.providerInput.prompt).toContain("src/endpoint-x.ts");
    expect(fresh.providerInput.prompt).not.toContain("src/legacy-export.ts");
  });

  it("does not treat a later same-provider harness change as a handoff", async () => {
    const f = await fixture();
    f.seedClaudeHistory();
    await f.switchProvider("codex");
    const handoff = f.begin("Continue on Codex.");
    f.complete(handoff.queued.turn.id, "CODEX_DEFAULT_REPLY", "codex-session");
    f.store.updateConversation(f.conversation.id, {
      modelSelection: { ...providerNativeModelSelection({ providerId: "codex" }), harnessId: "codex-cli" },
    });
    // Record the CLI turn as the same-provider harness change that withheld history.
    const resolved = f.resolve({ content: "Continue in the Codex CLI on account B." }, "account-b");
    expect(resolved.input.providerId).toBe("codex");
    const moved = f.store.beginAgentTurn({
      ...resolved.input,
      continuationReasonCode: "harness-changed",
      sessionRecovery: { restoredMessageCount: 0, omittedMessageCount: 0, withheldMessageCount: 6 },
    });
    expect(moved.turn).toMatchObject({ harnessId: "codex-cli", continuationReasonCode: "harness-changed" });
    f.complete(moved.turn.id, "CLI_REPLY", "codex-cli-session");
    f.store.updateConversation(f.conversation.id, { providerSessionId: null, continuationIdentity: null });

    const stale = f.begin("Retry in the Codex CLI.", "account-b");
    expect(stale.queued.turn.continuationReasonCode).toBe("missing-continuation-identity");
    expect(stale.providerInput.prompt).toContain("CLI_REPLY");
    expect(stale.providerInput.prompt).not.toContain("CLAUDE_REPLY_SENTINEL");
    expect(stale.providerInput.prompt).not.toContain("CODEX_DEFAULT_REPLY");
    expect(stale.providerInput.prompt).not.toContain(PROVIDER_HANDOFF_FILES_LABEL);
    expect(stale.queued.turn.sessionRecovery).toMatchObject({ withheldMessageCount: 6 });
  });

  it("does not let a handoff that restored nothing admit the earlier provider's messages later", async () => {
    const f = await fixture();
    f.seedClaudeHistory();
    await f.switchProvider("codex");
    const resolved = f.resolve({ content: "Continue on Codex." });
    expect(resolved.input.continuationReasonCode).toBe("harness-changed");
    const handoff = f.store.beginAgentTurn({
      ...resolved.input,
      sessionRecovery: { restoredMessageCount: 0, omittedMessageCount: 4 },
    });
    f.complete(handoff.turn.id, "CODEX_DEFAULT_REPLY", "codex-session");
    f.store.updateConversation(f.conversation.id, { providerSessionId: null, continuationIdentity: null });

    const fresh = f.begin("Pick the export back up.");
    expect(fresh.queued.turn.continuationReasonCode).toBe("missing-continuation-identity");
    expect(fresh.providerInput.prompt).toContain("CODEX_DEFAULT_REPLY");
    expect(fresh.providerInput.prompt).not.toContain("CLAUDE_REPLY_SENTINEL");
    expect(fresh.providerInput.prompt).not.toContain(PROVIDER_HANDOFF_FILES_LABEL);
    expect(fresh.queued.turn.sessionRecovery).toMatchObject({ withheldMessageCount: 4 });
  });

  it("refuses a native goal start until a message carries the history to the new provider", async () => {
    const f = await fixture();
    f.seedClaudeHistory();
    await f.switchProvider("codex");
    expect(() => f.resolve({ goalStart: { objective: "Ship the exporter" } }))
      .toThrow(new RuntimeRequestError("Send a message first so Codex receives this chat's earlier messages."));
    const handoff = f.begin("Continue on Codex.");
    f.complete(handoff.queued.turn.id, "Codex picked up the export.", "codex-session");
    expect(() => f.resolve({ goalStart: { objective: "Ship the exporter" } })).not.toThrow();
  });

  it("resumes the new provider's own session after a successful handoff", async () => {
    const f = await fixture();
    f.seedClaudeHistory();
    await f.switchProvider("codex");
    const handoff = f.begin("Continue on Codex.");
    f.complete(handoff.queued.turn.id, "Codex picked up the export.", "codex-session");

    const next = f.begin("Add a CSV header.");
    expect(next.providerInput.sessionId).toBe("codex-session");
    expect(next.queued.turn).toMatchObject({ continuationReasonCode: "same-continuation", sessionRecovery: null });
    expect(next.providerInput.prompt).not.toContain("CLAUDE_REPLY_SENTINEL");
  });

  it("still withholds earlier messages from an endpoint the handoff never reached", async () => {
    const f = await fixture();
    f.seedClaudeHistory();
    await f.switchProvider("codex");
    const handoff = f.begin("Continue on Codex.");
    f.complete(handoff.queued.turn.id, "Codex picked up the export.", "codex-session");

    const moved = f.begin("Continue on another Codex account.", "account-b");
    expect(moved.queued.turn).toMatchObject({
      continuationReasonCode: "backend-endpoint-changed",
      sessionRecovery: { restoredMessageCount: 0, omittedMessageCount: 0, withheldMessageCount: 6 },
    });
    expect(moved.providerInput.prompt).not.toContain("CLAUDE_REPLY_SENTINEL");
    expect(moved.providerInput.prompt).not.toContain(PROVIDER_HANDOFF_FILES_LABEL);
  });

  it("resumes the original session when the chat switches back before any message was sent", async () => {
    const f = await fixture();
    f.seedClaudeHistory();
    const claudeIdentity = f.store.conversation(f.conversation.id).continuationIdentity;
    expect(claudeIdentity).not.toBeNull();

    await f.switchProvider("codex");
    expect(f.store.conversation(f.conversation.id)).toMatchObject({ providerSessionId: null, continuationIdentity: null });
    await f.switchProvider("claude");
    expect(f.store.conversation(f.conversation.id)).toMatchObject({
      providerId: "claude",
      providerSessionId: "claude-session",
      continuationIdentity: claudeIdentity,
    });

    const next = f.begin("Carry on with the export.");
    expect(next.providerInput.sessionId).toBe("claude-session");
    expect(next.queued.turn).toMatchObject({
      providerId: "claude",
      continuationReasonCode: "same-continuation",
      providerSessionBefore: "claude-session",
      sessionRecovery: null,
    });
    expect(next.providerInput.prompt).not.toContain("CLAUDE_REPLY_SENTINEL");
  });

  it("leaves a session that a migration cleared alone when the same model is picked again", async () => {
    const f = await fixture();
    f.seedClaudeHistory();
    f.clearSession();
    await f.update({ modelSelection: modelSelectionSchema.parse(providerNativeModelSelection({ providerId: "claude" })) });
    expect(f.store.conversation(f.conversation.id)).toMatchObject({ providerSessionId: null, continuationIdentity: null });
    const next = f.begin("Carry on.");
    expect(next.providerInput.sessionId).toBeUndefined();
  });

  it("leaves a cleared Codex thread alone when only the reasoning effort changes", async () => {
    const f = await fixture();
    await f.switchProvider("codex");
    const first = f.begin("Start on Codex.");
    f.complete(first.queued.turn.id, "Codex reply.", "codex-old-thread");
    f.clearSession();
    await f.update({ reasoningEffort: "high" });
    expect(f.store.conversation(f.conversation.id)).toMatchObject({ providerSessionId: null, continuationIdentity: null });
    expect(f.store.conversation(f.conversation.id).modelSelection.reasoningEffort).toBe("high");
    const next = f.begin("Carry on.");
    expect(next.providerInput.sessionId).toBeUndefined();
  });

  it("does not resume a session the latest turn never finished", async () => {
    const f = await fixture();
    f.seedClaudeHistory();
    const running = f.begin("Keep going.");
    await f.switchProvider("codex");
    await f.switchProvider("claude");
    expect(f.store.agentTurn(running.queued.turn.id).status).not.toBe("completed");
    expect(f.store.conversation(f.conversation.id)).toMatchObject({ providerSessionId: null, continuationIdentity: null });
  });

  it("counts a reference to this chat as the handoff's restored history and keeps it for later sessions", async () => {
    const f = await fixture();
    f.seedClaudeHistory();
    await f.switchProvider("codex");
    const packet = f.store.contextPackets.create({
      sourceConversationId: f.conversation.id,
      targetConversationId: f.conversation.id,
      acknowledgedWorkspaceDifference: false,
    });
    const resolved = f.resolve({
      content: "Continue on Codex.",
      context: { conversationContextPacketIds: [packet.id] },
      contextRequestId: "22222222-2222-4222-8222-222222222222",
    });
    const queued = f.store.beginAgentTurn(resolved.input);
    const prompt = resolved.adopt(queued).active.providerInput.prompt;
    expect(queued.turn).toMatchObject({
      continuationReasonCode: "harness-changed",
      sessionRecovery: { restoredMessageCount: 4, omittedMessageCount: 0 },
    });
    expect(prompt.split("CLAUDE_REPLY_SENTINEL")).toHaveLength(2);
    expect(prompt).toContain(PROVIDER_HANDOFF_FILES_LABEL);
    expect(prompt).toContain("src/legacy-export.ts");
    f.complete(queued.turn.id, "CODEX_DEFAULT_REPLY", "codex-session");
    f.store.updateConversation(f.conversation.id, { providerSessionId: null, continuationIdentity: null });

    const later = f.begin("Pick it back up on Codex.");
    expect(later.queued.turn.continuationReasonCode).toBe("missing-continuation-identity");
    expect(later.queued.turn.sessionRecovery).toEqual({ restoredMessageCount: 6, omittedMessageCount: 0 });
    expect(later.providerInput.prompt).toContain("CLAUDE_REPLY_SENTINEL");
    expect(later.providerInput.prompt).toContain("CODEX_DEFAULT_REPLY");
  });

  it("lists the changed files when a rejected Claude resume restarts on a fresh session", async () => {
    const f = await fixture();
    f.seedClaudeHistory();
    const resolved = f.resolve({ content: "Keep going on Claude." });
    const queued = f.store.beginAgentTurn(resolved.input);
    const active = resolved.adopt(queued).active;
    expect(active.providerInput.sessionId).toBe("claude-session");
    const fresh = active.freshSessionRequest!(queued.message.id);
    expect(fresh.sessionRecovery).toEqual({ restoredMessageCount: 4, omittedMessageCount: 0 });
    expect(fresh.executionPrompt).toContain("CLAUDE_REPLY_SENTINEL");
    expect(fresh.executionPrompt).toContain(PROVIDER_HANDOFF_FILES_LABEL);
    expect(fresh.executionPrompt).toContain("src/legacy-export.ts");
  });

  it("carries a reference used before the switch to the new provider", async () => {
    const f = await fixture();
    const source = f.store.createConversation(f.conversation.projectId, "Export encoding", { activate: false });
    f.store.createMessage(source.id, "REFERENCE_SENTINEL: the writer opened latin1.", "assistant", [], null, f.tick());
    const packet = f.store.contextPackets.create({
      sourceConversationId: source.id, targetConversationId: f.conversation.id, acknowledgedWorkspaceDifference: false,
    });
    const resolved = f.resolve({
      content: "Port the encoding fix.",
      context: { conversationContextPacketIds: [packet.id] },
      contextRequestId: "33333333-3333-4333-8333-333333333333",
    });
    const queued = f.store.beginAgentTurn(resolved.input);
    expect(resolved.adopt(queued).active.providerInput.prompt).toContain("REFERENCE_SENTINEL");
    f.complete(queued.turn.id, "Ported the writer change.", "claude-session");
    await f.switchProvider("codex");

    const handoff = f.begin("Also add the opt-in BOM.");
    expect(handoff.queued.turn.sessionRecovery).toEqual({ restoredMessageCount: 2, omittedMessageCount: 0 });
    expect(handoff.providerInput.prompt).toContain("REFERENCE_SENTINEL");
    expect(handoff.providerInput.prompt).toContain("[referenced chat: Export encoding]");
    expect(f.store.turnExecutionManifest(handoff.queued.turn.id)?.references.map(({ label }) => label))
      .toContain("Chat context · Export encoding · 1 message");
  });

  it("hands the chat back to the original provider with the full history", async () => {
    const f = await fixture();
    f.seedClaudeHistory();
    await f.switchProvider("codex");
    const handoff = f.begin("Continue on Codex.");
    f.complete(handoff.queued.turn.id, "CODEX_REPLY_SENTINEL: header added.", "codex-session");
    await f.switchProvider("claude");

    const back = f.begin("Back on Claude.");
    expect(back.providerInput.sessionId).toBeUndefined();
    expect(back.queued.turn).toMatchObject({
      providerId: "claude",
      continuationReasonCode: "harness-changed",
      sessionRecovery: { restoredMessageCount: 6, omittedMessageCount: 0 },
    });
    expect(back.providerInput.prompt).toContain("CODEX_REPLY_SENTINEL: header added.");
    expect(back.providerInput.prompt).toContain("CLAUDE_REPLY_SENTINEL");
  });
});

describe("provider handoff files block", () => {
  it("is absent when the chat recorded no changed files", async () => {
    const f = await fixture();
    const turn = f.begin("Explain the exporter.");
    f.complete(turn.queued.turn.id, "It streams rows.", "claude-session");
    expect(f.filesBlock()).toBeNull();
  });

  it("deduplicates paths newest-first, sums line counts, and keeps a file added earlier as added", async () => {
    const f = await fixture();
    f.seedClaudeHistory();
    const failedCapture = f.begin("Rename the exporter.");
    f.store.createTurnGitArtifact({ turnId: failedCapture.queued.turn.id, status: "failed" });
    const block = f.filesBlock()!;
    expect(block.label).toBe(PROVIDER_HANDOFF_FILES_LABEL);
    expect(block.structured).toBe(true);
    expect(JSON.parse(block.content)).toEqual({
      files: ["A src/export.ts +43 -1", "M src/legacy-export.ts +2 -5"],
    });
  });

  it("reports a file added and later deleted as deleted, and one re-added after a deletion as added", async () => {
    const f = await fixture();
    const created = f.begin("Create the scratch files.");
    f.complete(created.queued.turn.id, "Created them.", "claude-session", [
      changedFile("src/scratch.ts", "added", 5, 0),
      changedFile("src/restored.ts", "added", 4, 0),
    ]);
    const removed = f.begin("Remove them.");
    f.complete(removed.queued.turn.id, "Removed them.", "claude-session", [
      changedFile("src/scratch.ts", "deleted", 0, 5),
      changedFile("src/restored.ts", "deleted", 0, 4),
    ]);
    const restored = f.begin("Bring one back and edit it.");
    f.complete(restored.queued.turn.id, "Restored it.", "claude-session", [
      changedFile("src/restored.ts", "added", 4, 0),
    ]);
    const edited = f.begin("Edit the restored file.");
    f.complete(edited.queued.turn.id, "Edited it.", "claude-session", [
      changedFile("src/restored.ts", "modified", 1, 1),
    ]);
    const parsed = JSON.parse(f.filesBlock()!.content) as { files: string[] };
    expect(parsed.files).toEqual(["A src/restored.ts +9 -5", "D src/scratch.ts +5 -5"]);
  });

  it("never costs the restored messages their place and joins only in the room they leave", async () => {
    const f = await fixture();
    f.seedClaudeHistory();
    for (let index = 0; index < 40; index += 1) {
      f.store.createMessage(f.conversation.id, `Message ${index}: ${"detail ".repeat(50)}`, "user", [], null, f.tick());
    }
    const capturedAt = f.tick();
    const handoffRoute = {
      backendProfileId: "builtin:codex",
      endpointIdentity: null,
      includeUnattributed: true,
      handoff: { before: "2100-01-01T00:00:00.000Z", providerId: "codex" as const },
    };
    const plain = (capacity: number) => f.store.continuationHistory(f.conversation.id, capacity, capturedAt)!;
    const handoff = (capacity: number) => f.store.continuationHistory(f.conversation.id, capacity, capturedAt, undefined, handoffRoute)!;
    const labels = (history: ReturnType<typeof handoff>) => history.blocks.map(({ label }) => label);

    const tight = 12_000;
    expect(plain(tight).messageCount).toBeLessThan(44);
    expect(handoff(tight).messageCount).toBe(plain(tight).messageCount);
    expect(handoff(tight).omittedMessageCount).toBe(plain(tight).omittedMessageCount);
    expect(labels(handoff(tight))).not.toContain(PROVIDER_HANDOFF_FILES_LABEL);

    const roomy = 200_000;
    expect(handoff(roomy).messageCount).toBe(44);
    expect(labels(handoff(roomy))).toContain(PROVIDER_HANDOFF_FILES_LABEL);
  });

  it("caps the list by entry count and bytes and reports what it left out", async () => {
    const f = await fixture();
    const turn = f.begin("Touch many files.");
    const many = Array.from({ length: MAX_PROVIDER_HANDOFF_FILES }, (_, index) =>
      changedFile(`src/generated/${"nested/".repeat(8)}file-${index}.ts`, "added", 1, 0));
    f.complete(turn.queued.turn.id, "Generated the files.", "claude-session", many);
    const block = f.filesBlock()!;
    const parsed = JSON.parse(block.content) as { files: unknown[]; omittedFiles: number };
    expect(Buffer.byteLength(block.content)).toBeLessThanOrEqual(MAX_PROVIDER_HANDOFF_FILES_BYTES);
    expect(parsed.files.length).toBeGreaterThan(0);
    expect(parsed.files.length).toBeLessThan(MAX_PROVIDER_HANDOFF_FILES);
    expect(parsed.files.length + parsed.omittedFiles).toBe(MAX_PROVIDER_HANDOFF_FILES);
  });

  describe("usage-limit snooze", () => {
    const snoozedUntil = "2030-01-02T00:00:00.000Z";
    const stopClaude = async (usageLimited: boolean) => {
      const f = await fixture();
      f.seedClaudeHistory();
      const limited = f.begin("Run the full export.");
      f.fail(limited.queued.turn.id);
      if (usageLimited) f.store.limitResets.markUsageLimited(limited.queued.turn.id);
      f.store.updateConversation(f.conversation.id, { snoozedUntil });
      return f;
    };

    it("ends the snooze when the handoff turn starts on the new provider", async () => {
      const f = await stopClaude(true);
      await f.switchProvider("codex");
      expect(f.store.conversation(f.conversation.id).snoozedUntil).toBe(snoozedUntil);

      const handoff = f.prepare("Continue on Codex.");
      expect(handoff.queued.turn).toMatchObject({ providerId: "codex", continuationReasonCode: "harness-changed" });
      expect(f.store.conversation(f.conversation.id).snoozedUntil).toBeNull();
    });

    it("keeps a snooze when the chat did not stop at a usage limit", async () => {
      const f = await stopClaude(false);
      await f.switchProvider("codex");
      f.prepare("Continue on Codex.");
      expect(f.store.conversation(f.conversation.id).snoozedUntil).toBe(snoozedUntil);
    });

    it("keeps the snooze when the chat switches back before sending", async () => {
      const f = await stopClaude(true);
      await f.switchProvider("codex");
      await f.switchProvider("claude");
      const turn = f.prepare("Try Claude again.");
      expect(turn.queued.turn.providerId).toBe("claude");
      expect(f.store.conversation(f.conversation.id).snoozedUntil).toBe(snoozedUntil);
    });
  });
});
