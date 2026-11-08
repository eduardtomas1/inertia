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

  it("keeps live agents ahead of background commands when the live list is full", async () => {
    const { store, conversation, turn, task } = await fixture();
    const owners = [turn(conversation.id, 0), turn(conversation.id, 1)];
    for (let index = 0; index < 80; index += 1) {
      task(conversation.id, owners[index % 2]!, `shell-${index}`, 1, {
        status: "running",
        isLive: true,
        taskKind: "shell",
        background: true,
        command: `sleep ${index}`,
      });
    }
    const agents = [0, 1, 2].map((index) => task(conversation.id, owners[0]!, `agent-${index}`, 2, {
      status: "running",
      isLive: true,
    }).id);
    const live = store.backgroundTasks(conversation.id, null).subagents.filter(({ isLive }) => isLive);
    expect(live).toHaveLength(64);
    expect(live.filter(({ taskKind }) => taskKind === "agent").map(({ id }) => id).sort()).toEqual([...agents].sort());
  });

  it("persists, coalesces and scrubs the delegated task shape", async () => {
    const { store, conversation, turn, task } = await fixture();
    const owner = turn(conversation.id, 0);
    const workspace = store.conversationPath(conversation.id);
    const steps = Array.from({ length: 12 }, (_, index) => ({
      label: index === 11 ? "Bash · curl -H \"Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123\"" : `Read · step ${index}`,
      status: index === 11 ? "running" as const : "completed" as const,
    }));
    const shell = task(conversation.id, owner, "shell", 1, {
      status: "running",
      isLive: true,
      taskKind: "shell",
      background: true,
      command: `OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123 npm test --prefix ${workspace}/app\n`,
      effort: "max",
      activityId: "activity-shell",
      steps,
    });
    expect(shell).toMatchObject({
      taskKind: "shell",
      background: true,
      effort: "max",
      activityId: "activity-shell",
    });
    expect(shell.command).toBe("[redacted] npm test --prefix <workspace>/app");
    expect(shell.steps).toHaveLength(8);
    expect(shell.steps?.[0]).toEqual({ label: "Read · step 4", status: "completed" });
    expect(shell.steps?.at(-1)?.label).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123");
    expect(shell.steps?.at(-1)?.status).toBe("running");

    const coalesced = store.upsertSubagentTrace({
      conversationId: conversation.id,
      runId: owner.runId,
      turnId: owner.id,
      providerId: "codex",
      providerTaskId: "task-shell",
      providerAgentId: null,
      parentProviderAgentId: null,
      parentProviderToolUseId: null,
      providerToolUseId: null,
      providerRole: null,
      providerName: null,
      status: "running",
      isLive: true,
      description: null,
      progress: null,
      result: null,
      sequence: 2,
    })!.trace;
    expect(coalesced).toMatchObject({
      taskKind: "shell",
      background: true,
      command: shell.command,
      effort: "max",
      activityId: "activity-shell",
      steps: shell.steps,
    });

    const completed = store.upsertSubagentTrace({
      conversationId: conversation.id,
      runId: owner.runId,
      turnId: owner.id,
      providerId: "codex",
      providerTaskId: "task-shell",
      providerAgentId: null,
      parentProviderAgentId: null,
      parentProviderToolUseId: null,
      providerToolUseId: null,
      providerRole: null,
      providerName: null,
      description: null,
      progress: null,
      status: "completed",
      isLive: false,
      result: "Exit code 0",
      steps: [{ label: "Read · done", status: "completed" }],
      sequence: 3,
    })!.trace;
    expect(completed).toMatchObject({ status: "completed", isLive: false, steps: [{ label: "Read · done", status: "completed" }] });
    const revived = store.upsertSubagentTrace({
      conversationId: conversation.id,
      runId: owner.runId,
      turnId: owner.id,
      providerId: "codex",
      providerTaskId: "task-shell",
      providerAgentId: null,
      parentProviderAgentId: null,
      parentProviderToolUseId: null,
      providerToolUseId: null,
      providerRole: null,
      providerName: null,
      status: "running",
      isLive: true,
      description: null,
      progress: null,
      result: null,
      command: "rm -rf /",
      taskKind: "agent",
      sequence: 4,
    });
    expect(revived).toEqual({ trace: completed, changed: false });

    const agent = task(conversation.id, owner, "agent", 2, {
      status: "running",
      isLive: true,
      command: "agents never carry commands",
      effort: "extreme" as "max",
      activityId: "a".repeat(201),
      taskKind: "daemon" as "agent",
    });
    expect(agent).toMatchObject({ taskKind: "agent", command: null, effort: null, activityId: null, steps: null, background: null });
  });

  it("keeps an observed model over a later requested hint and skips the synthetic placeholder", async () => {
    const { store, conversation, turn, task } = await fixture();
    const owner = turn(conversation.id, 0);
    const patch = (sequence: number, model: string, modelSource?: "observed" | "requested") => store.upsertSubagentTrace({
      conversationId: conversation.id,
      runId: owner.runId,
      turnId: owner.id,
      providerId: "codex",
      providerTaskId: "task-model",
      providerAgentId: null,
      parentProviderAgentId: null,
      parentProviderToolUseId: null,
      providerToolUseId: null,
      providerRole: null,
      providerName: null,
      status: "running",
      isLive: true,
      description: null,
      progress: null,
      result: null,
      model,
      ...(modelSource ? { modelSource } : {}),
      sequence,
    })!.trace;
    expect(task(conversation.id, owner, "model", 1, { status: "running", isLive: true, model: "haiku", modelSource: "requested" }))
      .toMatchObject({ model: "haiku", modelSource: "requested" });
    expect(patch(2, "claude-haiku-4-5", "observed")).toMatchObject({ model: "claude-haiku-4-5", modelSource: "observed" });
    expect(patch(3, "sonnet", "requested")).toMatchObject({ model: "claude-haiku-4-5", modelSource: "observed" });
    expect(patch(4, "unknown-source")).toMatchObject({ model: "claude-haiku-4-5", modelSource: "observed" });
    expect(patch(5, "<synthetic>", "observed")).toMatchObject({ model: "claude-haiku-4-5", modelSource: "observed" });
    expect(patch(6, "claude-sonnet-4-5", "observed")).toMatchObject({ model: "claude-sonnet-4-5", modelSource: "observed" });
    expect(task(conversation.id, owner, "plain", 1, { model: "gpt-5" })).toMatchObject({ model: "gpt-5", modelSource: null });
  });

  it("settles live background commands as stopped and live agents as lost when the turn ends", async () => {
    const { store, conversation, turn, task } = await fixture();
    const owner = turn(conversation.id, 0);
    const shell = task(conversation.id, owner, "shell", 1, { status: "running", isLive: true, taskKind: "shell", background: true });
    const agent = task(conversation.id, owner, "agent", 1, { status: "running", isLive: true, progress: "Reading" });
    const settled = store.settleLiveSubagents(owner.id, "lost", at(2));
    expect(settled.find(({ id }) => id === shell.id)).toMatchObject({
      status: "cancelled",
      isLive: false,
      progress: "Stopped when the turn ended.",
    });
    expect(settled.find(({ id }) => id === agent.id)).toMatchObject({ status: "lost", isLive: false, progress: "Reading" });
  });

  it.each(["lost", "cancelled"] as const)("leaves a live remote agent running in the cloud when the turn ends as %s", async (status) => {
    const { store, conversation, turn, task } = await fixture();
    const owner = turn(conversation.id, 0);
    const remote = task(conversation.id, owner, "remote", 1, {
      status: "running", isLive: true, taskKind: "remote", background: true, progress: "Launched",
    });
    const [settled] = store.settleLiveSubagents(owner.id, status, at(2));
    expect(settled).toMatchObject({
      id: remote.id,
      status: "unknown",
      isLive: false,
      progress: "Running in the cloud.",
    });
    expect(store.turnLedgerRepository.runtimeInterruption(owner.id)).toMatchObject({ lostTasks: [], lostTaskCount: 0 });
  });

  it("scrubs step labels and the current activity as commands before they are bounded", async () => {
    const { conversation, turn, task } = await fixture();
    const owner = turn(conversation.id, 0);
    const long = `${"x".repeat(170)} sk_live1234567890abcdef`;
    const trace = task(conversation.id, owner, "scrub", 1, {
      status: "running",
      isLive: true,
      activity: "WebFetch · https://api.example.com/items?page=2&sig=AIzaSyA1234567890abcdef",
      steps: [
        { label: "Bash · deploy --client-secret s3cr3tvalue99 --region eu", status: "completed" },
        { label: "Bash · MY_SERVICE_KEY=hunter2hunter2 node app.js", status: "failed" },
        { label: "WebFetch · https://x.example/cb?refresh_token=abcdef1234567890XYZ", status: "completed" },
        { label: long, status: "running" },
      ],
    });
    const stored = JSON.stringify({ activity: trace.activity, steps: trace.steps });
    for (const secret of ["AIzaSy", "s3cr3tvalue99", "hunter2hunter2", "abcdef1234567890XYZ", "live12"]) {
      expect(stored).not.toContain(secret);
    }
    expect(trace.activity).toBe("WebFetch · https://api.example.com/items?page=2&sig=[redacted]");
    expect(trace.steps?.slice(0, 3).map(({ label }) => label)).toEqual([
      "Bash · deploy --client-secret [redacted] --region eu",
      "Bash · MY_SERVICE_KEY=[redacted] node app.js",
      "WebFetch · https://x.example/cb?refresh_token=[redacted]",
    ]);
  });

  it("leaves background commands possibly running when the provider's cleanup was not confirmed", async () => {
    const { store, conversation, turn, task } = await fixture();
    const owner = turn(conversation.id, 0);
    const shell = task(conversation.id, owner, "shell", 1, { status: "running", isLive: true, taskKind: "shell", background: true });
    const agent = task(conversation.id, owner, "agent", 1, { status: "running", isLive: true, progress: "Reading" });
    const remote = task(conversation.id, owner, "remote", 1, { status: "running", isLive: true, taskKind: "remote" });
    const settled = store.settleLiveSubagents(owner.id, "cancelled", at(2), true);
    expect(settled.find(({ id }) => id === shell.id)).toMatchObject({
      status: "unknown",
      isLive: false,
      progress: "May still be running: the provider did not confirm it stopped.",
    });
    expect(settled.find(({ id }) => id === agent.id)).toMatchObject({ status: "cancelled", isLive: false, progress: "Reading" });
    expect(settled.find(({ id }) => id === remote.id)).toMatchObject({ status: "unknown", progress: "Running in the cloud." });
    expect(store.turnLedgerRepository.runtimeInterruption(owner.id).lostTasks).toEqual([]);
  });

  it("lets background commands use at most half of the per-turn trace budget", async () => {
    const { conversation, turn, task } = await fixture();
    const owner = turn(conversation.id, 0);
    for (let index = 0; index < 64; index += 1) {
      task(conversation.id, owner, `shell-${index}`, 1, { taskKind: index % 2 ? "monitor" : "shell" });
    }
    expect(() => task(conversation.id, owner, "shell-overflow", 1, { taskKind: "shell" })).toThrow();
    expect(task(conversation.id, owner, "agent-after", 1).taskKind).toBe("agent");
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
