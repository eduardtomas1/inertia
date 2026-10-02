import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import type { UpsertSubagentTraceInput } from "../../src/server/persistence/types";
import { BACKGROUND_TASK_PAGE_SIZE, type BackgroundTasksResult } from "../../src/shared/background-tasks";
import { CONVERSATION_HISTORY_PAGE_SIZE } from "../../src/shared/conversation-history";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

const BASE = Date.parse("2026-01-01T00:00:00.000Z");
const at = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();
const stores: RuntimeStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "inertia-background-tasks-"));
  directories.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const databasePath = join(directory, "inertia.sqlite");
  const store = new RuntimeStore(databasePath, workspacePath, { recoverInterruptedRuns: false });
  stores.push(store);
  const project = store.createProject("Tasks", workspacePath);
  const chat = (title: string) => store.createConversation(project.id, title, {
    modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" }),
  });
  const conversation = chat("Long chat");
  const turn = (conversationId: string, minute: number) => {
    const selected = store.conversation(conversationId);
    const { turn: created } = store.beginAgentTurn({
      conversationId,
      runId: `run-${conversationId}-${minute}`,
      content: `Turn ${minute}`,
      providerId: "codex",
      modelSelection: selected.modelSelection,
      reasoningEffort: "",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: selected.modelSelection.backendConfigurationRevision,
      association: "authoritative",
      requestedAt: at(minute),
    });
    store.updateAgentTurnLifecycle(created.id, { status: "completed", startedAt: at(minute), completedAt: at(minute), updatedAt: at(minute) });
    return created;
  };
  const task = (
    conversationId: string,
    owner: { id: string; runId: string },
    name: string,
    minute: number,
    overrides: Partial<UpsertSubagentTraceInput> = {},
  ) => store.upsertSubagentTrace({
    conversationId,
    runId: owner.runId,
    turnId: owner.id,
    providerId: "codex",
    providerTaskId: `task-${name}`,
    providerAgentId: null,
    parentProviderAgentId: null,
    parentProviderToolUseId: null,
    providerToolUseId: null,
    providerRole: null,
    providerName: name,
    status: "completed",
    isLive: false,
    description: null,
    progress: null,
    result: null,
    sequence: 1,
    updatedAt: at(minute),
    ...overrides,
  })!.trace;
  return { store, project, conversation, chat, turn, task, databasePath };
}

function keys(result: BackgroundTasksResult): string[] {
  return [
    ...result.subagents.filter(({ isLive }) => !isLive).map(({ id, createdAt }) => ({ at: createdAt, key: `agent:${id}` })),
    ...result.runs.filter(({ status }) => status !== "running" && status !== "waiting")
      .map(({ id, startedAt }) => ({ at: startedAt, key: `command:${id}` })),
  ].sort((left, right) => right.at.localeCompare(left.at) || right.key.localeCompare(left.key)).map(({ key }) => key);
}

