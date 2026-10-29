import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import {
  AgentSecretRequestError,
  type CreateAgentSecretRequestInput,
} from "../../src/server/persistence/agent-secret-request-repository";
import { chatMessageSchema } from "../../src/shared/contracts/chat-message-schema";
import { secretRequestPlaceholderText, type SecretRequestReference } from "../../src/shared/agent-secrets";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

const directories: string[] = [];
const stores: RuntimeStore[] = [];
const TOKEN = "0123456789abcdef0123456789abcdef";
const EXPIRES_AT = "2026-10-30T10:00:00.000Z";

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function openStore() {
  const directory = await mkdtemp(join(tmpdir(), "inertia-agent-secrets-"));
  directories.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const databasePath = join(directory, "inertia.sqlite");
  const store = new RuntimeStore(databasePath, workspacePath, { recoverInterruptedRuns: false });
  stores.push(store);
  const project = store.createProject("Secrets", workspacePath);
  const conversation = store.createConversation(project.id, "Tailscale", {
    modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" }),
  });
  return { store, databasePath, conversation, turn: beginTurn(store, conversation.id) };
}

function beginTurn(store: RuntimeStore, conversationId: string) {
  const conversation = store.conversation(conversationId);
  return store.beginAgentTurn({
    conversationId,
    runId: randomUUID(),
    content: "Set up the test VMs.",
    providerId: "codex",
    modelSelection: conversation.modelSelection,
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    configurationRevision: conversation.modelSelection.backendConfigurationRevision,
    association: "authoritative",
  }).turn;
}

function settle(store: RuntimeStore, turnId: string): void {
  const now = new Date().toISOString();
  store.settleAgentTurn(turnId, {
    status: "completed",
    terminalAssistantMessageId: null,
    providerSessionAfter: null,
    terminalReason: "provider-completed",
    checkpointId: null,
    usageAtCompletion: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  });
}

function input(turn: { conversationId: string; runId: string; id: string }, overrides: Partial<CreateAgentSecretRequestInput> = {}): CreateAgentSecretRequestInput {
  return {
    conversationId: turn.conversationId,
    runId: turn.runId,
    turnId: turn.id,
    providerId: "codex",
    title: "Tailscale auth key",
    description: "Create a reusable, ephemeral key.\nAdmin console > Settings > Keys.",
    fileName: "tailscale-authkey",
    ttlHours: 6,
    ...overrides,
  };
}

function expectCode(action: () => unknown, code: AgentSecretRequestError["code"]): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AgentSecretRequestError);
  expect((caught as AgentSecretRequestError).code).toBe(code);
}

function storedReference(databasePath: string, messageId: string): SecretRequestReference {
  const database = new Database(databasePath, { readonly: true });
  try {
    return JSON.parse(database.prepare("SELECT secret_request_json FROM messages WHERE id = ?").pluck().get(messageId) as string);
  } finally {
    database.close();
  }
}

