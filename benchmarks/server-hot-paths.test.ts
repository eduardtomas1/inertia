import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { afterAll, describe, expect, it } from "vitest";

import { RuntimeStore } from "../src/server/database";
import { ClaudeRunEventBudget } from "../src/server/provider/claude-event-budget";
import { ProviderRunEventBudget } from "../src/server/provider/io";
import { storeMascotStatus } from "../src/server/runtime/mascot-status";
import { RuntimeSyncHub } from "../src/server/runtime/runtime-sync-hub";
import { RuntimeSequencer } from "../src/server/runtime-sequencing";
import {
  listWorkspaceEntries,
  searchWorkspaceContent,
  searchWorkspaceEntries,
} from "../src/server/workspace";
import {
  discoverWorkspaceGitRepositories,
  resolveWorkspaceGitRepository,
} from "../src/server/workspace-git";

interface BenchmarkRow {
  proposal: string;
  metric: string;
  iterations: number;
  medianMs: number;
  p95Ms: number;
  totalMs: number;
  cpuMs: number;
}

const rows: BenchmarkRow[] = [];
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index]!;
}

function measureSync(
  proposal: string,
  metric: string,
  iterations: number,
  fn: (index: number) => void,
  warmup = 2,
): BenchmarkRow {
  for (let i = 0; i < warmup; i += 1) fn(-1 - i);
  const samples: number[] = [];
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    fn(i);
    samples.push(performance.now() - t0);
  }
  const totalMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  samples.sort((a, b) => a - b);
  const row: BenchmarkRow = {
    proposal,
    metric,
    iterations,
    medianMs: Number(percentile(samples, 50).toFixed(3)),
    p95Ms: Number(percentile(samples, 95).toFixed(3)),
    totalMs: Number(totalMs.toFixed(2)),
    cpuMs: Number(((cpu.user + cpu.system) / 1_000).toFixed(2)),
  };
  rows.push(row);
  return row;
}

async function measureAsync(
  proposal: string,
  metric: string,
  iterations: number,
  fn: (index: number) => Promise<void>,
  warmup = 1,
): Promise<BenchmarkRow> {
  for (let i = 0; i < warmup; i += 1) await fn(-1 - i);
  const samples: number[] = [];
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    await fn(i);
    samples.push(performance.now() - t0);
  }
  const totalMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  samples.sort((a, b) => a - b);
  const row: BenchmarkRow = {
    proposal,
    metric,
    iterations,
    medianMs: Number(percentile(samples, 50).toFixed(3)),
    p95Ms: Number(percentile(samples, 95).toFixed(3)),
    totalMs: Number(totalMs.toFixed(2)),
    cpuMs: Number(((cpu.user + cpu.system) / 1_000).toFixed(2)),
  };
  rows.push(row);
  return row;
}

