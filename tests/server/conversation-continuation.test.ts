import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerEvent } from "../../src/shared/contracts";
import {
  modelSelectionSchema,
  providerNativeModelSelection,
} from "../../src/shared/model-routing";
import { RuntimeStore } from "../../src/server/database";
import { inspectProjectIdentity } from "../../src/server/project-identity";
import { TurnController } from "../../src/server/runtime/turns/turn-controller";
import {
  createConversationCommandHandler,
  type ConversationCommandDependencies,
} from "../../src/server/runtime/commands/conversation-commands";
import { removeTemporaryDirectory } from "../helpers/temporary-directory";
import { resolveNativeModelRoute } from "./model-route-fixture";

const temporaryDirectories: string[] = [];
const socket = {} as WebSocket;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(removeTemporaryDirectory));
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function selection(providerId: "codex" | "claude", modelId: string) {
  return modelSelectionSchema.parse(providerNativeModelSelection({
    providerId,
    modelId,
    alias: modelId,
    reasoningEffort: "high",
  }));
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "inertia-continuation-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const dataDirectory = join(root, "data");
  mkdirSync(workspace);
  mkdirSync(dataDirectory);
  execFileSync("git", ["init", "-b", "main", workspace]);
  writeFileSync(join(workspace, "tracked.txt"), "main\n");
  git(workspace, "add", "tracked.txt");
  git(workspace, "-c", "user.name=Inertia Test", "-c", "user.email=inertia@example.invalid", "commit", "-m", "initial");
  const store = new RuntimeStore(join(dataDirectory, "inertia.sqlite"), workspace, { recoverInterruptedRuns: false });
  const project = store.createProject("Continuation project", workspace, await inspectProjectIdentity(workspace));
  const running = new Set<string>();
  const hooks: { validateSelection?: () => void } = {};
  const events: ServerEvent[] = [];
  const providers = {
    resolveModelRoute: resolveNativeModelRoute,
    isRunning: (conversationId: string) => running.has(conversationId),
  };
  const turns = new TurnController(store, providers as never, new Map(), new Map(), new Map(), {
    broadcast: () => undefined,
    broadcastSnapshot: () => undefined,
    providerInfo: () => [],
  });
  const dependencies = {
    store,
    conversationAttachments: { release: vi.fn(async () => undefined) },
    providers,
    turns,
    backendProfileController: {
      validateSelection: (value: unknown) => {
        hooks.validateSelection?.();
        return value;
      },
    },
    workspaceRuns: {
      trackSourceControl: async (
        _label: string,
        _projectId: string,
        _conversationId: string,
        _root: string,
        _requestId: string,
        operation: () => Promise<unknown>,
      ) => await operation(),
    },
    providerTerminalResumes: {
      acquireAtCheckout: () => true,
      release: () => undefined,
      isActive: () => false,
    },
    runtimeSync: { broadcast: vi.fn() },
    deletedConversationIds: new Set<string>(),
    dataDirectory,
    rememberDeletedConversation: vi.fn(),
    forgetRemoteTranscript: vi.fn(),
    broadcastSnapshot: vi.fn(),
    publicError: (error: unknown) => String(error),
    send: (_socket: WebSocket, event: ServerEvent) => { events.push(event); },
  } as unknown as ConversationCommandDependencies;
  const handler = createConversationCommandHandler(dependencies);
  const created = (requestId: string): string => {
    const event = events.find((candidate) => candidate.type === "request.result" && candidate.requestId === requestId);
    if (event?.type !== "request.result" || event.result.kind !== "conversation.created") {
      throw new Error("The command did not report a created chat.");
    }
    return event.result.conversationId;
  };
  const createSource = async (useWorktree: boolean): Promise<string> => {
    const requestId = randomUUID();
    await handler(socket, {
      type: "conversation.create",
      requestId,
      payload: {
        projectId: project.id,
        title: "Source chat",
        modelSelection: selection("codex", "gpt-test"),
        activate: false,
        useWorktree,
      },
    });
    return created(requestId);
  };
  const seedHistory = (conversationId: string, complete = true): void => {
    const user = store.createMessage(conversationId, "Fix the parser.", "user");
    const turn = store.createAgentTurn({
      conversationId,
      runId: randomUUID(),
      userMessageId: user.id,
      providerId: "codex",
      modelSelection: selection("codex", "gpt-test"),
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: 0,
      association: "authoritative",
    });
    store.createMessage(conversationId, "The parser is fixed.", "assistant", [], turn.id);
    if (!complete) return;
    const now = new Date().toISOString();
    store.updateAgentTurnLifecycle(turn.id, { status: "completed", startedAt: now, completedAt: now, updatedAt: now });
  };
  const continueChat = async (sourceConversationId: string): Promise<string> => {
    const requestId = randomUUID();
    await handler(socket, {
      type: "conversation.continue",
      requestId,
      payload: {
        sourceConversationId,
        modelSelection: selection("claude", "claude-test"),
        accessMode: "auto-edit",
        interactionMode: "plan",
      },
    });
    return created(requestId);
  };
  const deleteChat = async (conversationId: string): Promise<void> => {
    await handler(socket, { type: "conversation.delete", requestId: randomUUID(), payload: { conversationId } });
  };
  const sendFirstMessage = (conversationId: string): void => {
    const [packet] = store.contextPackets.list(conversationId);
    store.contextPackets.createUserMessageWithPackets({
      conversationId, content: "Carry on.", attachments: [], packetIds: [packet!.id], requestId: randomUUID(),
    });
  };
  return { store, workspace, project, running, hooks, handler, turns, deleteChat, sendFirstMessage, createSource, seedHistory, continueChat };
}

