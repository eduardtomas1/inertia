import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import {
  CustomAgentRepository,
  CustomAgentRepositoryError,
} from "../../src/server/persistence/custom-agent-repository";
import { customAgentsSchemaIsValid } from "../../src/server/persistence/custom-agents-schema";
import { createCustomAgentCommandHandler } from "../../src/server/runtime/commands/custom-agent-commands";
import type { ClientCommand } from "../../src/shared/contracts";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import { publicRuntimeError, userCorrectableRuntimeError } from "../../src/server/runtime-errors";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { customAgentCollectionCoherent } from "../../src/shared/contracts/server-event-discriminants";
import {
  MAX_CUSTOM_AGENTS,
  type CustomAgentCallAttribution,
  type CustomAgentDraft,
} from "../../src/shared/custom-agents";

const PNG_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const directories: string[] = [];
const stores: RuntimeStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function openStore() {
  const directory = await mkdtemp(join(tmpdir(), "inertia-custom-agents-"));
  directories.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const databasePath = join(directory, "inertia.sqlite");
  const store = new RuntimeStore(databasePath, workspacePath, { recoverInterruptedRuns: false });
  stores.push(store);
  return { store, databasePath, workspacePath };
}

function draft(overrides: Partial<CustomAgentDraft> = {}): CustomAgentDraft {
  return {
    name: "Reviewer",
    handle: "reviewer",
    description: "Reads the patch before it ships.",
    icon: { kind: "symbol", name: "shield" },
    accent: "teal",
    blocks: [
      { id: randomUUID(), kind: "role", body: "You review patches." },
      { id: randomUUID(), kind: "must", body: "- Cite files\n- Be brief" },
    ],
    skills: ["code-review"],
    ...overrides,
  };
}

function expectCode(action: () => unknown, code: CustomAgentRepositoryError["code"]): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CustomAgentRepositoryError);
  expect((caught as CustomAgentRepositoryError).code).toBe(code);
}

