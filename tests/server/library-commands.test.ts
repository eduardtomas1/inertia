import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { LibraryRepositoryError } from "../../src/server/persistence/library-repository";
import { createLibraryCommandHandler } from "../../src/server/runtime/commands/library-commands";
import {
  projectDetachedChatSnapshot,
  projectRuntimeFrameForAuthority,
} from "../../src/server/runtime/detached-chat-runtime-projection";
import {
  detachedChatCommandRejection,
  type DetachedChatRuntimePolicyResources,
} from "../../src/server/runtime/detached-chat-runtime-policy";
import type { RuntimeClientAuthority } from "../../src/server/runtime/runtime-client-authority";
import { runtimeMutationScope } from "../../src/server/runtime-sequencing";
import type { AppSnapshot, ClientCommand, RuntimeMutationEvent, RuntimeSequencedFrame, ServerEvent } from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts/app";
import type { LibrarySnapshot, SavedAnswer } from "../../src/shared/library";

const roots: string[] = [];
const stores: RuntimeStore[] = [];
const socket = {} as WebSocket;

type CommandWithoutId = ClientCommand extends infer Command
  ? Command extends ClientCommand ? Omit<Command, "requestId"> : never
  : never;

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "inertia-library-commands-"));
  roots.push(root);
  const store = new RuntimeStore(join(root, "inertia.sqlite"), root, { recoverInterruptedRuns: false });
  stores.push(store);
  const project = store.createProject("Library", root);
  const conversation = store.createConversation(project.id, "Bread");
  const at = "2030-01-01T00:00:00.000Z";
  const { turn } = store.beginAgentTurn({
    id: "turn-1", runId: "run-1", conversationId: conversation.id, content: "Bake bread",
    providerId: "codex", harnessId: "codex-app-server", backendProfileId: "native:codex:app-server",
    model: "gpt-test", reasoningEffort: "high", interactionMode: "build", accessMode: "supervised",
    configurationRevision: 1, association: "authoritative", requestedAt: at,
  });
  const message = store.createMessage(conversation.id, "Knead it.", "assistant", [], turn.id, at);
  store.updateAgentTurnLifecycle(turn.id, {
    status: "completed", startedAt: at, completedAt: at, updatedAt: at, terminalAssistantMessageId: message.id,
  });
  const broadcasts: RuntimeMutationEvent[] = [];
  const events: ServerEvent[] = [];
  const handler = createLibraryCommandHandler({
    store,
    broadcast: vi.fn((event: RuntimeMutationEvent) => { broadcasts.push(event); }),
    send: vi.fn((_socket: WebSocket, event: ServerEvent) => { events.push(event); }),
  });
  const run = async (command: CommandWithoutId) => {
    broadcasts.length = 0;
    events.length = 0;
    const requestId = randomUUID();
    const disposition = await handler(socket, { ...command, requestId } as ClientCommand);
    return { disposition, requestId, broadcasts: [...broadcasts], events: [...events] };
  };
  return { store, conversation, turn, message, handler, run };
}