describe("continuing a chat with another model", () => {
  it("opens the new chat on the project checkout with the whole chat bound as context", async () => {
    const { store, project, createSource, seedHistory, continueChat } = await fixture();
    try {
      const sourceId = await createSource(false);
      seedHistory(sourceId);

      const continuedId = await continueChat(sourceId);

      expect(store.conversation(continuedId)).toMatchObject({
        projectId: project.id,
        providerId: "claude",
        branch: "main",
        worktreePath: null,
        accessMode: "auto-edit",
        interactionMode: "plan",
        providerSessionId: null,
      });
      const packets = store.contextPackets.list(continuedId);
      expect(packets).toHaveLength(1);
      expect(packets[0]).toMatchObject({
        sourceConversationId: sourceId,
        targetConversationId: continuedId,
        workspaceRelation: "same-workspace",
        messageCount: 2,
        consumedMessageId: null,
        sourceState: "available",
      });
      expect(store.contextPackets.list(sourceId)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("opens the new chat in the source's worktree, refuses to delete the source before the first send and hands the worktree over after it", async () => {
    const { store, createSource, seedHistory, continueChat, deleteChat, sendFirstMessage } = await fixture();
    try {
      const sourceId = await createSource(true);
      const source = store.conversation(sourceId);
      expect(source.worktreePath).not.toBeNull();
      seedHistory(sourceId);

      const continuedId = await continueChat(sourceId);

      expect(store.conversation(continuedId)).toMatchObject({
        branch: source.branch,
        worktreePath: source.worktreePath,
      });
      expect(store.contextPackets.list(continuedId)).toMatchObject([{
        sourceConversationId: sourceId,
        workspaceRelation: "same-workspace",
        messageCount: 2,
      }]);

      await expect(deleteChat(sourceId)).rejects.toThrow(
        "A new chat continues from this one. Send its first message or remove the context first.",
      );
      expect(store.shellSnapshot().conversations).toHaveLength(2);
      expect(store.conversationWorktrees.get(sourceId)).toMatchObject({ ownsWorktree: true });
      expect(store.contextPackets.list(continuedId)).toHaveLength(1);

      sendFirstMessage(continuedId);
      await deleteChat(sourceId);

      expect(store.shellSnapshot().conversations.map(({ id }) => id)).toEqual([continuedId]);
      expect(existsSync(source.worktreePath!)).toBe(true);
      expect(store.conversationWorktrees.get(continuedId)).toMatchObject({
        ownsWorktree: true,
        path: source.worktreePath,
      });
      expect(store.contextPackets.list(continuedId)).toMatchObject([{
        sourceConversationId: sourceId,
        consumedMessageId: expect.any(String),
        sourceState: "deleted",
      }]);
    } finally {
      store.close();
    }
  });

  it("keeps the worktree with the source when the new chat is deleted first", async () => {
    const { store, createSource, seedHistory, continueChat, deleteChat } = await fixture();
    try {
      const sourceId = await createSource(true);
      const source = store.conversation(sourceId);
      seedHistory(sourceId);
      const continuedId = await continueChat(sourceId);

      await deleteChat(continuedId);

      expect(store.shellSnapshot().conversations.map(({ id }) => id)).toEqual([sourceId]);
      expect(existsSync(source.worktreePath!)).toBe(true);
      expect(store.conversationWorktrees.get(sourceId)).toMatchObject({
        ownsWorktree: true,
        path: source.worktreePath,
      });
    } finally {
      store.close();
    }
  });

  it("refuses while a message for the source is still being prepared", async () => {
    const { store, turns, createSource, seedHistory, continueChat } = await fixture();
    try {
      const sourceId = await createSource(false);
      seedHistory(sourceId);
      const sending = await turns.acquireTurnAdmission(sourceId, 1_000);
      expect(sending).not.toBeNull();

      await expect(continueChat(sourceId)).rejects.toThrow("Wait for this chat's turn to finish");
      expect(store.shellSnapshot().conversations).toHaveLength(1);

      sending!.release();
      await expect(continueChat(sourceId)).resolves.toEqual(expect.any(String));
    } finally {
      store.close();
    }
  });

  it("makes a message sent after the continuation began wait until the new chat exists", async () => {
    const { store, turns, createSource, seedHistory, continueChat } = await fixture();
    try {
      const sourceId = await createSource(false);
      seedHistory(sourceId);
      let sendAdmitted = false;
      let admittedBeforeSave: boolean | null = null;
      const save = store.createConversation.bind(store);
      vi.spyOn(store, "createConversation").mockImplementation((...args) => {
        admittedBeforeSave = sendAdmitted;
        return save(...args);
      });

      const continuation = continueChat(sourceId);
      const send = turns.acquireTurnAdmission(sourceId, 5_000).then((lease) => {
        sendAdmitted = lease !== null;
        return lease;
      });
      const continuedId = await continuation;
      const lease = await send;

      expect(admittedBeforeSave).toBe(false);
      expect(lease).not.toBeNull();
      expect(store.contextPackets.list(continuedId)).toHaveLength(1);
      lease!.release();
    } finally {
      store.close();
    }
  });

  it("refuses while the source chat has a turn in progress", async () => {
    const { store, running, createSource, seedHistory, continueChat } = await fixture();
    try {
      const sourceId = await createSource(false);
      seedHistory(sourceId, false);
      await expect(continueChat(sourceId)).rejects.toThrow("Wait for this chat's turn to finish");

      const idleId = await createSource(false);
      seedHistory(idleId);
      running.add(idleId);
      await expect(continueChat(idleId)).rejects.toThrow("Wait for this chat's turn to finish");

      expect(store.shellSnapshot().conversations).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("creates nothing when a turn starts after the first check", async () => {
    const { store, running, hooks, createSource, seedHistory, continueChat } = await fixture();
    try {
      const sourceId = await createSource(false);
      seedHistory(sourceId);
      hooks.validateSelection = () => running.add(sourceId);

      await expect(continueChat(sourceId)).rejects.toThrow("Wait for this chat's turn to finish");

      expect(store.shellSnapshot().conversations.map(({ id }) => id)).toEqual([sourceId]);
    } finally {
      store.close();
    }
  });

  it("creates nothing when the source has no message to carry", async () => {
    const { store, createSource, continueChat } = await fixture();
    try {
      const sourceId = await createSource(false);

      await expect(continueChat(sourceId)).rejects.toThrow("That chat has no shareable messages yet.");

      expect(store.shellSnapshot().conversations.map(({ id }) => id)).toEqual([sourceId]);
    } finally {
      store.close();
    }
  });

  it("refuses a chat without a project, whose folder belongs to that chat", async () => {
    const { store, handler, seedHistory, continueChat } = await fixture();
    try {
      await handler(socket, { type: "project.ensure-scratch", requestId: randomUUID(), payload: {} });
      const scratch = store.shellSnapshot().projects.find(({ workspaceKind }) => workspaceKind === "scratch")!;
      const requestId = randomUUID();
      await handler(socket, {
        type: "conversation.create",
        requestId,
        payload: { projectId: scratch.id, title: "Scratch chat", modelSelection: selection("codex", "gpt-test"), activate: false },
      });
      const sourceId = store.shellSnapshot().conversations.find(({ projectId }) => projectId === scratch.id)!.id;
      seedHistory(sourceId);

      await expect(continueChat(sourceId)).rejects.toThrow("A chat without a project cannot continue in a new chat.");

      expect(store.shellSnapshot().conversations).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("refuses when the project checkout is now on another branch", async () => {
    const { store, workspace, createSource, seedHistory, continueChat } = await fixture();
    try {
      const sourceId = await createSource(false);
      seedHistory(sourceId);
      git(workspace, "switch", "-c", "elsewhere");

      await expect(continueChat(sourceId)).rejects.toThrow("The project checkout is currently on elsewhere, not main.");

      expect(store.shellSnapshot().conversations).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