function initGitRepo(repoDir: string, dirty: boolean): void {
  mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "bench@example.com"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Benchmark"], { cwd: repoDir, stdio: "ignore" });
  writeFileSync(join(repoDir, "README.md"), "# benchmark repo\n", "utf8");
  writeFileSync(join(repoDir, "index.ts"), "export const answer = 42;\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoDir, stdio: "ignore" });
  if (dirty) {
    writeFileSync(join(repoDir, "index.ts"), "export const answer = 43;\nexport const extra = true;\n", "utf8");
    writeFileSync(join(repoDir, "untracked.txt"), "hello\n", "utf8");
  }
}

afterAll(() => {
  console.log("\n=== SERVER HOT PATHS BENCHMARK SUMMARY ===");
  console.log(JSON.stringify(rows, null, 2));
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("server hot paths benchmarks", () => {
  it("P1: chat-load conversationHistory (latest + older page)", () => {
    const dir = makeTempDir("inertia-bench-p1-");
    const store = new RuntimeStore(join(dir, "bench.sqlite"), dir);
    try {
      const project = store.createProject("ChatLoad", dir);
      const conversation = store.createConversation(project.id, "Heavy tool session", { providerId: "claude" });
      const largeOutput = `${"stdout line with diagnostic output 0123456789abcdef\n".repeat(450)}`;
      const baseTime = Date.UTC(2030, 0, 1, 0, 0, 0);

      for (let t = 0; t < 45; t += 1) {
        const turnAt = new Date(baseTime + t * 60_000).toISOString();
        const runId = `run-${t}`;
        const { turn } = store.beginAgentTurn({
          id: `turn-${t}`,
          runId,
          conversationId: conversation.id,
          providerId: "claude",
          modelSelection: conversation.modelSelection,
          reasoningEffort: "medium",
          interactionMode: "build",
          accessMode: "auto-edit",
          configurationRevision: conversation.modelSelection.backendConfigurationRevision,
          association: "authoritative",
          content: `User prompt for turn ${t}`,
          requestedAt: turnAt,
        });
        for (let a = 0; a < 15; a += 1) {
          store.addActivity({
            conversationId: conversation.id,
            runId,
            turnId: turn.id,
            kind: "command",
            title: `npm test -- shard ${a}`,
            detail: a % 5 === 0
              ? `${largeOutput}\nError:\nAssertion failed on shard ${a}\n${"stack frame\n".repeat(40)}`
              : largeOutput,
            status: a % 5 === 0 ? "failed" : "completed",
            createdAt: new Date(baseTime + t * 60_000 + (a + 1) * 1_000).toISOString(),
          });
        }
        const assistant = store.createMessage(
          conversation.id,
          `Assistant response for turn ${t}.`.repeat(20),
          "assistant",
          [],
          turn.id,
          new Date(baseTime + t * 60_000 + 30_000).toISOString(),
        );
        store.updateAgentTurnLifecycle(turn.id, {
          status: "completed",
          startedAt: turnAt,
          completedAt: new Date(baseTime + t * 60_000 + 35_000).toISOString(),
          terminalAssistantMessageId: assistant.id,
          updatedAt: new Date(baseTime + t * 60_000 + 35_000).toISOString(),
        });
      }
      store.upsertUsage({
        conversationId: conversation.id,
        usedTokens: 50_000,
        totalProcessedTokens: 120_000,
        totalProcessedScope: "session",
        maxTokens: 200_000,
        inputTokens: 40_000,
        cachedInputTokens: 20_000,
        cacheWriteInputTokens: 5_000,
        outputTokens: 10_000,
        reasoningOutputTokens: 2_000,
        compactsAutomatically: true,
      });

      const firstPage = store.conversationHistory(conversation.id);
      expect(firstPage).not.toBeNull();
      expect(firstPage!.activities.length).toBeGreaterThan(0);
      expect(firstPage!.history?.older).not.toBeNull();

      measureSync("P1", "conversationHistory(latest)", 30, () => {
        const res = store.conversationHistory(conversation.id);
        expect(res?.agentTurns.length).toBeGreaterThan(0);
      });

      const olderCursor = firstPage!.history!.older!;
      measureSync("P1", "conversationHistory(before)", 30, () => {
        const res = store.conversationHistory(conversation.id, { before: olderCursor });
        expect(res?.agentTurns.length).toBeGreaterThan(0);
      });
    } finally {
      store.close();
    }
  });

  it("P2: shellSnapshot + hot persistence writes (upsertSubagentTrace, updateActivity)", () => {
    const dir = makeTempDir("inertia-bench-p2-");
    const store = new RuntimeStore(join(dir, "bench.sqlite"), dir);
    try {
      const project = store.createProject("SnapshotHeavy", dir);
      const baseTime = Date.UTC(2030, 1, 1, 0, 0, 0);
      let hotConversationId = "";
      let hotTurnId = "";
      let hotRunId = "";

      for (let i = 0; i < 150; i += 1) {
        const conv = store.createConversation(project.id, `Chat ${i}`, { providerId: "claude" });
        const at = new Date(baseTime + i * 1_000).toISOString();
        const runId = `run-${i}`;
        const { turn } = store.beginAgentTurn({
          id: `turn-${i}`,
          runId,
          conversationId: conv.id,
          providerId: "claude",
          modelSelection: conv.modelSelection,
          reasoningEffort: "medium",
          interactionMode: "build",
          accessMode: "auto-edit",
          configurationRevision: conv.modelSelection.backendConfigurationRevision,
          association: "authoritative",
          content: `Hello ${i}`,
          requestedAt: at,
        });
        store.updateAgentTurnLifecycle(turn.id, {
          status: "completed",
          startedAt: at,
          completedAt: new Date(baseTime + i * 1_000 + 500).toISOString(),
          updatedAt: new Date(baseTime + i * 1_000 + 500).toISOString(),
        });
        if (i === 0) {
          hotConversationId = conv.id;
          hotTurnId = turn.id;
          hotRunId = runId;
        }
      }

      for (let i = 0; i < 80; i += 1) {
        store.todos.create({
          id: randomUUID(),
          title: `Task item ${i}`,
          note: "Follow up details",
          projectId: project.id,
        });
      }
      for (let i = 0; i < 15; i += 1) {
        store.promptPresets.create({
          name: `Preset ${i}`,
          body: `Analyze module ${i} carefully.`,
          route: null,
        });
      }

      measureSync("P2", "shellSnapshot(150 chats, 80 todos, 15 presets)", 40, () => {
        const snap = store.shellSnapshot();
        expect(snap.conversations.length).toBe(150);
      });

      const activity = store.addActivity({
        conversationId: hotConversationId,
        runId: hotRunId,
        turnId: hotTurnId,
        kind: "command",
        title: "Streaming command",
        detail: "x".repeat(8_192),
        status: "running",
      });

      measureSync("P2", "updateActivity(x500)", 1, () => {
        for (let i = 0; i < 500; i += 1) {
          store.updateActivity(activity.id, {
            title: "Streaming command",
            detail: `chunk-${i}:${"y".repeat(4_096)}`,
            status: "running",
          });
        }
      }, 0);

      measureSync("P2", "upsertSubagentTrace(x300)", 1, () => {
        for (let i = 1; i <= 300; i += 1) {
          store.upsertSubagentTrace({
            conversationId: hotConversationId,
            runId: hotRunId,
            turnId: hotTurnId,
            providerId: "claude",
            providerTaskId: "task-hot-1",
            providerAgentId: "agent-hot-1",
            parentProviderAgentId: null,
            parentProviderToolUseId: null,
            providerToolUseId: null,
            providerRole: null,
            providerName: null,
            status: "running",
            isLive: true,
            sequence: i,
            description: null,
            progress: `Step ${i} running`,
            result: null,
            activity: `Reading file ${i}.ts`,
          });
        }
      }, 0);
    } finally {
      store.close();
    }
  });

  it("P4: mascot observe + ClaudeRunEventBudget + RuntimeSyncHub broadcast", () => {
    const dir = makeTempDir("inertia-bench-p4-");
    const store = new RuntimeStore(join(dir, "bench.sqlite"), dir);
    try {
      const project = store.createProject("StreamHot", dir);
      const conv = store.createConversation(project.id, "Active streaming chat", { providerId: "claude" });
      const at = new Date(Date.UTC(2030, 2, 1, 0, 0, 0)).toISOString();
      const { turn } = store.beginAgentTurn({
        id: "turn-stream",
        runId: "run-stream",
        conversationId: conv.id,
        providerId: "claude",
        modelSelection: conv.modelSelection,
        reasoningEffort: "medium",
        interactionMode: "build",
        accessMode: "auto-edit",
        configurationRevision: conv.modelSelection.backendConfigurationRevision,
        association: "authoritative",
        content: "Stream test",
        requestedAt: at,
      });
      store.updateAgentTurnLifecycle(turn.id, {
        status: "running",
        startedAt: at,
        updatedAt: at,
      });

      let feedCount = 0;
      const mascot = storeMascotStatus(() => { feedCount += 1; }, () => store);
      mascot.replace(store.shellSnapshot().conversations, store.projects(), []);

      measureSync("P4", "mascot.observe(2000 agent.activity)", 1, () => {
        for (let i = 0; i < 2_000; i += 1) {
          mascot.observe({
            type: "agent.activity",
            activity: {
              id: `act-${i}`,
              conversationId: conv.id,
              runId: "run-stream",
              turnId: turn.id,
              kind: "command",
              title: `Running step ${i}`,
              detail: "output",
              status: "running",
              createdAt: new Date(Date.UTC(2030, 2, 1, 0, 0, 1) + i).toISOString(),
            },
          });
        }
      }, 0);
      mascot.close();
      expect(feedCount).toBeGreaterThanOrEqual(0);

      const providerBudget = new ProviderRunEventBudget(
        "Claude",
        1024 * 1024,
        100_000,
        256 * 1024 * 1024,
        { maxRunEvents: 100_000, maxRunBytes: 256 * 1024 * 1024 },
      );
      const claudeBudget = new ClaudeRunEventBudget(providerBudget);
      measureSync("P4", "ClaudeRunEventBudget.observe(5000 deltas)", 1, () => {
        for (let i = 0; i < 5_000; i += 1) {
          claudeBudget.observe({
            type: "stream_event",
            uuid: `uuid-${i}`,
            session_id: "sess-1",
            parent_tool_use_id: null,
            event: {
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "text_delta",
                text: `token-${i} streaming response payload `,
              },
            },
          });
        }
      }, 0);

      const sequencer = new RuntimeSequencer({ maxReplayEvents: 2_048, maxReplayBytes: 4 * 1024 * 1024 });
      let sent = 0;
      const hub = new RuntimeSyncHub<object>(() => { sent += 1; }, sequencer);
      const client = {};
      hub.connect(
        client,
        { kind: "none" },
        {
          snapshot: () => store.shellSnapshot(),
          approvals: [],
          inputs: [],
          plans: [],
        },
      );
      hub.setConversationSubscription(client, "primary", conv.id);

      const otherConvId = randomUUID();
      measureSync("P4", "RuntimeSyncHub.broadcast(10000 events)", 1, () => {
        for (let i = 0; i < 10_000; i += 1) {
          hub.broadcast({
            type: "agent.text",
            conversationId: i % 2 === 0 ? conv.id : otherConvId,
            runId: "run-stream",
            turnId: turn.id,
            text: `delta text chunk ${i} `,
          });
        }
      }, 0);
      expect(sent).toBeGreaterThan(10_000);
    } finally {
      store.close();
    }
  });

  it("P5: workspace traversal, file search & content search", async () => {
    const dir = makeTempDir("inertia-bench-p5-");
    const fileContent = `${"export function computeMetrics(input: number): number { return input * 2; }\n".repeat(80)}`;
    for (let d = 0; d < 20; d += 1) {
      const sub = join(dir, `pkg-${d}`, "src");
      mkdirSync(sub, { recursive: true });
      for (let f = 0; f < 30; f += 1) {
        const needleLine = f === 15 ? "\n// TARGET_NEEDLE_MATCH_TOKEN here\n" : "";
        writeFileSync(join(sub, `module-${f}.ts`), `${fileContent}${needleLine}`, "utf8");
      }
    }

    await measureAsync("P5", "listWorkspaceEntries(root/pkg-0/src)", 20, async () => {
      const list = await listWorkspaceEntries(dir, "pkg-0/src");
      expect(list.entries.length).toBe(30);
    });

    await measureAsync("P5", "searchWorkspaceEntries(600 files)", 10, async () => {
      const res = await searchWorkspaceEntries(dir, "module-15");
      expect(res.entries.length).toBe(20);
    });

    await measureAsync("P5", "searchWorkspaceContent(600 files)", 10, async () => {
      const res = await searchWorkspaceContent(dir, "TARGET_NEEDLE_MATCH_TOKEN");
      expect(res.matches.length).toBe(20);
    });
  });

  it("P6: workspace git discovery & repository resolution", async () => {
    const dir = makeTempDir("inertia-bench-p6-");
    for (let i = 0; i < 8; i += 1) {
      initGitRepo(join(dir, `repo-${i}`), i % 2 === 1);
    }

    await measureAsync("P6", "discoverWorkspaceGitRepositories(8 repos: 4 clean, 4 dirty)", 5, async () => {
      const snap = await discoverWorkspaceGitRepositories(dir);
      expect(snap.repositories.length).toBe(8);
    });

    const cleanRepoDir = join(dir, "repo-0");
    await measureAsync("P6", "resolveWorkspaceGitRepository(clean root)", 5, async () => {
      const resolved = await resolveWorkspaceGitRepository(cleanRepoDir, ".");
      expect(resolved.status.clean).toBe(true);
    });
  });
});
