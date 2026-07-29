import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  RecordNotFoundError as PublicRecordNotFoundError,
  RuntimeStore,
} from "../../src/server/database";
import {
  RecordNotFoundError as RepositoryRecordNotFoundError,
} from "../../src/server/persistence/errors";

const temporaryDirectories: string[] = [];

async function createStore(): Promise<{
  databasePath: string;
  store: RuntimeStore;
  workspacePath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-persistence-repositories-"));
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "inertia.sqlite");
  return {
    databasePath,
    store: new RuntimeStore(databasePath, workspacePath),
    workspacePath,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })),
  );
});

describe("RuntimeStore repository compatibility", () => {
  it("preserves the public not-found error constructor across repository boundaries", async () => {
    expect(PublicRecordNotFoundError).toBe(RepositoryRecordNotFoundError);
    const { store } = await createStore();
    expect(() => store.project("missing-project"))
      .toThrow(PublicRecordNotFoundError);
    store.close();
  });

  it("keeps SQL-heavy turn and migration ownership outside the public facade", async () => {
    const repositoryRoot = resolve(import.meta.dirname, "..", "..");
    const databaseSource = await readFile(
      join(repositoryRoot, "src", "server", "database.ts"),
      "utf8",
    );
    expect(databaseSource).not.toContain("CREATE TABLE");
    expect(databaseSource).not.toContain("INSERT INTO agent_turns");
    expect(databaseSource).not.toContain("UPDATE agent_turns SET");

    const repositorySources = await Promise.all([
      "turn-ledger-repository.ts",
      "execution-ledger-repository.ts",
      "git-artifact-repository.ts",
      "recovery-repository.ts",
    ].map((file) =>
      readFile(
        join(repositoryRoot, "src", "server", "persistence", file),
        "utf8",
      )));
    for (const source of repositorySources) {
      expect(source).not.toContain('from "../database"');
      expect(source).not.toContain("RuntimeStore");
    }
  });

  it("keeps project creation and active selection atomic", async () => {
    const { databasePath, store, workspacePath } = await createStore();
    const project = store.createProject("Primary", workspacePath);

    expect(project.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(project.createdAt).toBe(project.updatedAt);
    expect(store.snapshot()).toMatchObject({
      activeProjectId: project.id,
      activeConversationId: null,
    });

    const inspector = new Database(databasePath);
    inspector.exec(`
      CREATE TRIGGER reject_project_insert
      BEFORE INSERT ON projects
      BEGIN
        SELECT RAISE(ABORT, 'project insert rejected');
      END
    `);
    expect(() => store.createProject("Rejected", join(workspacePath, "rejected")))
      .toThrow(/project insert rejected/u);
    inspector.exec("DROP TRIGGER reject_project_insert");
    inspector.close();

    expect(store.snapshot()).toMatchObject({
      projects: [expect.objectContaining({ id: project.id })],
      activeProjectId: project.id,
      activeConversationId: null,
    });
    store.close();
  });

  it("keeps conversation creation, project touch, and selection atomic", async () => {
    const { databasePath, store, workspacePath } = await createStore();
    const project = store.createProject("Primary", workspacePath);
    const before = store.project(project.id);

    const inspector = new Database(databasePath);
    inspector.exec(`
      CREATE TRIGGER reject_conversation_insert
      BEFORE INSERT ON conversations
      BEGIN
        SELECT RAISE(ABORT, 'conversation insert rejected');
      END
    `);
    expect(() => store.createConversation(project.id, "Rejected"))
      .toThrow(/conversation insert rejected/u);
    inspector.exec("DROP TRIGGER reject_conversation_insert");
    inspector.close();

    expect(store.project(project.id).updatedAt).toBe(before.updatedAt);
    expect(store.snapshot()).toMatchObject({
      conversations: [],
      activeProjectId: project.id,
      activeConversationId: null,
    });

    const conversation = store.createConversation(project.id, "Accepted");
    expect(conversation.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(conversation.createdAt).toBe(conversation.updatedAt);
    expect(conversation.lastViewedAt).toBe(conversation.createdAt);
    expect(store.snapshot()).toMatchObject({
      activeProjectId: project.id,
      activeConversationId: conversation.id,
    });
    store.close();
  });

  it("keeps streamed message content and conversation activity atomic", async () => {
    const { databasePath, store, workspacePath } = await createStore();
    const project = store.createProject("Streaming", workspacePath);
    const conversation = store.createConversation(project.id, "Streaming");
    const message = store.createMessage(
      conversation.id,
      "Original response",
      "assistant",
    );
    const inspector = new Database(databasePath);
    inspector.exec(`
      CREATE TRIGGER reject_stream_conversation_touch
      BEFORE UPDATE OF updated_at ON conversations
      BEGIN
        SELECT RAISE(ABORT, 'conversation touch rejected');
      END
    `);

    expect(() => store.updateMessageContent(message.id, "Partial response"))
      .toThrow(/conversation touch rejected/u);
    expect(store.snapshot().messages.find(({ id }) => id === message.id)?.content)
      .toBe("Original response");

    inspector.exec("DROP TRIGGER reject_stream_conversation_touch");
    inspector.close();
    store.close();
  });

  it("creates a secondary conversation without stealing active selection", async () => {
    const { store, workspacePath } = await createStore();
    const primaryProject = store.createProject("Primary", workspacePath);
    const primary = store.createConversation(primaryProject.id, "Primary chat");
    const secondaryProject = store.createProject(
      "Secondary",
      join(workspacePath, "secondary"),
    );
    store.selectConversation(primary.id);

    const secondary = store.createConversation(
      secondaryProject.id,
      "Secondary chat",
      { activate: false },
    );

    expect(secondary.projectId).toBe(secondaryProject.id);
    expect(store.snapshot()).toMatchObject({
      activeProjectId: primaryProject.id,
      activeConversationId: primary.id,
      conversations: expect.arrayContaining([
        expect.objectContaining({ id: secondary.id }),
      ]),
    });
    store.close();
  });

  it("starts a secondary turn without stealing active selection", async () => {
    const { store, workspacePath } = await createStore();
    const project = store.createProject("Primary", workspacePath);
    const primary = store.createConversation(project.id, "Primary chat");
    const secondary = store.createConversation(
      project.id,
      "Secondary chat",
      { activate: false },
    );

    store.beginAgentTurn({
      id: "secondary-turn",
      conversationId: secondary.id,
      runId: "secondary-run",
      content: "Work in the secondary pane.",
      activateConversation: false,
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "codex-local",
      model: "provider-default",
      modelAlias: null,
      reasoningEffort: "",
      interactionMode: "build",
      accessMode: "supervised",
      providerSessionBefore: null,
      usageAtStart: null,
      configurationRevision: 0,
      association: "authoritative",
    });

    expect(store.snapshot()).toMatchObject({
      activeProjectId: project.id,
      activeConversationId: primary.id,
    });
    expect(
      store.conversationDetail(secondary.id)?.messages,
    ).toEqual([
      expect.objectContaining({
        role: "user",
        content: "Work in the secondary pane.",
      }),
    ]);
    store.close();
  });

  it("orders persisted transcript segments authoritatively and cascades project removal", async () => {
    const { store, workspacePath } = await createStore();
    const project = store.createProject("Primary", workspacePath);
    const conversation = store.createConversation(project.id, "Transcript");
    const user = store.createMessage(
      conversation.id,
      "Request",
      "user",
      [],
      null,
      "2026-01-01T00:00:00.000Z",
    );
    const turn = store.createAgentTurn({
      id: "turn-transcript-order",
      conversationId: conversation.id,
      runId: "run-transcript-order",
      userMessageId: user.id,
      providerId: "codex",
      harnessId: "codex-app-server",
      backendProfileId: "codex-local",
      model: "provider-default",
      modelAlias: null,
      reasoningEffort: "",
      interactionMode: "build",
      accessMode: "supervised",
      providerSessionBefore: null,
      requestedAt: "2026-01-01T00:00:00.000Z",
      usageAtStart: null,
      configurationRevision: 0,
      association: "authoritative",
    });
    store.createMessage(
      conversation.id,
      "Third segment",
      "assistant",
      [],
      turn.id,
      "2026-01-01T00:00:03.000Z",
    );
    store.createMessage(
      conversation.id,
      "First segment",
      "assistant",
      [],
      turn.id,
      "2026-01-01T00:00:01.000Z",
    );
    store.createMessage(
      conversation.id,
      "Second segment",
      "assistant",
      [],
      turn.id,
      "2026-01-01T00:00:02.000Z",
    );

    expect(
      store.conversationDetail(conversation.id)?.messages.map(({ content }) => content),
    ).toEqual([
      "Request",
      "First segment",
      "Second segment",
      "Third segment",
    ]);

    store.removeProject(project.id);
    expect(store.snapshot()).toMatchObject({
      projects: [],
      conversations: [],
      agentTurns: [],
      messages: [],
      activeProjectId: null,
      activeConversationId: null,
    });
    store.close();
  });
});
