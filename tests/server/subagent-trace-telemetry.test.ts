import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import type { UpsertSubagentTraceInput } from "../../src/server/persistence/types";
import type { SubagentTaskUsage } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { subagentTrace } from "../../src/shared/contracts/subagent-trace-schema";

const directories: string[] = [];
const stores: RuntimeStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

const EMPTY_USAGE: SubagentTaskUsage = {
  totalTokens: null,
  inputTokens: null,
  cachedInputTokens: null,
  cacheWriteInputTokens: null,
  outputTokens: null,
  reasoningOutputTokens: null,
  contextTokens: null,
  maxContextTokens: null,
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "inertia-subagent-telemetry-"));
  directories.push(directory);
  const workspacePath = join(directory, "workspace");
  await mkdir(workspacePath);
  const databasePath = join(directory, "inertia.sqlite");
  const store = new RuntimeStore(databasePath, workspacePath, { recoverInterruptedRuns: false });
  stores.push(store);
  const project = store.createProject("Telemetry", workspacePath);
  const conversation = store.createConversation(project.id, "Delegated work", {
    modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "provider-default" }),
  });
  const { turn } = store.beginAgentTurn({
    conversationId: conversation.id,
    runId: "run-telemetry",
    content: "Delegate the work.",
    providerId: "codex",
    modelSelection: conversation.modelSelection,
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    configurationRevision: conversation.modelSelection.backendConfigurationRevision,
    association: "authoritative",
  });
  const patch = (
    sequence: number,
    overrides: Partial<UpsertSubagentTraceInput> = {},
  ) => store.upsertSubagentTrace({
    conversationId: conversation.id,
    runId: turn.runId,
    turnId: turn.id,
    providerId: "codex",
    providerTaskId: null,
    providerAgentId: "child-1",
    parentProviderAgentId: null,
    parentProviderToolUseId: null,
    providerToolUseId: null,
    providerRole: null,
    providerName: "Reviewer",
    status: "running",
    isLive: true,
    description: null,
    progress: null,
    result: null,
    sequence,
    ...overrides,
  });
  return { store, databasePath, workspacePath, turn, patch };
}