describe("library commands", () => {
  it("owns every library command", () => {
    const { handler } = fixture();
    expect(handler.commandTypes).toEqual([
      "library.category.create",
      "library.category.rename",
      "library.category.delete",
      "library.answer.save",
      "library.answer.update",
      "library.answer.remove",
      "library.pages.list",
    ]);
  });

  it("publishes the library before answering each mutation", async () => {
    const { store, conversation, turn, message, run } = fixture();
    const created = await run({ type: "library.category.create", payload: { name: "Bread" } });
    const category = store.library.categories()[0]!;
    expect(created).toMatchObject({
      disposition: "handled",
      broadcasts: [{ type: "library.updated", library: { categories: [category], savedAnswers: [] } }],
      events: [{ type: "request.result", requestId: created.requestId, result: { kind: "library.category", category } }],
    });
    const renamed = await run({ type: "library.category.rename", payload: { categoryId: category.id, name: "Loaves" } });
    expect(renamed.events[0]).toMatchObject({ result: { kind: "library.category", category: { id: category.id, name: "Loaves" } } });
    const saved = await run({
      type: "library.answer.save",
      payload: { conversationId: conversation.id, turnId: turn.id, messageId: message.id, categoryId: category.id },
    });
    const answer = store.library.savedAnswers()[0]!;
    expect(saved.events).toEqual([{ type: "request.result", requestId: saved.requestId, result: { kind: "library.answer", savedAnswer: answer } }]);
    expect(saved.broadcasts).toEqual([{ type: "library.updated", library: store.library.snapshot() }]);
    const updated = await run({ type: "library.answer.update", payload: { savedAnswerId: answer.id, title: "Kneading" } });
    expect(updated.events[0]).toMatchObject({ result: { kind: "library.answer", savedAnswer: { id: answer.id, title: "Kneading" } } });
    const deleted = await run({ type: "library.category.delete", payload: { categoryId: category.id } });
    expect(deleted.events).toEqual([{ type: "request.ok", requestId: deleted.requestId }]);
    expect(store.library.savedAnswers()[0]!.categoryId).toBeNull();
    const removed = await run({ type: "library.answer.remove", payload: { savedAnswerId: answer.id } });
    expect(removed.events).toEqual([{ type: "request.ok", requestId: removed.requestId }]);
    expect(removed.broadcasts).toEqual([{ type: "library.updated", library: { categories: [], savedAnswers: [] } }]);
  });

  it("answers the pages read without publishing", async () => {
    const { run } = fixture();
    const listed = await run({ type: "library.pages.list", payload: {} });
    expect(listed.broadcasts).toEqual([]);
    expect(listed.events).toEqual([{ type: "request.result", requestId: listed.requestId, result: { kind: "library.pages", pages: [] } }]);
  });

  it("rejects without publishing when the repository refuses", async () => {
    const { run } = fixture();
    await expect(run({ type: "library.category.delete", payload: { categoryId: randomUUID() } }))
      .rejects.toBeInstanceOf(LibraryRepositoryError);
  });

  it("scopes library events to the shell", () => {
    expect(runtimeMutationScope({ type: "library.updated", library: { categories: [], savedAnswers: [] } }))
      .toEqual({ kind: "shell" });
  });
});

const CONVERSATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_CONVERSATION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PROJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CATEGORY = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OWN_ANSWER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const FOREIGN_ANSWER = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const REQUEST = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-11-03T10:00:00.000Z";

const authority: RuntimeClientAuthority = { kind: "detached-chat", conversationId: CONVERSATION, clientId: "window-1" };

function savedAnswer(id: string, conversationId: string): SavedAnswer {
  return {
    id, conversationId, projectId: PROJECT, turnId: `${conversationId}-turn`, messageId: `${id}-message`,
    categoryId: CATEGORY, title: "Saved", excerpt: "", createdAt: NOW, updatedAt: NOW,
  };
}

const library: LibrarySnapshot = {
  categories: [{ id: CATEGORY, name: "Recipes", createdAt: NOW, updatedAt: NOW }],
  savedAnswers: [savedAnswer(OWN_ANSWER, CONVERSATION), savedAnswer(FOREIGN_ANSWER, OTHER_CONVERSATION)],
};

function snapshot(): AppSnapshot {
  return {
    projects: [{ id: PROJECT, name: "Scoped", path: "/scoped" }] as AppSnapshot["projects"],
    conversations: [
      { id: CONVERSATION, projectId: PROJECT },
      { id: OTHER_CONVERSATION, projectId: PROJECT },
    ] as AppSnapshot["conversations"],
    runs: [],
    providers: [],
    settings: { ...defaultSettings },
    library,
    activeProjectId: PROJECT,
    activeConversationId: CONVERSATION,
  };
}

function resources(): DetachedChatRuntimePolicyResources {
  const current = snapshot();
  return {
    snapshot: () => current,
    subagentConversationId: () => null,
    checkpointConversationId: () => null,
    turnConversationId: (turnId) => turnId === `${CONVERSATION}-turn` ? CONVERSATION : OTHER_CONVERSATION,
    savedAnswerConversationId: (savedAnswerId) =>
      library.savedAnswers.find(({ id }) => id === savedAnswerId)?.conversationId ?? null,
    duoLaunchConversationIds: () => null,
    pendingApproval: () => null,
    pendingInput: () => null,
    secretRequestConversationId: () => null,
  };
}