describe("CustomAgentRepository", () => {
  it("migrates the table, trigger, unique handle and attribution columns", async () => {
    const { store, databasePath } = await openStore();
    store.close();
    stores.splice(0);
    const database = new Database(databasePath, { readonly: true });
    try {
      expect((database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version)
        .toBe(CURRENT_DATABASE_SCHEMA_VERSION);
      expect(customAgentsSchemaIsValid(database)).toBe(true);
      const columns = (table: string) => (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map(({ name }) => name);
      expect(columns("custom_agents")).toEqual([
        "id", "name", "handle", "description", "icon_json", "accent", "blocks_json", "skills_json",
        "position", "revision", "created_at", "updated_at",
      ]);
      expect(columns("messages")).toContain("custom_agent_call_json");
      expect(columns("subagent_traces")).toContain("custom_agent_id");
    } finally {
      database.close();
    }
  });

  it("creates, reads, updates, duplicates, reorders and deletes agents", async () => {
    const { store } = await openStore();
    const agents = store.customAgents();
    const reviewer = agents.create(draft(), { onHandleConflict: "reject" });
    const writer = agents.create(draft({ name: "Writer", handle: "writer", accent: null }), { onHandleConflict: "reject" });
    expect(reviewer).toMatchObject({ position: 0, revision: 1, handle: "reviewer" });
    expect(agents.get(reviewer.id)).toEqual(reviewer);
    expect(agents.getByHandle("writer")).toEqual(writer);
    expect(agents.get(randomUUID())).toBeNull();
    expect(agents.getByHandle("nobody")).toBeNull();

    const updated = agents.update(reviewer.id, 1, { name: "Strict reviewer", accent: null, skills: [] });
    expect(updated).toMatchObject({ name: "Strict reviewer", accent: null, skills: [], revision: 2, handle: "reviewer" });
    expect(updated.blocks).toEqual(reviewer.blocks);

    const copy = agents.duplicate(reviewer.id, 2);
    expect(copy).toMatchObject({ name: "Strict reviewer copy", handle: "reviewer-2", position: 1, revision: 1 });
    expect(copy.blocks.map(({ kind, body }) => ({ kind, body }))).toEqual(updated.blocks.map(({ kind, body }) => ({ kind, body })));
    expect(copy.blocks.map(({ id }) => id)).not.toEqual(updated.blocks.map(({ id }) => id));
    expect(agents.list().map(({ id, position }) => [id, position])).toEqual([
      [reviewer.id, 0], [copy.id, 1], [writer.id, 2],
    ]);

    const reordered = agents.reorder([reviewer.id, copy.id, writer.id], [writer.id, reviewer.id, copy.id]);
    expect(reordered.map(({ id, position }) => [id, position])).toEqual([
      [writer.id, 0], [reviewer.id, 1], [copy.id, 2],
    ]);
    expectCode(() => agents.reorder([reviewer.id, copy.id, writer.id], [reviewer.id, copy.id, writer.id]), "stale");

    agents.delete(reviewer.id, 2);
    expect(agents.list().map(({ id, position }) => [id, position])).toEqual([[writer.id, 0], [copy.id, 1]]);
    expect(customAgentCollectionCoherent(agents.list())).toBe(true);
    expect(store.shellSnapshot().customAgents).toEqual(agents.list());
    expect(store.snapshot().customAgents).toEqual(agents.list());
  });

  it("keeps handles unique, renaming only when asked", async () => {
    const { store } = await openStore();
    const agents = store.customAgents();
    const first = agents.create(draft(), { onHandleConflict: "reject" });
    expectCode(() => agents.create(draft({ name: "Other" }), { onHandleConflict: "reject" }), "handle-taken");
    expect(agents.create(draft({ name: "Other" }), { onHandleConflict: "rename" }).handle).toBe("reviewer-2");
    expect(agents.create(draft({ name: "Third" }), { onHandleConflict: "rename" }).handle).toBe("reviewer-3");
    const writer = agents.create(draft({ name: "Writer", handle: "writer" }), { onHandleConflict: "reject" });
    expectCode(() => agents.update(writer.id, writer.revision, { handle: "reviewer" }), "handle-taken");
    expect(agents.update(first.id, first.revision, { handle: "reviewer" }).revision).toBe(2);
    const long = "a".repeat(32);
    agents.create(draft({ name: "Long", handle: long }), { onHandleConflict: "reject" });
    expect(agents.create(draft({ name: "Long two", handle: long }), { onHandleConflict: "rename" }).handle)
      .toBe(`${"a".repeat(30)}-2`);
    try {
      agents.create(draft({ name: "Dup" }), { onHandleConflict: "reject" });
    } catch (error) {
      expect(userCorrectableRuntimeError(error)).toBe(true);
      expect(publicRuntimeError(error)).toBe("Another agent already uses @reviewer. Pick a different handle.");
    }
  });

  it("rejects stale revisions, missing agents and invalid drafts", async () => {
    const { store } = await openStore();
    const agents = store.customAgents();
    const agent = agents.create(draft(), { onHandleConflict: "reject" });
    agents.update(agent.id, 1, { description: "" });
    expectCode(() => agents.update(agent.id, 1, { name: "Late" }), "stale");
    expectCode(() => agents.duplicate(agent.id, 1), "stale");
    expectCode(() => agents.delete(agent.id, 1), "stale");
    expectCode(() => agents.delete(randomUUID(), 1), "missing");
    expectCode(() => agents.update(agent.id, 2, { name: "Two\nlines" }), "invalid");
    expectCode(() => agents.create(draft({ handle: "Bad Handle" }), { onHandleConflict: "rename" }), "invalid");
    expect(agents.get(agent.id)).toMatchObject({ revision: 2, description: "" });
  });

  it("enforces the agent count limit in the repository and in SQL", async () => {
    const { store, databasePath } = await openStore();
    const agents = store.customAgents();
    for (let index = 0; index < MAX_CUSTOM_AGENTS; index += 1) {
      agents.create(draft({ name: `Agent ${index}`, handle: `agent-${index}` }), { onHandleConflict: "reject" });
    }
    expectCode(() => agents.create(draft({ handle: "overflow" }), { onHandleConflict: "reject" }), "limit");
    const last = agents.list()[MAX_CUSTOM_AGENTS - 1]!;
    expectCode(() => agents.duplicate(last.id, last.revision), "limit");
    const raw = new Database(databasePath);
    try {
      const repository = new CustomAgentRepository(raw);
      expect(repository.list()).toHaveLength(MAX_CUSTOM_AGENTS);
      expect(() => raw.prepare(`
        INSERT INTO custom_agents (id, name, handle, icon_json, position, created_at, updated_at)
        VALUES (?, 'Overflow', 'overflow', '{"kind":"symbol","name":"bot"}', 39, ?, ?)
      `).run(randomUUID(), new Date().toISOString(), new Date().toISOString())).toThrow(/count limit/u);
    } finally {
      raw.close();
    }
  });

  it("round-trips a small PNG icon and rejects oversized images", async () => {
    const { store } = await openStore();
    const agents = store.customAgents();
    const agent = agents.create(draft({ icon: { kind: "image", data: PNG_ICON } }), { onHandleConflict: "reject" });
    expect(agents.get(agent.id)?.icon).toEqual({ kind: "image", data: PNG_ICON });
    const header = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header, 0);
    header.writeUInt32BE(13, 8);
    header.write("IHDR", 12, "ascii");
    header.writeUInt32BE(65, 16);
    header.writeUInt32BE(65, 20);
    const oversized = `data:image/png;base64,${header.toString("base64")}`;
    expectCode(() => agents.update(agent.id, agent.revision, { icon: { kind: "image", data: oversized } }), "invalid");
  });

  it("routes the five commands through the repository as snapshot mutations", async () => {
    const { store } = await openStore();
    const handler = createCustomAgentCommandHandler({ store });
    const socket = {} as Parameters<typeof handler>[0];
    const run = (command: Omit<ClientCommand, "requestId">) =>
      handler(socket, { ...command, requestId: randomUUID() } as ClientCommand);
    expect(handler.commandTypes).toEqual([
      "custom-agent.create",
      "custom-agent.update",
      "custom-agent.duplicate",
      "custom-agent.delete",
      "custom-agent.reorder",
    ]);
    await expect(run({ type: "custom-agent.create", payload: { agent: draft(), onHandleConflict: "reject" } } as never)).resolves.toBe("mutation");
    await expect(run({ type: "custom-agent.create", payload: { agent: draft(), onHandleConflict: "rename" } } as never)).resolves.toBe("mutation");
    await expect(run({ type: "custom-agent.create", payload: { agent: draft(), onHandleConflict: "reject" } } as never))
      .rejects.toBeInstanceOf(CustomAgentRepositoryError);
    const [first, second] = store.customAgents().list();
    await expect(run({ type: "custom-agent.update", payload: { agentId: first!.id, expectedRevision: 1, name: "Renamed" } } as never)).resolves.toBe("mutation");
    await expect(run({ type: "custom-agent.duplicate", payload: { agentId: second!.id, expectedRevision: 1 } } as never)).resolves.toBe("mutation");
    const ids = store.customAgents().list().map(({ id }) => id);
    await expect(run({ type: "custom-agent.reorder", payload: { expectedAgentIds: ids, agentIds: [...ids].reverse() } } as never)).resolves.toBe("mutation");
    await expect(run({ type: "custom-agent.delete", payload: { agentId: first!.id, expectedRevision: 2 } } as never)).resolves.toBe("mutation");
    expect(store.customAgents().list().map(({ handle }) => handle)).toEqual(["reviewer-3", "reviewer-2"]);
    await expect(run({ type: "todo.delete", payload: { id: randomUUID() } } as never)).resolves.toBe("not-handled");
  });

  it("round-trips message attribution and subagent trace identities", async () => {
    const { store, databasePath, workspacePath } = await openStore();
    const agent = store.customAgents().create(draft({ icon: { kind: "image", data: PNG_ICON } }), { onHandleConflict: "reject" });
    const project = store.createProject("Agents", workspacePath);
    const conversation = store.createConversation(project.id, "Calling", {
      modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" }),
    });
    const call: CustomAgentCallAttribution = {
      agentId: agent.id,
      revision: agent.revision,
      handle: agent.handle,
      name: agent.name,
      icon: agent.icon,
      accent: agent.accent,
      delivery: "subagent",
    };
    const { message, turn } = store.beginAgentTurn({
      conversationId: conversation.id,
      runId: "run-custom-agent",
      content: "@reviewer check this",
      providerId: "codex",
      modelSelection: conversation.modelSelection,
      reasoningEffort: "",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: conversation.modelSelection.backendConfigurationRevision,
      association: "authoritative",
      customAgentCall: call,
    });
    expect(message.customAgentCall).toEqual(call);
    const plain = store.createMessage(conversation.id, "Done.", "assistant", [], turn.id);
    expect(plain.customAgentCall).toBeUndefined();
    expect(() => store.createMessage(conversation.id, "Bad", "assistant", [], turn.id, undefined, {
      customAgentCall: { ...call, handle: "Not A Handle" },
    })).toThrow(/custom agent attribution/u);

    const traceInput = {
      conversationId: conversation.id,
      runId: "run-custom-agent",
      turnId: turn.id,
      providerId: "codex" as const,
      providerTaskId: "task-1",
      providerAgentId: null,
      parentProviderAgentId: null,
      parentProviderToolUseId: null,
      providerToolUseId: null,
      providerRole: null,
      providerName: "inertia-reviewer",
      status: "running" as const,
      isLive: true,
      description: null,
      progress: null,
      result: null,
      sequence: 1,
    };
    const created = store.upsertSubagentTrace({ ...traceInput, customAgentId: agent.id });
    expect(created?.trace.customAgentId).toBe(agent.id);
    const updated = store.upsertSubagentTrace({ ...traceInput, status: "completed", isLive: false, sequence: 2 });
    expect(updated?.trace.customAgentId).toBe(agent.id);
    const other = store.upsertSubagentTrace({ ...traceInput, providerTaskId: "task-2", customAgentId: "nope" });
    expect(other?.trace).not.toHaveProperty("customAgentId");

    const raw = new Database(databasePath);
    try {
      raw.prepare("UPDATE messages SET custom_agent_call_json = ? WHERE id = ?")
        .run(JSON.stringify({ agentId: "not-a-uuid" }), plain.id);
    } finally {
      raw.close();
    }
    const detail = store.conversationDetail(conversation.id)!;
    expect(detail.messages.find(({ id }) => id === message.id)?.customAgentCall).toEqual(call);
    expect(detail.messages.find(({ id }) => id === plain.id)).not.toHaveProperty("customAgentCall");
    expect(detail.subagents.find(({ providerTaskId }) => providerTaskId === "task-1")?.customAgentId).toBe(agent.id);
  });
});