describe("subagent task telemetry persistence", () => {
  it("keeps the latest reported value per field and clears activity at terminal state", async () => {
    const { store, patch } = await fixture();
    const created = patch(1, {
      model: "gpt-5.4-mini",
      activity: "Reading files",
      usage: { ...EMPTY_USAGE, totalTokens: 100, inputTokens: 80 },
      toolUseCount: 3,
      durationMs: 1_000,
    });
    expect(created?.trace).toMatchObject({
      model: "gpt-5.4-mini",
      activity: "Reading files",
      usage: { ...EMPTY_USAGE, totalTokens: 100, inputTokens: 80 },
      toolUseCount: 3,
      durationMs: 1_000,
    });

    const partial = patch(2, {
      usage: { ...EMPTY_USAGE, totalTokens: 150, outputTokens: 20 },
    });
    expect(partial).toMatchObject({ changed: true });
    expect(partial?.trace).toMatchObject({
      model: "gpt-5.4-mini",
      activity: "Reading files",
      usage: { ...EMPTY_USAGE, totalTokens: 150, inputTokens: 80, outputTokens: 20 },
      toolUseCount: 3,
      durationMs: 1_000,
    });

    const moved = patch(3, { activity: "Editing src/index.ts", toolUseCount: 5, model: "gpt-5.4" });
    expect(moved?.trace).toMatchObject({
      model: "gpt-5.4",
      activity: "Editing src/index.ts",
      toolUseCount: 5,
    });

    const completed = patch(4, {
      status: "completed",
      isLive: false,
      activity: "Still reported by the provider",
      durationMs: 5_000,
      result: "Done.",
    });
    expect(completed?.trace).toMatchObject({
      status: "completed",
      activity: null,
      durationMs: 5_000,
      toolUseCount: 5,
      usage: { ...EMPTY_USAGE, totalTokens: 150, inputTokens: 80, outputTokens: 20 },
    });

    const enriched = patch(5, {
      status: "completed",
      isLive: false,
      activity: "Late activity",
      usage: { ...EMPTY_USAGE, totalTokens: 175 },
    });
    expect(enriched?.trace).toMatchObject({
      activity: null,
      usage: { ...EMPTY_USAGE, totalTokens: 175, inputTokens: 80, outputTokens: 20 },
    });
    expect(store.snapshot().subagents).toEqual([enriched?.trace]);
  });

  it("starts a trace reported as terminal without activity", async () => {
    const { patch } = await fixture();
    expect(patch(1, {
      status: "completed",
      isLive: false,
      activity: "Finished",
      model: "composer-1",
      durationMs: 42,
    })?.trace).toMatchObject({ activity: null, model: "composer-1", durationMs: 42, usage: null });
  });

  it("rejects numbers outside the reported ranges", async () => {
    const { patch } = await fixture();
    const trace = patch(1, {
      usage: {
        totalTokens: -1,
        inputTokens: 1.5,
        cachedInputTokens: 1_000_000_000_001,
        cacheWriteInputTokens: Number.NaN,
        outputTokens: "7" as unknown as number,
        reasoningOutputTokens: 0,
        contextTokens: 900,
        maxContextTokens: 800,
      },
      toolUseCount: 1_000_001,
      durationMs: 31 * 24 * 60 * 60 * 1_000 + 1,
    })?.trace;
    expect(trace).toMatchObject({
      usage: { ...EMPTY_USAGE, reasoningOutputTokens: 0, maxContextTokens: 800 },
      toolUseCount: null,
      durationMs: null,
    });
    expect(patch(2, {
      usage: { ...EMPTY_USAGE, maxContextTokens: 0, totalTokens: -4 },
      toolUseCount: -1,
      durationMs: 1.5,
    })?.trace).toMatchObject({
      usage: { ...EMPTY_USAGE, reasoningOutputTokens: 0, maxContextTokens: 800 },
      toolUseCount: null,
      durationMs: null,
    });
    expect(patch(3, {
      usage: { ...EMPTY_USAGE, contextTokens: 700 },
      toolUseCount: 1_000_000,
      durationMs: 31 * 24 * 60 * 60 * 1_000,
    })?.trace).toMatchObject({
      usage: { ...EMPTY_USAGE, reasoningOutputTokens: 0, contextTokens: 700, maxContextTokens: 800 },
      toolUseCount: 1_000_000,
      durationMs: 31 * 24 * 60 * 60 * 1_000,
    });
  });

  it("drops stale context occupancy when a smaller context window is reported", async () => {
    const { patch } = await fixture();
    patch(1, { usage: { ...EMPTY_USAGE, contextTokens: 900, maxContextTokens: 1_000 } });
    expect(patch(2, { usage: { ...EMPTY_USAGE, maxContextTokens: 500 } })?.trace.usage)
      .toEqual({ ...EMPTY_USAGE, maxContextTokens: 500 });
  });

  it("bounds and scrubs reported model and activity text", async () => {
    const { patch, workspacePath } = await fixture();
    const trace = patch(1, {
      model: `  ${"m".repeat(300)}  `,
      activity: `Reading ${workspacePath}/src/secret.ts with\n\nkey sk-${"a".repeat(24)}`,
    })?.trace;
    expect(trace?.model?.length).toBeLessThanOrEqual(200);
    expect(trace?.model?.startsWith("m")).toBe(true);
    expect(trace?.activity).not.toContain(workspacePath);
    expect(trace?.activity).not.toContain("sk-");
    expect(trace?.activity).not.toMatch(/\n/u);
    expect(trace?.activity?.length).toBeLessThanOrEqual(200);
    expect(patch(2, { model: "   ", activity: "\0" })?.trace).toMatchObject({
      model: trace?.model,
      activity: trace?.activity,
    });
  });

  it("cuts long model and activity labels plainly on a code point boundary", async () => {
    const { patch } = await fixture();
    const emoji = "\u{1F600}";
    const trace = patch(1, {
      model: "m".repeat(10_000),
      activity: `a${emoji.repeat(150)}`,
    })?.trace;
    expect(trace?.model).toBe("m".repeat(200));
    expect(trace?.activity).toBe(`a${emoji.repeat(99)}`);
    expect(subagentTrace(trace)).toBe(true);
    expect(patch(2, { activity: emoji.repeat(150) })?.trace.activity).toBe(emoji.repeat(100));
  });

  it("clears activity when the runtime settles or stops live work", async () => {
    const { store, patch, turn } = await fixture();
    patch(1, { activity: "Running tests" });
    const stoppedId = patch(1, {
      providerAgentId: "child-2",
      activity: "Searching",
    })?.trace.id;
    expect(store.acknowledgeSubagentStop(stoppedId!)?.trace).toMatchObject({
      status: "cancelled",
      activity: null,
    });
    expect(store.settleLiveSubagents(turn.id, "lost")).toEqual([
      expect.objectContaining({ status: "lost", activity: null }),
    ]);
  });

  it("clears activity when startup recovery marks interrupted work lost", async () => {
    const { store, databasePath, workspacePath, patch } = await fixture();
    const traceId = patch(1, { activity: "Running tests", toolUseCount: 2 })?.trace.id;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const recovered = new RuntimeStore(databasePath, workspacePath);
    stores.push(recovered);
    expect(recovered.snapshot().subagents.find(({ id }) => id === traceId)).toMatchObject({
      status: "lost",
      isLive: false,
      activity: null,
      toolUseCount: 2,
    });
  });

  it("reads directly edited labels in a shape every chat can load", async () => {
    const { store, databasePath, workspacePath, patch } = await fixture();
    const traceId = patch(1, { model: "gpt-5.4", activity: "Reading" })?.trace.id;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const database = new Database(databasePath);
    try {
      database.prepare("UPDATE subagent_traces SET model = '', activity = ? WHERE id = ?")
        .run("\u{1F600}".repeat(150), traceId);
    } finally {
      database.close();
    }
    const reopened = new RuntimeStore(databasePath, workspacePath, { recoverInterruptedRuns: false });
    stores.push(reopened);
    const trace = reopened.snapshot().subagents.find(({ id }) => id === traceId);
    expect(trace).toMatchObject({ model: null, activity: "\u{1F600}".repeat(100) });
    expect(subagentTrace(trace)).toBe(true);
    expect(subagentTrace(reopened.conversationDetail(trace!.conversationId)!.subagents[0])).toBe(true);
  });

  it("reads malformed stored usage as unavailable", async () => {
    const { store, databasePath, workspacePath, patch } = await fixture();
    const traceId = patch(1, { usage: { ...EMPTY_USAGE, totalTokens: 10 } })?.trace.id;
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const database = new Database(databasePath);
    const reopen = () => {
      const reopened = new RuntimeStore(databasePath, workspacePath, { recoverInterruptedRuns: false });
      try {
        return reopened.snapshot().subagents.find(({ id }) => id === traceId)?.usage;
      } finally {
        reopened.close();
      }
    };
    try {
      for (const stored of ["[1,2]", "\"text\"", "{\"totalTokens\":\"many\"}", "{\"totalTokens\":-5}", "null"]) {
        database.prepare("UPDATE subagent_traces SET usage_json = ? WHERE id = ?").run(stored, traceId);
        expect(reopen()).toBeNull();
      }
      database.prepare("UPDATE subagent_traces SET usage_json = ? WHERE id = ?")
        .run(JSON.stringify({ totalTokens: 12, inputTokens: "x", unexpected: 4 }), traceId);
      expect(reopen()).toEqual({ ...EMPTY_USAGE, totalTokens: 12 });
      expect(() => database.prepare("UPDATE subagent_traces SET usage_json = ? WHERE id = ?")
        .run("{not json", traceId)).toThrow(/CHECK constraint/u);
      expect(() => database.prepare("UPDATE subagent_traces SET usage_json = ? WHERE id = ?")
        .run(JSON.stringify({ padding: "x".repeat(600) }), traceId)).toThrow(/CHECK constraint/u);
      expect(() => database.prepare("UPDATE subagent_traces SET tool_use_count = -1 WHERE id = ?")
        .run(traceId)).toThrow(/CHECK constraint/u);
      expect(() => database.prepare("UPDATE subagent_traces SET duration_ms = -1 WHERE id = ?")
        .run(traceId)).toThrow(/CHECK constraint/u);
      expect(() => database.prepare("UPDATE subagent_traces SET activity = ? WHERE id = ?")
        .run("a".repeat(201), traceId)).toThrow(/CHECK constraint/u);
      expect(() => database.prepare("UPDATE subagent_traces SET model = ? WHERE id = ?")
        .run("a".repeat(201), traceId)).toThrow(/CHECK constraint/u);
    } finally {
      database.close();
    }
  });
});