describe("detached chat library authority", () => {
  it("keeps every category but only the window's own saved answers", () => {
    expect(projectDetachedChatSnapshot(snapshot(), CONVERSATION).library).toEqual({
      categories: library.categories,
      savedAnswers: [library.savedAnswers[0]],
    });
    expect(projectDetachedChatSnapshot({ ...snapshot(), library: undefined }, CONVERSATION)).not.toHaveProperty("library");
    const frame: Extract<RuntimeSequencedFrame, { type: "runtime.event" }> = {
      type: "runtime.event",
      sync: { runtimeGeneration: "runtime-1", latestSequence: 4 },
      scope: { kind: "shell" },
      event: { type: "library.updated", library },
    };
    const subscription = { conversationIds: [] };
    expect(projectRuntimeFrameForAuthority(frame, subscription, authority)).toEqual({
      ...frame,
      event: { type: "library.updated", library: { categories: library.categories, savedAnswers: [library.savedAnswers[0]] } },
    });
    expect(projectRuntimeFrameForAuthority(frame, subscription, { kind: "main" })).toBe(frame);
  });

  it("allows saving and editing only the window's own answers and creating categories", () => {
    const rejection = (command: ClientCommand, scope: RuntimeClientAuthority = authority) =>
      detachedChatCommandRejection(scope, command, resources());
    const allowed: ClientCommand[] = [
      { type: "library.category.create", requestId: REQUEST, payload: { name: "Mine" } },
      { type: "library.answer.save", requestId: REQUEST, payload: { conversationId: CONVERSATION, turnId: `${CONVERSATION}-turn`, messageId: "m", categoryId: null } },
      { type: "library.answer.update", requestId: REQUEST, payload: { savedAnswerId: OWN_ANSWER, categoryId: null } },
      { type: "library.answer.remove", requestId: REQUEST, payload: { savedAnswerId: OWN_ANSWER } },
    ];
    const refused: ClientCommand[] = [
      { type: "library.category.rename", requestId: REQUEST, payload: { categoryId: CATEGORY, name: "Renamed" } },
      { type: "library.category.delete", requestId: REQUEST, payload: { categoryId: CATEGORY } },
      { type: "library.pages.list", requestId: REQUEST, payload: {} },
      { type: "library.answer.save", requestId: REQUEST, payload: { conversationId: OTHER_CONVERSATION, turnId: `${OTHER_CONVERSATION}-turn`, messageId: "m", categoryId: null } },
      { type: "library.answer.save", requestId: REQUEST, payload: { conversationId: CONVERSATION, turnId: `${OTHER_CONVERSATION}-turn`, messageId: "m", categoryId: null } },
      { type: "library.answer.update", requestId: REQUEST, payload: { savedAnswerId: FOREIGN_ANSWER, title: "Stolen" } },
      { type: "library.answer.remove", requestId: REQUEST, payload: { savedAnswerId: FOREIGN_ANSWER } },
      { type: "library.answer.remove", requestId: REQUEST, payload: { savedAnswerId: REQUEST } },
    ];
    for (const command of allowed) expect(rejection(command)).toBeNull();
    for (const command of refused) {
      expect(rejection(command)).not.toBeNull();
      expect(rejection(command, { kind: "main" })).toBeNull();
    }
  });

  it("checks saved answer ownership with one lookup instead of the app snapshot", () => {
    let snapshots = 0;
    const lookups: string[] = [];
    const counting: DetachedChatRuntimePolicyResources = {
      ...resources(),
      snapshot: () => {
        snapshots += 1;
        return snapshot();
      },
      savedAnswerConversationId: (savedAnswerId) => {
        lookups.push(savedAnswerId);
        return savedAnswerId === OWN_ANSWER ? CONVERSATION : null;
      },
    };
    expect(detachedChatCommandRejection(authority, { type: "library.answer.update", requestId: REQUEST, payload: { savedAnswerId: OWN_ANSWER, title: "Mine" } }, counting)).toBeNull();
    expect(detachedChatCommandRejection(authority, { type: "library.answer.remove", requestId: REQUEST, payload: { savedAnswerId: FOREIGN_ANSWER } }, counting)).not.toBeNull();
    expect(lookups).toEqual([OWN_ANSWER, FOREIGN_ANSWER]);
    expect(snapshots).toBe(0);
  });
});