describe("background tasks for a whole chat", () => {
  it("counts and pages tasks that sit outside the loaded history window", async () => {
    const { store, conversation, turn, task } = await fixture();
    const finished: string[] = [];
    let failed = 0;
    for (let minute = 0; minute < CONVERSATION_HISTORY_PAGE_SIZE + 10; minute += 1) {
      const owner = turn(conversation.id, minute);
      if (minute < 10) {
        const status = minute % 3 === 0 ? "failed" : "completed";
        if (status === "failed") failed += 1;
        finished.push(task(conversation.id, owner, `old-${minute}`, minute, { status }).id);
      }
    }
    const loaded = store.conversationHistory(conversation.id)!;
    expect(loaded.subagents).toEqual([]);

    const first = store.backgroundTasks(conversation.id, null);
    expect(first).toMatchObject({ finishedCount: 10, failedCount: failed, next: null });
    expect(first.subagents.map(({ id }) => id).sort()).toEqual([...finished].sort());
    expect(first.subagents.every(({ model, activity, usage, toolUseCount, durationMs }) =>
      model === null && activity === null && usage === null && toolUseCount === null && durationMs === null)).toBe(true);
  });

  it("returns every live task, newest-first pages of finished ones and exact totals across hundreds", async () => {
    const { store, conversation, chat, turn, task } = await fixture();
    const other = chat("Other chat");
    const owner = turn(conversation.id, 0);
    const owners = [owner, turn(conversation.id, 1), turn(conversation.id, 2)];
    const otherTurn = turn(other.id, 0);
    task(other.id, otherTurn, "elsewhere", 1);
    const live = ["running", "waiting", "queued"].map((status, index) =>
      task(conversation.id, owner, `live-${index}`, 1, { status: status as "running", isLive: true }).id);
    for (let index = 0; index < 300; index += 1) {
      task(conversation.id, owners[index % 3]!, `done-${String(index).padStart(3, "0")}`, 2 + index, {
        status: index % 10 === 0 ? "lost" : "completed",
      });
    }
    const pages: BackgroundTasksResult[] = [store.backgroundTasks(conversation.id, null)];
    while (pages.at(-1)!.next) pages.push(store.backgroundTasks(conversation.id, pages.at(-1)!.next));
    expect(pages).toHaveLength(15);
    for (const page of pages) {
      expect(page).toMatchObject({ finishedCount: 300, failedCount: 30 });
      expect(page.subagents.filter(({ isLive }) => isLive).map(({ id }) => id).sort()).toEqual([...live].sort());
      expect(keys(page)).toHaveLength(BACKGROUND_TASK_PAGE_SIZE);
    }
    const all = pages.flatMap(keys);
    expect(new Set(all).size).toBe(300);
    const names = new Map(pages.flatMap(({ subagents }) => subagents).map(({ id, providerName }) => [`agent:${id}`, providerName]));
    expect(all.slice(0, 2).map((key) => names.get(key))).toEqual(["done-299", "done-298"]);
    expect(names.get(all.at(-1)!)).toBe("done-000");
    expect(pages.flatMap(({ subagents }) => subagents).some(({ providerName }) => providerName === "elsewhere")).toBe(false);
  });

  it("lists app-started commands like the panel and leaves turn runs and dismissed commands out", async () => {
    const { store, project, conversation, turn } = await fixture();
    turn(conversation.id, 0);
    const run = (kind: "agent" | "check" | "source-control", status: "running" | "succeeded" | "failed", label: string) =>
      store.createWorkspaceRun({ kind, projectId: project.id, conversationId: conversation.id, label, detail: null, status, port: null });
    const review = run("agent", "succeeded", "Review changes");
    const push = run("source-control", "failed", "Push");
    const live = run("source-control", "running", "Fetch");
    const dismissed = run("source-control", "succeeded", "Pull");
    store.dismissWorkspaceRun(dismissed.id);
    run("check", "succeeded", "Unnamed check");
    const result = store.backgroundTasks(conversation.id, null);
    expect(result.runs.map(({ label }) => label).sort()).toEqual(["Fetch", "Push", "Review changes"]);
    expect(result).toMatchObject({ finishedCount: 2, failedCount: 1, next: null });
    expect(result.runs.find(({ id }) => id === live.id)).toMatchObject({ status: "running" });
    expect(result.runs.some(({ id }) => id === review.id || id === push.id)).toBe(true);
  });

  it("answers an empty chat with nothing and refuses a deleted one", async () => {
    const { store, conversation } = await fixture();
    expect(store.backgroundTasks(conversation.id, null)).toEqual({
      kind: "conversation.background-tasks",
      conversationId: conversation.id,
      subagents: [],
      runs: [],
      finishedCount: 0,
      failedCount: 0,
      next: null,
    });
    store.deleteConversation(conversation.id);
    expect(() => store.backgroundTasks(conversation.id, null)).toThrow();
  });

  it("reads both tables through conversation indexes", async () => {
    const { store, databasePath } = await fixture();
    store.close();
    stores.splice(0);
    const database = new Database(databasePath, { readonly: true });
    try {
      const plan = (sql: string) => (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("c") as { detail: string }[])
        .map(({ detail }) => detail).join("\n");
      expect(plan("SELECT id FROM subagent_traces WHERE conversation_id = ? AND is_live = 0"))
        .toMatch(/USING (?:COVERING )?INDEX subagents_conversation_created_idx/u);
      expect(plan("SELECT id FROM workspace_runs WHERE conversation_id = ? ORDER BY started_at DESC"))
        .toMatch(/USING (?:COVERING )?INDEX workspace_runs_conversation_started_idx/u);
    } finally {
      database.close();
    }
  });
});