describe("AgentSecretRequestRepository", () => {
  it("creates a pending request and its turn-scoped system message in an active turn", async () => {
    const { store, databasePath, turn } = await openStore();
    const { request, message } = store.transcriptRepository.secretRequests.create(input(turn));
    expect(request).toMatchObject({
      conversationId: turn.conversationId,
      turnId: turn.id,
      messageId: message.id,
      status: "pending",
      fileToken: null,
      vaulted: false,
      answeredAt: null,
      expiresAt: null,
    });
    const reference: SecretRequestReference = {
      requestId: request.id,
      title: "Tailscale auth key",
      description: "Create a reusable, ephemeral key.\nAdmin console > Settings > Keys.",
      ttlHours: 6,
      status: "pending",
      answeredAt: null,
      expiresAt: null,
      storage: null,
    };
    expect(message).toMatchObject({
      role: "system",
      turnId: turn.id,
      content: secretRequestPlaceholderText("Tailscale auth key"),
      secretRequest: reference,
    });
    expect(chatMessageSchema(message)).toBe(true);
    expect(store.message(message.id)).toEqual(message);
    expect(storedReference(databasePath, message.id)).toEqual(reference);
    expect(store.transcriptRepository.secretRequests.pendingAll().map(({ id }) => id)).toEqual([request.id]);
    expect(store.transcriptRepository.secretRequests.find(request.id)).toEqual(request);
  });

  it("refuses a settled turn and enforces one pending request per chat and three per turn", async () => {
    const { store, turn } = await openStore();
    const requests = store.transcriptRepository.secretRequests;
    const first = requests.create(input(turn)).request;
    expectCode(() => requests.create(input(turn)), "conversation-pending-limit");
    requests.transition(first.id, ["pending"], "declined");
    requests.transition(requests.create(input(turn)).request.id, ["pending"], "ended");
    requests.create(input(turn));
    expect(requests.forConversation(turn.conversationId)).toHaveLength(3);
    requests.transition(requests.pendingAll()[0]!.id, ["pending"], "declined");
    expectCode(() => requests.create(input(turn)), "turn-limit");
    settle(store, turn.id);
    const next = beginTurn(store, turn.conversationId);
    settle(store, next.id);
    expectCode(() => requests.create(input(next)), "turn-inactive");
    expect(requests.forConversation(turn.conversationId)).toHaveLength(3);
  });

  it("lets the first answer win and never turns a saved secret into a declined one", async () => {
    const { store, databasePath, turn } = await openStore();
    const requests = store.transcriptRepository.secretRequests;
    const { request } = requests.create(input(turn));
    const saved = requests.transition(request.id, ["pending"], "saved", {
      fileToken: TOKEN,
      expiresAt: EXPIRES_AT,
      vaulted: true,
    });
    expect(saved?.request).toMatchObject({ status: "saved", fileToken: TOKEN, expiresAt: EXPIRES_AT, vaulted: true });
    expect(saved?.message.secretRequest).toMatchObject({ status: "saved", expiresAt: EXPIRES_AT, storage: "keychain" });
    expect(saved?.message.secretRequest?.answeredAt).toEqual(saved?.request.answeredAt);
    expect(requests.transition(request.id, ["pending"], "declined")).toBeNull();
    expect(requests.transition(request.id, ["pending"], "saved", { fileToken: TOKEN, expiresAt: EXPIRES_AT, vaulted: false })).toBeNull();
    expect(() => requests.transition(request.id, ["saved"], "declined")).toThrow("Invalid secret request transition.");
    expect(requests.activeSaved().map(({ id }) => id)).toEqual([request.id]);
    const revoked = requests.transition(request.id, ["saved"], "revoked");
    expect(revoked?.message.secretRequest).toMatchObject({ status: "revoked", expiresAt: EXPIRES_AT, storage: "keychain" });
    expect(storedReference(databasePath, request.messageId)).toEqual(revoked?.message.secretRequest);
    expect(requests.transition(request.id, ["saved"], "expired")).toBeNull();
    expect(requests.activeSaved()).toEqual([]);
  });

  it("validates the saved fields and reports a memory-only secret", async () => {
    const { store, turn } = await openStore();
    const requests = store.transcriptRepository.secretRequests;
    const { request } = requests.create(input(turn));
    expect(() => requests.transition(request.id, ["pending"], "saved", { fileToken: "ABC", expiresAt: EXPIRES_AT, vaulted: true }))
      .toThrow("Invalid secret file token.");
    expect(() => requests.transition(request.id, ["pending"], "saved", { fileToken: TOKEN, vaulted: true }))
      .toThrow("Invalid saved secret fields.");
    expect(() => requests.transition(request.id, ["pending"], "declined", { fileToken: TOKEN }))
      .toThrow("Only a saved secret records its file and expiry.");
    const saved = requests.transition(request.id, ["pending"], "saved", { fileToken: TOKEN, expiresAt: EXPIRES_AT, vaulted: false });
    expect(saved?.message.secretRequest?.storage).toBe("memory");
    const expired = requests.transition(request.id, ["saved"], "expired");
    expect(expired?.message.secretRequest).toMatchObject({ status: "expired", storage: "memory", expiresAt: EXPIRES_AT });
  });

  it("rewrites the message JSON in the same transaction as the status", async () => {
    const { store, databasePath, turn } = await openStore();
    const requests = store.transcriptRepository.secretRequests;
    const { request, message } = requests.create(input(turn));
    const blocker = new Database(databasePath);
    blocker.exec(`CREATE TRIGGER block_secret_message BEFORE UPDATE OF secret_request_json ON messages
      BEGIN SELECT RAISE(ABORT, 'blocked'); END`);
    try {
      expect(() => requests.transition(request.id, ["pending"], "declined")).toThrow("blocked");
    } finally {
      blocker.exec("DROP TRIGGER block_secret_message");
      blocker.close();
    }
    expect(requests.find(request.id)?.status).toBe("pending");
    expect(storedReference(databasePath, message.id).status).toBe("pending");
    const declined = requests.transition(request.id, ["pending"], "declined");
    expect(declined?.request.status).toBe("declined");
    expect(storedReference(databasePath, message.id)).toMatchObject({ status: "declined", storage: null, expiresAt: null });
    expect(store.message(message.id).secretRequest?.status).toBe("declined");
  });

  it("cascades with the conversation", async () => {
    const { store, databasePath, turn } = await openStore();
    const requests = store.transcriptRepository.secretRequests;
    const { request } = requests.create(input(turn));
    requests.transition(request.id, ["pending"], "saved", { fileToken: TOKEN, expiresAt: EXPIRES_AT, vaulted: true });
    settle(store, turn.id);
    store.deleteConversation(turn.conversationId);
    expect(requests.find(request.id)).toBeNull();
    expect(requests.forConversation(turn.conversationId)).toEqual([]);
    const database = new Database(databasePath, { readonly: true });
    try {
      expect(database.prepare("SELECT COUNT(*) FROM agent_secret_requests").pluck().get()).toBe(0);
      expect(database.pragma("foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }
  });
});
