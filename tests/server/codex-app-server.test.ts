import { readFileSync, realpathSync } from "node:fs";
import { join, normalize } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ProviderManager,
  type ProviderAccessMode,
  type ProviderApprovalEvent,
  type ProviderGoalClearedEvent,
  type ProviderGoalSnapshot,
  type ProviderGoalUpdatedEvent,
  type ProviderSubagentEvent,
} from "../../src/server/providers";
import { startCodexAppServerRun } from "../../src/server/codex-app-server";
import {
  CODEX_METADATA_MAX_FRAME_BYTES,
  readCodexMetadata,
} from "../../src/server/codex-metadata";
import { terminateProcessTreeAndWait } from "../../src/server/process-lifecycle";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  waitFor,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

describe.sequential("Codex App Server runtime", () => {
  const roots: string[] = [];
  const managers: ProviderManager[] = [];
  const originalCapturePath = process.env.INERTIA_APP_SERVER_CAPTURE;
  const originalApprovalKind = process.env.INERTIA_APP_SERVER_APPROVAL_KIND;
  const originalOversize = process.env.INERTIA_APP_SERVER_OVERSIZE;
  const originalScenario = process.env.INERTIA_APP_SERVER_SCENARIO;
  const originalChildPid = process.env.INERTIA_APP_SERVER_CHILD_PID;

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
    if (originalCapturePath === undefined) delete process.env.INERTIA_APP_SERVER_CAPTURE;
    else process.env.INERTIA_APP_SERVER_CAPTURE = originalCapturePath;
    if (originalApprovalKind === undefined) delete process.env.INERTIA_APP_SERVER_APPROVAL_KIND;
    else process.env.INERTIA_APP_SERVER_APPROVAL_KIND = originalApprovalKind;
    if (originalOversize === undefined) delete process.env.INERTIA_APP_SERVER_OVERSIZE;
    else process.env.INERTIA_APP_SERVER_OVERSIZE = originalOversize;
    if (originalScenario === undefined) delete process.env.INERTIA_APP_SERVER_SCENARIO;
    else process.env.INERTIA_APP_SERVER_SCENARIO = originalScenario;
    if (originalChildPid === undefined) delete process.env.INERTIA_APP_SERVER_CHILD_PID;
    else process.env.INERTIA_APP_SERVER_CHILD_PID = originalChildPid;
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  function trackedManager(command: string, cancelGraceMs?: number): ProviderManager {
    const manager = new ProviderManager({
      commands: { codex: command },
      ...(cancelGraceMs === undefined ? {} : { cancelGraceMs }),
      resolveBackendLaunchOptions: (_input, environment) => ({
        environment: {
          ...environment,
          // These values belong only to the executable fixture. Production
          // launches continue to receive the provider-scoped allowlist.
          ...(process.env.INERTIA_APP_SERVER_CAPTURE
            ? { INERTIA_APP_SERVER_CAPTURE: process.env.INERTIA_APP_SERVER_CAPTURE }
            : {}),
          ...(process.env.INERTIA_APP_SERVER_APPROVAL_KIND
            ? { INERTIA_APP_SERVER_APPROVAL_KIND: process.env.INERTIA_APP_SERVER_APPROVAL_KIND }
            : {}),
          ...(process.env.INERTIA_APP_SERVER_OVERSIZE
            ? { INERTIA_APP_SERVER_OVERSIZE: process.env.INERTIA_APP_SERVER_OVERSIZE }
            : {}),
          ...(process.env.INERTIA_APP_SERVER_SCENARIO
            ? { INERTIA_APP_SERVER_SCENARIO: process.env.INERTIA_APP_SERVER_SCENARIO }
            : {}),
          ...(process.env.INERTIA_APP_SERVER_CHILD_PID
            ? { INERTIA_APP_SERVER_CHILD_PID: process.env.INERTIA_APP_SERVER_CHILD_PID }
            : {}),
        },
      }),
    });
    managers.push(manager);
    return manager;
  }

  function fakeAppServer(): { root: string; command: string; capturePath: string } {
    const root = portableFixtureRoot("app server");
    roots.push(root);
    const command = portableNodeExecutable(root, "codex");
    const capturePath = join(root, "capture.jsonl");
    writeNodeSubcommand(root, "app-server", `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const capture = (value) => fs.appendFileSync(process.env.INERTIA_APP_SERVER_CAPTURE, JSON.stringify(value) + "\\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const sendBatch = (values) => process.stdout.write(values.map((value) => JSON.stringify(value)).join("\\n") + "\\n");
if (process.env.INERTIA_APP_SERVER_SCENARIO === "transport-observed") {
  process.stdout.on("error", () => {});
}
const approvalMethod = process.env.INERTIA_APP_SERVER_APPROVAL_KIND === "file-change"
  ? "item/fileChange/requestApproval"
  : process.env.INERTIA_APP_SERVER_APPROVAL_KIND === "permissions"
    ? "item/permissions/requestApproval"
    : process.env.INERTIA_APP_SERVER_APPROVAL_KIND === "legacy-command"
      ? "execCommandApproval"
      : process.env.INERTIA_APP_SERVER_APPROVAL_KIND === "legacy-file-change"
        ? "applyPatchApproval"
    : "item/commandExecution/requestApproval";
let threadId = "thread-new";
let turnId = "turn-1";
const requestInput = () => send({
  id: "input-rpc",
  method: "item/tool/requestUserInput",
  params: {
    threadId,
    turnId,
    itemId: "input-item",
    autoResolutionMs: null,
    questions: [{
      id: "choice",
      header: "Direction",
      question: "Which path should Codex take?",
      isOther: true,
      isSecret: false,
      options: [{ label: "Safe", description: "Use the bounded path." }],
    }],
  },
});
const complete = () => {
  if (process.env.INERTIA_APP_SERVER_SCENARIO === "goal-events") {
    const goal = {
      threadId,
      objective: "Ship native goals safely",
      status: "active",
      tokenBudget: 40000,
      tokensUsed: 1250,
      timeUsedSeconds: 42,
      createdAt: 1800000000,
      updatedAt: 1800000010,
    };
    send({ method: "thread/goal/updated", params: { threadId, turnId, goal } });
    send({ method: "thread/goal/updated", params: {
      threadId,
      goal: { ...goal, status: "invented" },
    } });
    send({ method: "thread/goal/updated", params: {
      threadId: "thread-unrelated",
      goal: { ...goal, threadId: "thread-unrelated" },
    } });
    send({ method: "thread/goal/cleared", params: { threadId: "thread-unrelated" } });
    send({ method: "thread/goal/cleared", params: { threadId } });
  }
  send({ method: "turn/plan/updated", params: { threadId, turnId, explanation: "A native plan", plan: [{ step: "Inspect", status: "completed" }, { step: "Implement", status: "inProgress" }] } });
  send({ method: "item/reasoning/summaryTextDelta", params: { threadId, turnId, itemId: "reasoning-1", summaryIndex: 0, delta: "Checking the safest path." } });
  send({ method: "item/started", params: { threadId, turnId, item: { id: "command-1", type: "commandExecution", command: "npm test" } } });
  send({ method: "item/completed", params: { threadId, turnId, item: { id: "command-1", type: "commandExecution", command: "npm test", aggregatedOutput: "passed" } } });
  send({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: { totalTokens: 11839, inputTokens: 11833, cachedInputTokens: 3456, outputTokens: 6, reasoningOutputTokens: 0 }, last: { totalTokens: 126, inputTokens: 120, cachedInputTokens: 0, outputTokens: 6, reasoningOutputTokens: 0 }, modelContextWindow: 258400 } } });
  send({ method: "account/rateLimits/updated", params: { rateLimits: { limitId: "codex", limitName: null, primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: 1893456000 }, secondary: null }, rateLimitsByLimitId: null } });
  send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "message-1", delta: "Hello " } });
  send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "message-1", delta: "from Codex" } });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  capture(message);
  if (message.method === "initialize") {
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "rpc-timeout") return;
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "metadata-line-overflow") {
      const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      fs.writeFileSync(process.env.INERTIA_APP_SERVER_CHILD_PID, String(descendant.pid));
      process.stdout.write("x".repeat(${CODEX_METADATA_MAX_FRAME_BYTES + 1}));
      return;
    }
    return send({ id: message.id, result: { userAgent: "fake" } });
  }
  if (message.method === "initialized") return;
  if (message.method === "model/list") return send({ id: message.id, result: { data: [{ id: "model-a", model: "model-a", displayName: "Model A", description: "A test model", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Quick" }, { reasoningEffort: "high", description: "Careful" }], defaultReasoningEffort: "low", inputModalities: ["text", "image"], isDefault: true }], nextCursor: null } });
  if (message.method === "account/rateLimits/read") return send({ id: message.id, result: { rateLimits: { limitId: "codex", limitName: null, primary: { usedPercent: 37, windowDurationMins: 10080, resetsAt: 1893456000 }, secondary: null }, rateLimitsByLimitId: null } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "incompatible-full-access" && message.params.approvalPolicy === "never") {
      return send({ id: message.id, error: { code: -32602, message: "invalid params: unknown variant danger-full-access" } });
    }
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "stale-resume" && message.method === "thread/resume") {
      return send({ id: message.id, error: { code: -32001, message: "thread not found" } });
    }
    threadId = message.params.threadId || "thread-new";
    send({ id: message.id, result: { thread: { id: threadId }, cwd: process.cwd(), model: "fake" } });
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "stale-completion") {
      send({ method: "turn/completed", params: { threadId, turn: { id: "stale-turn", status: "completed", items: [], error: null } } });
    }
    return;
  }
  if (message.method === "thread/compact/start") {
    send({ id: message.id, result: {} });
    send({ method: "item/started", params: { threadId, item: { id: "compact-1", type: "contextCompaction" } } });
    send({ method: "item/completed", params: { threadId, item: { id: "compact-1", type: "contextCompaction" } } });
    return;
  }
  if (message.method === "thread/goal/set") {
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "goal-live-mutation-error") {
      sendBatch([
        { id: message.id, error: { code: -32000, message: "goal mutation rejected" } },
        { method: "error", params: { threadId, turnId, error: { message: "parent turn failed after goal mutation" }, willRetry: false } },
        { method: "turn/completed", params: { threadId, turn: { id: turnId, status: "failed", items: [], error: { message: "parent turn failed after goal mutation" } } } },
      ]);
      return;
    }
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "goal-set-error") {
      send({ id: message.id, error: { code: -32000, message: "an unfinished goal already exists" } });
      return;
    }
    const goal = {
      threadId,
      objective: message.params.objective || "Existing goal",
      status: message.params.status,
      tokenBudget: message.params.tokenBudget ?? null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1800000000,
      updatedAt: 1800000000,
    };
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "goal-set-response-ordering") {
      const activeGoal = { ...goal, status: "active" };
      const completedGoal = { ...goal, status: "complete" };
      sendBatch([
        { method: "thread/goal/updated", params: { threadId, turnId, goal: activeGoal } },
        { id: message.id, result: { goal } },
        { method: "thread/goal/updated", params: { threadId, turnId, goal: completedGoal } },
        { method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } },
      ]);
      return;
    }
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "goal-terminal-after-start") {
      turnId = "goal-terminal-after-start-turn";
      sendBatch([
        { id: message.id, result: { goal } },
        { method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } } },
        { method: "thread/goal/updated", params: { threadId, turnId, goal: { ...goal, status: "budgetLimited", tokenBudget: 12_000, tokensUsed: 12_000, updatedAt: 1800000001 } } },
      ]);
      setTimeout(() => {
        send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "goal-terminal-message", delta: "Final goal turn output." } });
        send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
      }, 10);
      return;
    }
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "goal-set-clear-response-ordering") {
      sendBatch([
        { id: message.id, result: { goal } },
        { method: "thread/goal/cleared", params: { threadId } },
      ]);
      return;
    }
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "goal-terminal-response-ordering") {
      const terminalGoal = { ...goal, updatedAt: 1800000011 };
      sendBatch([
        { method: "thread/goal/updated", params: { threadId, turnId, goal: terminalGoal } },
        { id: message.id, result: { goal: terminalGoal } },
      ]);
      return;
    }
    send({ id: message.id, result: { goal } });
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "goal-response-only") {
      setTimeout(() => send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } }), 10);
      return;
    }
    send({ method: "thread/goal/updated", params: { threadId, goal } });
    if (
      process.env.INERTIA_APP_SERVER_SCENARIO !== "goal-continuation"
      && process.env.INERTIA_APP_SERVER_SCENARIO !== "goal-wait-for-interrupt"
    ) return;
    turnId = "goal-turn-1";
    send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } } });
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "goal-wait-for-interrupt") return;
    send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "goal-message-1", delta: "First goal turn. " } });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
    setTimeout(() => {
      turnId = "goal-turn-2";
      send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } } });
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "goal-message-2", delta: "Second goal turn." } });
      const completedGoal = {
        ...goal,
        status: "complete",
        tokensUsed: 9000,
        timeUsedSeconds: 8,
        updatedAt: 1800000008,
      };
      send({ method: "thread/goal/updated", params: { threadId, turnId, goal: completedGoal } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
    }, 10);
    return;
  }
  if (message.method === "thread/goal/clear") {
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "goal-clear-terminal-response-ordering") {
      sendBatch([
        { method: "thread/goal/cleared", params: { threadId } },
        { id: message.id, result: {} },
      ]);
      return;
    }
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "goal-clear-response-ordering") {
      const activeGoal = {
        threadId,
        objective: "Goal created after clear response",
        status: "active",
        tokenBudget: null,
        tokensUsed: 200,
        timeUsedSeconds: 2,
        createdAt: 1800000000,
        updatedAt: 1800000011,
      };
      sendBatch([
        { id: message.id, result: {} },
        { method: "thread/goal/updated", params: { threadId, turnId, goal: activeGoal } },
      ]);
      return;
    }
    send({ id: message.id, result: {} });
    send({ method: "thread/goal/cleared", params: { threadId } });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [], error: null } } });
    if (process.env.INERTIA_APP_SERVER_OVERSIZE === "1") {
      return process.stdout.write(
        "x".repeat(16 * 1024 * 1024 + 1) + "\\n"
        + JSON.stringify({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "trailing", delta: "must be ignored" } }) + "\\n"
        + JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } }) + "\\n"
      );
    }
    send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } } });
    if (
      process.env.INERTIA_APP_SERVER_SCENARIO === "goal-set-response-ordering"
      || process.env.INERTIA_APP_SERVER_SCENARIO === "goal-set-clear-response-ordering"
      || process.env.INERTIA_APP_SERVER_SCENARIO === "goal-clear-response-ordering"
      || process.env.INERTIA_APP_SERVER_SCENARIO === "goal-terminal-response-ordering"
      || process.env.INERTIA_APP_SERVER_SCENARIO === "goal-clear-terminal-response-ordering"
    ) {
      if (process.env.INERTIA_APP_SERVER_SCENARIO === "goal-clear-response-ordering") {
        send({ method: "thread/goal/updated", params: { threadId, turnId, goal: { threadId, objective: "Goal before clear response", status: "active", tokenBudget: null, tokensUsed: 100, timeUsedSeconds: 1, createdAt: 1800000000, updatedAt: 1800000010 } } });
      }
      if (
        process.env.INERTIA_APP_SERVER_SCENARIO === "goal-terminal-response-ordering"
        || process.env.INERTIA_APP_SERVER_SCENARIO === "goal-clear-terminal-response-ordering"
      ) {
        send({ method: "thread/goal/updated", params: { threadId, turnId, goal: { threadId, objective: "Goal awaiting mutation", status: "active", tokenBudget: null, tokensUsed: 100, timeUsedSeconds: 1, createdAt: 1800000000, updatedAt: 1800000010 } } });
        send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
      }
      return;
    }
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "legacy-large-frame") {
      send({ method: "account/rateLimits/updated", params: { padding: "x".repeat(1024 * 1024 + 32) } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
      return;
    }
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "aggregate-overflow") {
      for (let index = 0; index < 12; index += 1) {
        send({ method: "account/rateLimits/updated", params: { padding: "x".repeat(512), index } });
      }
      return;
    }
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "malformed-frame") {
      return process.stdout.write("{not-json}\\n");
    }
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "premature-exit") {
      send({ method: "item/started", params: { threadId, turnId, item: { id: "command-before-exit", type: "commandExecution", command: "npm test" } } });
      console.error("token=super-secret-value");
      return process.exit(7);
    }
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "signal-exit") {
      return process.kill(process.pid, "SIGTERM");
    }
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "terminal-then-exit") {
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
      return setTimeout(() => process.exit(9), 5_000);
    }
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "unsupported-input") {
      return send({
        id: "input-rpc",
        method: "item/tool/requestUserInput",
        params: {
          threadId,
          turnId,
          itemId: "input-item",
          questions: Array.from({ length: 4 }, (_, index) => ({
            id: "question-" + index,
            question: "Prompt " + index,
            options: [{ id: "safe", label: "Safe" }],
          })),
        },
      });
    }
    if (
      process.env.INERTIA_APP_SERVER_SCENARIO === "goal-resume-continuation"
      || process.env.INERTIA_APP_SERVER_SCENARIO === "goal-no-continuation"
      || process.env.INERTIA_APP_SERVER_SCENARIO === "goal-budget-limited"
    ) {
      const activeGoal = {
        threadId,
        objective: "Resume the existing goal",
        status: "active",
        tokenBudget: null,
        tokensUsed: 100,
        timeUsedSeconds: 1,
        createdAt: 1800000000,
        updatedAt: 1800000001,
      };
      send({ method: "thread/goal/updated", params: { threadId, turnId, goal: activeGoal } });
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "resume-message-1", delta: "Resumed goal turn. " } });
      if (process.env.INERTIA_APP_SERVER_SCENARIO === "goal-budget-limited") {
        send({ method: "thread/goal/updated", params: { threadId, turnId, goal: { ...activeGoal, status: "budgetLimited", tokenBudget: 12000, tokensUsed: 12000, timeUsedSeconds: 4, updatedAt: 1800000004 } } });
      }
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
      if (
        process.env.INERTIA_APP_SERVER_SCENARIO === "goal-no-continuation"
        || process.env.INERTIA_APP_SERVER_SCENARIO === "goal-budget-limited"
      ) return;
      setTimeout(() => {
        turnId = "goal-resume-turn-2";
        send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [], error: null } } });
        send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "resume-message-2", delta: "Automatic continuation." } });
        send({ method: "thread/goal/updated", params: { threadId, turnId, goal: { ...activeGoal, status: "complete", tokensUsed: 500, timeUsedSeconds: 3, updatedAt: 1800000003 } } });
        send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
      }, 10);
      return;
    }
    send({ method: "turn/completed", params: { threadId, turn: { id: "orphan-turn", status: "completed", items: [], error: null } } });
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "steer-and-collab") {
      send({ method: "item/started", params: { threadId, turnId, item: { type: "collabAgentToolCall", id: "spawn-1", tool: "spawnAgent", status: "inProgress", senderThreadId: threadId, receiverThreadIds: ["child-1"], prompt: "Inspect the tests", model: null, reasoningEffort: null, agentsStates: { "child-1": { status: "pendingInit", message: null } } } } });
      send({ method: "thread/started", params: { thread: { id: "child-1", parentThreadId: threadId, agentNickname: "Scout", agentRole: "researcher", preview: "Inspect the tests" } } });
      send({ method: "item/completed", params: { threadId: "child-1", turnId: "child-turn-1", item: { type: "agentMessage", id: "child-message-1", text: "Found coverage." } } });
      send({ method: "turn/completed", params: { threadId: "child-1", turn: { id: "child-turn-1", status: "completed", items: [], error: null } } });
      return;
    }
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "parent-before-child") {
      send({ method: "item/started", params: { threadId, turnId, item: { type: "collabAgentToolCall", id: "spawn-late", tool: "spawnAgent", status: "inProgress", senderThreadId: threadId, receiverThreadIds: ["child-late"], prompt: "Finish after the parent", model: null, reasoningEffort: null, agentsStates: { "child-late": { status: "running", message: "Still checking" } } } } });
      send({ method: "thread/started", params: { thread: { id: "child-late", parentThreadId: threadId, agentNickname: "Late verifier", agentRole: "reviewer", preview: "Finish after the parent" } } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
      setTimeout(() => {
        send({ method: "item/completed", params: { threadId: "child-late", turnId: "child-late-turn", item: { type: "agentMessage", id: "child-late-message", text: "Verified after the parent." } } });
        send({ method: "turn/completed", params: { threadId: "child-late", turn: { id: "child-late-turn", status: "completed", items: [], error: null } } });
      }, 20);
      return;
    }
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "completed-then-stale-error") {
      send({ method: "item/started", params: { threadId, turnId, item: { type: "collabAgentToolCall", id: "spawn-stale", tool: "spawnAgent", status: "inProgress", senderThreadId: threadId, receiverThreadIds: ["child-stale"], prompt: "Report the real outcome", model: null, reasoningEffort: null, agentsStates: { "child-stale": { status: "running", message: "Checking" } } } } });
      send({ method: "thread/started", params: { thread: { id: "child-stale", parentThreadId: threadId, agentNickname: "Outcome verifier", agentRole: "reviewer", preview: "Report the real outcome" } } });
      send({ method: "item/completed", params: { threadId: "child-stale", turnId: "child-stale-turn", item: { type: "agentMessage", id: "child-stale-message", text: "The child completed successfully." } } });
      send({ method: "turn/completed", params: { threadId: "child-stale", turn: { id: "child-stale-turn", status: "completed", items: [], error: null } } });
      send({ method: "item/completed", params: { threadId, turnId, item: { type: "collabAgentToolCall", id: "wait-stale", tool: "wait", status: "failed", senderThreadId: threadId, receiverThreadIds: ["child-stale"], prompt: null, model: null, reasoningEffort: null, agentsStates: { "child-stale": { status: "errored", message: "Stale parent summary" } } } } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
      return;
    }
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "nested-collab") {
      send({ method: "item/started", params: { threadId, turnId, item: { type: "collabAgentToolCall", id: "spawn-parent", tool: "spawnAgent", status: "inProgress", senderThreadId: threadId, receiverThreadIds: ["child-parent"], prompt: "Coordinate nested work", model: null, reasoningEffort: null, agentsStates: { "child-parent": { status: "running", message: "Coordinating" } } } } });
      send({ method: "thread/started", params: { thread: { id: "child-parent", parentThreadId: threadId, agentNickname: "Coordinator", agentRole: "lead", preview: "Coordinate nested work" } } });
      send({ method: "item/started", params: { threadId: "child-parent", turnId: "child-parent-turn", item: { type: "collabAgentToolCall", id: "spawn-grandchildren", tool: "spawnAgent", status: "inProgress", senderThreadId: "child-parent", receiverThreadIds: ["grandchild-a", "grandchild-b"], prompt: "Check two independent paths", model: null, reasoningEffort: null, agentsStates: { "grandchild-a": { status: "running", message: "Checking A" }, "grandchild-b": { status: "pendingInit", message: null } } } } });
      send({ method: "thread/started", params: { thread: { id: "grandchild-a", parentThreadId: "child-parent", agentNickname: "Nested A", agentRole: "tester", preview: "Check path A" } } });
      send({ method: "thread/started", params: { thread: { id: "grandchild-b", parentThreadId: "child-parent", agentNickname: "Nested B", agentRole: "tester", preview: "Check path B" } } });
      send({ method: "turn/completed", params: { threadId: "grandchild-a", turn: { id: "grandchild-a-turn", status: "completed", items: [], error: null } } });
      send({ method: "turn/completed", params: { threadId: "grandchild-b", turn: { id: "grandchild-b-turn", status: "failed", items: [], error: { message: "Path B failed." } } } });
      send({ method: "turn/completed", params: { threadId: "child-parent", turn: { id: "child-parent-turn", status: "completed", items: [], error: null } } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
      return;
    }
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "unknown-collab-state") {
      send({ method: "item/started", params: { threadId, turnId, item: { type: "collabAgentToolCall", id: "spawn-unknown", tool: "spawnAgent", status: "completed", senderThreadId: threadId, receiverThreadIds: ["child-future", "child-shutdown"], prompt: "Preserve unknown states", model: null, reasoningEffort: null, agentsStates: { "child-future": { status: "futureState", message: "A newer provider state" }, "child-shutdown": { status: "shutdown", message: "Worker shut down" } } } } });
      send({ method: "item/completed", params: { threadId, turnId, item: { type: "collabAgentToolCall", id: "wait-stale-shutdown", tool: "wait", status: "completed", senderThreadId: threadId, receiverThreadIds: ["child-shutdown"], prompt: null, model: null, reasoningEffort: null, agentsStates: { "child-shutdown": { status: "futureState", message: "A stale live snapshot" } } } } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
      setTimeout(() => {
        send({ method: "turn/completed", params: { threadId: "child-shutdown", turn: { id: "child-shutdown-turn", status: "completed", items: [], error: null } } });
        send({ method: "item/completed", params: { threadId: "child-future", turnId: "child-future-turn", item: { type: "agentMessage", id: "child-future-message", text: "The future state completed directly." } } });
        send({ method: "turn/completed", params: { threadId: "child-future", turn: { id: "child-future-turn", status: "completed", items: [], error: null } } });
      }, 20);
      return;
    }
    if (
      process.env.INERTIA_APP_SERVER_SCENARIO === "wait-for-interrupt"
      || process.env.INERTIA_APP_SERVER_SCENARIO === "transport-observed"
      || process.env.INERTIA_APP_SERVER_SCENARIO === "goal-response-only"
    ) return;
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "goal-events") {
      return complete();
    }
    if (message.params.approvalPolicy === "never") {
      requestInput();
      return;
    }
    const approvalThreadId =
      process.env.INERTIA_APP_SERVER_SCENARIO === "child-approval"
        ? "child-approval"
        : process.env.INERTIA_APP_SERVER_SCENARIO === "unrelated-approval"
          ? "thread-unrelated"
          : threadId;
    if (process.env.INERTIA_APP_SERVER_SCENARIO === "child-approval") {
      send({ method: "item/started", params: { threadId, turnId, item: { type: "collabAgentToolCall", id: "spawn-approval", tool: "spawnAgent", status: "inProgress", senderThreadId: threadId, receiverThreadIds: [approvalThreadId], prompt: "Run a supervised check", model: null, reasoningEffort: null, agentsStates: { [approvalThreadId]: { status: "running", message: "Waiting for approval" } } } } });
      send({ method: "thread/started", params: { thread: { id: approvalThreadId, parentThreadId: threadId, agentNickname: "Approval verifier", agentRole: "tester", preview: "Run a supervised check" } } });
    }
    const params = process.env.INERTIA_APP_SERVER_SCENARIO === "unsupported-decisions"
      ? { threadId: approvalThreadId, turnId, itemId: "command-1", startedAtMs: Date.now(), command: "npm test", cwd: process.cwd(), availableDecisions: ["acceptForSession"] }
      : process.env.INERTIA_APP_SERVER_SCENARIO === "nullable-decisions"
        ? { threadId: approvalThreadId, turnId, itemId: "command-1", startedAtMs: Date.now(), command: "npm test", cwd: process.cwd(), availableDecisions: null }
      : process.env.INERTIA_APP_SERVER_SCENARIO === "mixed-decisions"
        ? { threadId: approvalThreadId, turnId, itemId: "command-1", startedAtMs: Date.now(), command: "npm test", cwd: process.cwd(), availableDecisions: ["accept", "acceptForSession", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["prefix_rule(allow = [npm, test])"] } }, "decline", "cancel"] }
      : approvalMethod === "execCommandApproval"
        ? { conversationId: approvalThreadId, callId: "command-1", command: ["npm", "test"], parsedCmd: [], cwd: process.cwd(), reason: "Validate the change" }
      : approvalMethod === "applyPatchApproval"
        ? { conversationId: approvalThreadId, callId: "change-1", fileChanges: { "src/example.ts": { type: "add", content: "export {};" } }, grantRoot: process.cwd(), reason: "Write the requested file" }
      : approvalMethod === "item/fileChange/requestApproval"
      ? { threadId: approvalThreadId, turnId, itemId: "change-1", startedAtMs: Date.now(), reason: "Write the requested file", grantRoot: process.cwd() }
      : approvalMethod === "item/permissions/requestApproval"
        ? {
            threadId: approvalThreadId,
            turnId,
            itemId: "permission-1",
            environmentId: null,
            startedAtMs: Date.now(),
            cwd: process.cwd(),
            reason: "Read generated fixtures",
            permissions: {
              network: null,
              fileSystem: {
                read: process.env.INERTIA_APP_SERVER_SCENARIO === "permission-overflow"
                  ? Array.from({ length: 13 }, (_, index) => path.join(process.cwd(), "generated-" + index))
                  : [path.join(process.cwd(), "generated")],
                write: null,
                entries: [],
              },
            },
          }
      : {
          threadId: approvalThreadId,
          turnId,
          itemId: "command-1",
          startedAtMs: Date.now(),
          command: "npm test",
          cwd: process.cwd(),
          reason: "Validate the change",
          networkApprovalContext: { host: "registry.npmjs.org", protocol: "https" },
          additionalPermissions: {
            network: { enabled: true },
            fileSystem: { read: [path.join(process.cwd(), "fixtures")], write: [path.join(process.cwd(), "coverage")], entries: [] },
          },
        };
    return send({ id: "approval-rpc", method: approvalMethod, params });
  }
  if (message.id === "approval-rpc") {
    if (message.error) {
      if (process.env.INERTIA_APP_SERVER_SCENARIO === "permission-overflow") complete();
      return;
    }
    if (message.result.decision !== "cancel") requestInput();
    return;
  }
  if (message.id === "input-rpc") {
    if (message.error && process.env.INERTIA_APP_SERVER_SCENARIO === "unsupported-input") return;
    return complete();
  }
  if (message.method === "turn/steer") {
    send({ id: message.id, result: {} });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } });
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "interrupted", items: [], error: null } } });
  }
});
`);
    return { root, command, capturePath };
  }

  function captured(path: string): Array<Record<string, unknown>> {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  function processExists(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it("reads provider-supplied models, reasoning options, and remaining usage", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    const metadata = await readCodexMetadata(fake.command, process.env, fake.root);
    expect(metadata.models).toEqual([expect.objectContaining({
      id: "model-a",
      label: "Model A",
      isDefault: true,
      defaultReasoningEffort: "low",
      reasoningOptions: [
        { value: "low", label: "Low", description: "Quick" },
        { value: "high", label: "High", description: "Careful" },
      ],
    })]);
    expect(metadata.rateLimits).toEqual([expect.objectContaining({
      id: "codex:primary",
      label: "Codex usage",
      usedPercent: 37,
      remainingPercent: 63,
      windowMinutes: 10080,
    })]);
  });

  it("rejects metadata when owned-process cleanup cannot be confirmed", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;

    await expect(readCodexMetadata(
      fake.command,
      process.env,
      fake.root,
      6_000,
      ["models"],
      {
        terminateProcessTree: async (child, force) => {
          await terminateProcessTreeAndWait(child, force);
          return false;
        },
      },
    )).rejects.toThrow(
      "Codex metadata process tree could not be confirmed stopped.",
    );
  });

  it("rejects an unterminated oversized metadata frame and removes descendants", async () => {
    const fake = fakeAppServer();
    const childPidPath = join(fake.root, "metadata-child.pid");
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "metadata-line-overflow";
    process.env.INERTIA_APP_SERVER_CHILD_PID = childPidPath;

    await expect(readCodexMetadata(
      fake.command,
      process.env,
      fake.root,
      3_000,
      ["models"],
    )).rejects.toThrow("protocol safety limit");

    const childPid = Number(readFileSync(childPidPath, "utf8"));
    expect(Number.isSafeInteger(childPid)).toBe(true);
    await waitFor(
      "the oversized metadata descendant to stop",
      () => !processExists(childPid),
    );
  });

  it("round-trips approve-once, user input, native plans, deltas, resume, and images", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_APPROVAL_KIND = "command";
    const manager = trackedManager(fake.command);
    const approvals: string[] = [];
    const approvalRequests: ProviderApprovalEvent["request"][] = [];
    const inputs: string[] = [];
    const plans: string[] = [];
    const reasoning: string[] = [];
    const usage: Array<number | null> = [];
    const metadata: string[][] = [];
    const activities: Array<{ activityId?: string; detail?: string; phase: string }> = [];

    const run = manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-approve",
      cwd: fake.root,
      prompt: "Work carefully",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
      imagePaths: [join(fake.root, "reference.png")],
      skills: [{
        source: "codex-native",
        name: "security-review",
        path: join(fake.root, ".agents", "skills", "security-review", "SKILL.md"),
      }],
      reasoningEffort: "high",
    }), {
      onApproval: (event) => {
        approvals.push(event.request.command ?? "");
        approvalRequests.push(event.request);
        expect(manager.respondToApproval(event.conversationId, event.request.requestId, "approve")).toBe(true);
      },
      onInput: (event) => {
        inputs.push(event.request.questions[0]?.question ?? "");
        expect(manager.respondToInput(event.conversationId, event.request.requestId, { choice: ["  Safe  "] })).toBe(true);
      },
      onPlan: (event) => plans.push(event.explanation ?? ""),
      onReasoning: (event) => reasoning.push(event.text),
      onActivity: (event) => activities.push(event),
      onUsage: (event) => usage.push(event.usage.usedTokens),
      onMetadata: (event) => metadata.push(event.metadata.rateLimits?.map((limit) => limit.id) ?? []),
    });

    const result = await run;
    expect(result).toMatchObject({ status: "completed", sessionId: "thread-existing", text: "Hello from Codex" });
    expect(result).not.toHaveProperty("diagnostic");
    expect(approvals).toEqual(["npm test"]);
    expect(approvalRequests[0]).toMatchObject({
      availableDecisions: ["approve", "deny", "cancel"],
      networkScope: { host: "registry.npmjs.org", protocol: "https" },
      permissionRoots: [
        { path: normalize(join(realpathSync(fake.root), "fixtures")), access: "read" },
        { path: normalize(join(realpathSync(fake.root), "coverage")), access: "write" },
      ],
    });
    expect(inputs).toEqual(["Which path should Codex take?"]);
    expect(plans).toEqual(["A native plan"]);
    expect(reasoning).toEqual(["Checking the safest path."]);
    expect(activities).toContainEqual(expect.objectContaining({
      activityId: "command-1",
      phase: "completed",
      detail: "Command:\nnpm test\n\nOutput:\npassed",
    }));
    expect(usage).toEqual([126]);
    expect(metadata).toContainEqual(["codex:primary"]);
    expect(manager.cachedMetadata("codex")).toMatchObject({
      rateLimits: [expect.objectContaining({ id: "codex:primary", usedPercent: 41 })],
      metadataState: { rateLimits: { freshness: "fresh", provenance: "provider" } },
    });

    const messages = captured(fake.capturePath);
    const resumed = messages.find(({ method }) => method === "thread/resume") as { params: Record<string, unknown> };
    const turn = messages.find(({ method }) => method === "turn/start") as { params: Record<string, unknown> };
    expect(resumed.params).toEqual({
      threadId: "thread-existing",
      excludeTurns: true,
      cwd: fake.root,
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: "read-only",
      effort: "high",
    });
    expect(turn.params).toEqual({
      threadId: "thread-existing",
      input: [
        {
          type: "text",
          text: "$security-review\n\nWork carefully",
          text_elements: [],
        },
        {
          type: "skill",
          name: "security-review",
          path: join(
            fake.root,
            ".agents",
            "skills",
            "security-review",
            "SKILL.md",
          ),
        },
        { type: "localImage", path: join(fake.root, "reference.png") },
      ],
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      effort: "high",
      summary: "auto",
    });
    expect(messages.find(({ id }) => id === "approval-rpc")).toMatchObject({ result: { decision: "accept" } });
    expect(messages.find(({ id }) => id === "input-rpc")).toMatchObject({ result: { answers: { choice: { answers: ["  Safe  "] } } } });
    expect(messages.find(({ method }) => method === "initialized")).toEqual({ method: "initialized" });
    await manager.disposeAll();
  });

  it("accepts supervised approvals from a tracked child thread", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "child-approval";
    const manager = trackedManager(fake.command);
    const approvals: ProviderApprovalEvent["request"][] = [];

    const result = await manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-child-approval",
      cwd: fake.root,
      prompt: "Delegate a supervised check.",
      interactionMode: "build",
      access: "supervised",
    }), {
      onApproval: (event) => {
        approvals.push(event.request);
        expect(manager.respondToApproval(
          event.conversationId,
          event.request.requestId,
          "approve",
        )).toBe(true);
      },
      onInput: (event) => {
        expect(manager.respondToInput(
          event.conversationId,
          event.request.requestId,
          { choice: ["Safe"] },
        )).toBe(true);
      },
    });

    expect(result).toMatchObject({ status: "completed", text: "Hello from Codex" });
    expect(approvals).toEqual([expect.objectContaining({
      kind: "command",
      command: "npm test",
    })]);
    expect(captured(fake.capturePath).find(
      ({ id }) => id === "approval-rpc",
    )).toMatchObject({ result: { decision: "accept" } });
  });

  it("rejects supervised approvals from an unrelated provider thread", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "unrelated-approval";
    const manager = trackedManager(fake.command);
    const onApproval = vi.fn();

    const result = await manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-unrelated-approval",
      cwd: fake.root,
      prompt: "Reject unrelated authority.",
      interactionMode: "build",
      access: "supervised",
    }), { onApproval });

    expect(result.status).toBe("cancelled");
    expect(onApproval).not.toHaveBeenCalled();
    expect(captured(fake.capturePath).find(
      ({ id }) => id === "approval-rpc",
    )).toMatchObject({
      error: {
        code: -32602,
        message: "Codex sent an approval for a different provider thread.",
      },
    });
  });

  it.each([
    ["legacy-command", "command", "npm test"],
    ["legacy-file-change", "file-change", "Write the requested file\nChange src/example.ts"],
  ] as const)(
    "keeps supervised %s approval requests compatible with the installed protocol",
    async (approvalKind, expectedKind, expectedDetail) => {
      const fake = fakeAppServer();
      process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
      process.env.INERTIA_APP_SERVER_APPROVAL_KIND = approvalKind;
      const manager = trackedManager(fake.command);
      const approvals: ProviderApprovalEvent["request"][] = [];

      const result = await manager.run(nativeProviderRunInput({
        providerId: "codex",
        conversationId: `conversation-${approvalKind}`,
        cwd: fake.root,
        prompt: "Use supervised approval.",
        interactionMode: "build",
        access: "supervised",
      }), {
        onApproval: (event) => {
          approvals.push(event.request);
          expect(manager.respondToApproval(
            event.conversationId,
            event.request.requestId,
            "approve",
          )).toBe(true);
        },
        onInput: (event) => {
          expect(manager.respondToInput(
            event.conversationId,
            event.request.requestId,
            { choice: ["Safe"] },
          )).toBe(true);
        },
      });

      expect(result.status).toBe("completed");
      expect(approvals).toEqual([expect.objectContaining({
        kind: expectedKind,
        detail: expectedDetail,
        availableDecisions: ["approve", "deny", "cancel"],
      })]);
      expect(captured(fake.capturePath).find(
        ({ id }) => id === "approval-rpc",
      )).toMatchObject({ result: { decision: "approved" } });
    },
  );

  it("fails a stale resume visibly instead of silently replacing the provider session", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "stale-resume";
    const manager = trackedManager(fake.command);

    await expect(manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-stale",
      cwd: fake.root,
      prompt: "Do not lose this context.",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-stale",
    }))).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining(
        "saved provider session is no longer available",
      ),
    });

    const messages = captured(fake.capturePath);
    expect(messages.filter(({ method }) => method === "thread/resume")).toHaveLength(1);
    expect(messages.some(({ method }) => method === "thread/start")).toBe(false);
    expect(messages.some(({ method }) => method === "turn/start")).toBe(false);
    expect(manager.isRunning("conversation-stale")).toBe(false);
  });

  it("uses workspace-write for auto-edit build turns and maps denial", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_APPROVAL_KIND = "file-change";
    const manager = trackedManager(fake.command);

    const result = manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-deny",
      cwd: fake.root,
      prompt: "Try an edit",
      interactionMode: "build",
      access: "auto-edit",
    }), {
      onApproval: (event) => expect(manager.respondToApproval(event.conversationId, event.request.requestId, "deny")).toBe(true),
      onInput: (event) => expect(manager.respondToInput(event.conversationId, event.request.requestId, { choice: ["Safe"] })).toBe(true),
    });

    await expect(result).resolves.toMatchObject({ status: "completed" });
    const messages = captured(fake.capturePath);
    expect(messages.find(({ method }) => method === "thread/start")).toEqual({
      method: "thread/start",
      id: 2,
      params: {
        cwd: fake.root,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
      },
    });
    expect(messages.find(({ method }) => method === "turn/start")).toEqual({
      method: "turn/start",
      id: 3,
      params: {
        threadId: "thread-new",
        input: [{ type: "text", text: "Try an edit", text_elements: [] }],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
        summary: "auto",
      },
    });
    expect(messages.find(({ id }) => id === "approval-rpc")).toMatchObject({ result: { decision: "decline" } });
    await manager.disposeAll();
  });

  it("emits only valid current-thread native goal notifications", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "goal-events";
    const manager = trackedManager(fake.command);
    const updates: ProviderGoalUpdatedEvent[] = [];
    const clears: ProviderGoalClearedEvent[] = [];

    const result = await manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-goals",
      cwd: fake.root,
      prompt: "Track the native goal",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-goals",
    }), {
      onGoalUpdated: (event) => updates.push(event),
      onGoalCleared: (event) => clears.push(event),
    });

    expect(result).toMatchObject({
      status: "completed",
      sessionId: "thread-goals",
    });
    expect(updates).toEqual([expect.objectContaining({
      providerId: "codex",
      conversationId: "conversation-goals",
      sessionId: "thread-goals",
      type: "goal-updated",
      goal: {
        objective: "Ship native goals safely",
        status: "active",
        tokenBudget: 40_000,
        tokensUsed: 1_250,
        timeUsedSeconds: 42,
        createdAt: "2027-01-15T08:00:00.000Z",
        updatedAt: "2027-01-15T08:00:10.000Z",
      },
    })]);
    expect(clears).toEqual([expect.objectContaining({
      providerId: "codex",
      conversationId: "conversation-goals",
      sessionId: "thread-goals",
      type: "goal-cleared",
    })]);
  });

  it("keeps the owned App Server connection across automatic goal turns", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "goal-continuation";
    const manager = trackedManager(fake.command);
    const text: string[] = [];
    const statuses: string[] = [];
    const updates: ProviderGoalUpdatedEvent[] = [];

    const result = await manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-goal-continuation",
      runId: "run-goal-continuation",
      turnId: "turn-goal-continuation",
      cwd: fake.root,
      prompt: "/goal Ship the reliable flow",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-goal-continuation",
      goalStart: {
        objective: "Ship the reliable flow",
        tokenBudget: 12_000,
      },
      goalContinuationExpected: true,
    }), {
      onText: (event) => text.push(event.text),
      onStatus: (event) => statuses.push(event.status),
      onGoalUpdated: (event) => updates.push(event),
    });

    expect(result).toMatchObject({
      status: "completed",
      sessionId: "thread-goal-continuation",
      text: "First goal turn. Second goal turn.",
    });
    expect(text).toEqual(["First goal turn. ", "Second goal turn."]);
    expect(statuses).toEqual([
      "starting",
      "running",
      "completed",
    ]);
    expect(updates.some(({ goal }) =>
      goal.objective === "Ship the reliable flow"
      && goal.status === "active"
      && goal.tokenBudget === 12_000
      && goal.tokensUsed === 0)).toBe(true);
    expect(updates.at(-1)?.goal).toMatchObject({
      objective: "Ship the reliable flow",
      status: "complete",
      tokenBudget: 12_000,
      tokensUsed: 9_000,
    });

    const messages = captured(fake.capturePath);
    expect(messages.filter(({ method }) => method === "thread/goal/set"))
      .toEqual([expect.objectContaining({
        params: {
          threadId: "thread-goal-continuation",
          objective: "Ship the reliable flow",
          status: "active",
          tokenBudget: 12_000,
        },
      })]);
    expect(messages.some(({ method }) => method === "turn/start")).toBe(false);
  });

  it("fails a rejected goal start without converting it into an ordinary turn", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "goal-set-error";
    const manager = trackedManager(fake.command);

    await expect(manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-goal-rejected",
      cwd: fake.root,
      prompt: "/goal Duplicate goal",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-goal-rejected",
      goalStart: { objective: "Duplicate goal" },
      goalContinuationExpected: true,
    }))).resolves.toMatchObject({
      status: "failed",
      failure: { reason: "codex-error" },
    });

    const messages = captured(fake.capturePath);
    expect(messages.filter(({ method }) => method === "thread/goal/set"))
      .toHaveLength(1);
    expect(messages.some(({ method }) => method === "turn/start")).toBe(false);
    expect(manager.isRunning("conversation-goal-rejected")).toBe(false);
  });

  it("settles a goal start superseded by a terminal notification", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "goal-set-response-ordering";
    const manager = trackedManager(fake.command);

    await expect(manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-goal-terminal-start",
      cwd: fake.root,
      prompt: "/goal Finish before the first continuation",
      interactionMode: "build",
      access: "full",
      sessionId: "thread-goal-terminal-start",
      goalStart: { objective: "Finish before the first continuation" },
      goalContinuationExpected: true,
    }))).resolves.toMatchObject({
      status: "completed",
      sessionId: "thread-goal-terminal-start",
    });

    expect(manager.isRunning("conversation-goal-terminal-start")).toBe(false);
  });

  it("lets an already-started goal turn drain after a terminal update", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "goal-terminal-after-start";
    const manager = trackedManager(fake.command);

    await expect(manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-goal-terminal-running",
      cwd: fake.root,
      prompt: "/goal Finish the running turn",
      interactionMode: "build",
      access: "full",
      sessionId: "thread-goal-terminal-running",
      goalStart: {
        objective: "Finish the running turn",
        tokenBudget: 12_000,
      },
      goalContinuationExpected: true,
    }))).resolves.toMatchObject({
      status: "completed",
      text: "Final goal turn output.",
    });

    expect(manager.isRunning("conversation-goal-terminal-running")).toBe(false);
  });

  it("interrupts an automatic goal turn while preserving its active snapshot", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "goal-wait-for-interrupt";
    const manager = trackedManager(fake.command, 500);
    const updates: ProviderGoalUpdatedEvent[] = [];
    let cancelled = false;

    const result = manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-goal-cancel",
      cwd: fake.root,
      prompt: "/goal Pause safely",
      interactionMode: "build",
      access: "full",
      sessionId: "thread-goal-cancel",
      goalStart: { objective: "Pause safely" },
      goalContinuationExpected: true,
    }), {
      onGoalUpdated: (event) => updates.push(event),
      onStatus: (event) => {
        if (event.status !== "running" || cancelled) return;
        cancelled = manager.cancel(event.conversationId);
      },
    });

    await expect(result).resolves.toMatchObject({ status: "cancelled" });
    expect(cancelled).toBe(true);
    expect(updates.at(-1)?.goal).toMatchObject({
      objective: "Pause safely",
      status: "active",
    });
    expect(captured(fake.capturePath).find(({ method }) =>
      method === "turn/interrupt")).toMatchObject({
      params: {
        threadId: "thread-goal-cancel",
        turnId: "goal-turn-1",
      },
    });
  });

  it("projects a live goal mutation response even without a duplicate notification", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "goal-response-only";
    const updates: ProviderGoalSnapshot[] = [];
    let markRunning!: () => void;
    const running = new Promise<void>((resolve) => {
      markRunning = resolve;
    });
    const run = startCodexAppServerRun({
      executable: fake.command,
      environment: process.env,
      cwd: fake.root,
      prompt: "Keep the ordinary turn open",
      planMode: false,
      access: "full",
      sessionId: "thread-goal-live-update",
      onStatus: () => markRunning(),
      onGoalUpdated: (_threadId, goal) => updates.push(goal),
    });
    await running;

    await expect(run.setGoal({
      objective: "Finish from the live connection",
      status: "complete",
      tokenBudget: null,
    })).resolves.toMatchObject({
      objective: "Finish from the live connection",
      status: "complete",
    });
    await expect(run.result).resolves.toMatchObject({ status: "completed" });
    expect(updates).toEqual([expect.objectContaining({
      objective: "Finish from the live connection",
      status: "complete",
    })]);
  });

  it("does not promote a recoverable goal RPC error to the run failure", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "goal-live-mutation-error";
    let markRunning!: () => void;
    const running = new Promise<void>((resolve) => {
      markRunning = resolve;
    });
    const run = startCodexAppServerRun({
      executable: fake.command,
      environment: process.env,
      cwd: fake.root,
      prompt: "Keep the parent turn running",
      planMode: false,
      access: "full",
      sessionId: "thread-goal-live-mutation-error",
      onStatus: (status) => {
        if (status === "running") markRunning();
      },
    });
    await running;

    await expect(run.setGoal({
      status: "paused",
    })).rejects.toThrow("goal mutation rejected");
    await expect(run.result).resolves.toMatchObject({
      status: "failed",
      failure: {
        reason: "codex-error",
        message: "Codex reported an error.",
        technicalDetail: expect.stringContaining(
          "parent turn failed after goal mutation",
        ),
      },
    });
  });

  it("orders goal mutations at the decoded response frame", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "goal-set-response-ordering";
    const updates: ProviderGoalSnapshot[] = [];
    let markRunning!: () => void;
    const running = new Promise<void>((resolve) => {
      markRunning = resolve;
    });
    const run = startCodexAppServerRun({
      executable: fake.command,
      environment: process.env,
      cwd: fake.root,
      prompt: "Keep the ordered mutation connection open",
      planMode: false,
      access: "full",
      sessionId: "thread-goal-set-response-ordering",
      onStatus: () => markRunning(),
      onGoalUpdated: (_threadId, goal) => updates.push(goal),
    });
    await running;

    await expect(run.setGoal({
      objective: "Pause after current progress",
      status: "paused",
      tokenBudget: null,
    })).resolves.toMatchObject({ status: "complete" });
    await expect(run.result).resolves.toMatchObject({ status: "completed" });
    expect(updates.map(({ status }) => status)).toEqual([
      "active",
      "complete",
    ]);
  });

  it("preserves a clear decoded after a goal mutation response", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO =
      "goal-set-clear-response-ordering";
    const updates: ProviderGoalSnapshot[] = [];
    const clears: string[] = [];
    let markRunning!: () => void;
    const running = new Promise<void>((resolve) => {
      markRunning = resolve;
    });
    const run = startCodexAppServerRun({
      executable: fake.command,
      environment: process.env,
      cwd: fake.root,
      prompt: "Keep the clear-ordering connection open",
      planMode: false,
      access: "full",
      sessionId: "thread-goal-set-clear-response-ordering",
      onStatus: () => markRunning(),
      onGoalUpdated: (_threadId, goal) => updates.push(goal),
      onGoalCleared: (threadId) => clears.push(threadId),
    });
    await running;

    await expect(run.setGoal({
      objective: "Do not revive this goal",
      status: "active",
      tokenBudget: null,
    })).rejects.toThrow(
      "Codex cleared the goal before the update completed.",
    );
    expect(clears).toEqual(["thread-goal-set-clear-response-ordering"]);
    expect(updates).toEqual([]);

    run.cancel(true);
    await expect(run.result).resolves.toMatchObject({ status: "cancelled" });
  });

  it("keeps an awaited continuation alive through a terminal goal response", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "goal-terminal-response-ordering";
    let markRunning!: () => void;
    const running = new Promise<void>((resolve) => {
      markRunning = resolve;
    });
    const run = startCodexAppServerRun({
      executable: fake.command,
      environment: process.env,
      cwd: fake.root,
      prompt: "Wait for a terminal goal mutation",
      planMode: false,
      access: "full",
      sessionId: "thread-goal-terminal-response-ordering",
      goalContinuationGraceMs: 1_000,
      onStatus: (status) => {
        if (status === "running") markRunning();
      },
    });
    await running;

    await expect(run.setGoal({
      objective: "Finish the awaited goal",
      status: "complete",
      tokenBudget: null,
    })).resolves.toMatchObject({
      objective: "Finish the awaited goal",
      status: "complete",
    });
    await expect(run.result).resolves.toMatchObject({ status: "completed" });
  });

  it("preserves a goal notification decoded after a clear response", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "goal-clear-response-ordering";
    const updates: ProviderGoalSnapshot[] = [];
    const clears: string[] = [];
    let markRunning!: () => void;
    const running = new Promise<void>((resolve) => {
      markRunning = resolve;
    });
    const run = startCodexAppServerRun({
      executable: fake.command,
      environment: process.env,
      cwd: fake.root,
      prompt: "Keep the ordered clear connection open",
      planMode: false,
      access: "full",
      sessionId: "thread-goal-clear-response-ordering",
      onStatus: () => markRunning(),
      onGoalUpdated: (_threadId, goal) => updates.push(goal),
      onGoalCleared: (threadId) => clears.push(threadId),
    });
    await running;

    await expect(run.clearGoal()).resolves.toBe(false);
    expect(clears).toEqual([]);
    expect(updates.map(({ objective }) => objective)).toEqual([
      "Goal before clear response",
      "Goal created after clear response",
    ]);
    run.cancel(true);
    await expect(run.result).resolves.toMatchObject({ status: "cancelled" });
  });

  it("keeps an awaited continuation alive through a goal clear response", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "goal-clear-terminal-response-ordering";
    let markRunning!: () => void;
    const running = new Promise<void>((resolve) => {
      markRunning = resolve;
    });
    const run = startCodexAppServerRun({
      executable: fake.command,
      environment: process.env,
      cwd: fake.root,
      prompt: "Wait for a goal clear mutation",
      planMode: false,
      access: "full",
      sessionId: "thread-goal-clear-terminal-response-ordering",
      goalContinuationGraceMs: 1_000,
      onStatus: (status) => {
        if (status === "running") markRunning();
      },
    });
    await running;

    await expect(run.clearGoal()).resolves.toBe(true);
    await expect(run.result).resolves.toMatchObject({ status: "completed" });
  });

  it("keeps a resumed active goal connected across provider continuations", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "goal-resume-continuation";
    const manager = trackedManager(fake.command);
    const updates: ProviderGoalUpdatedEvent[] = [];

    const result = await manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-goal-resume",
      cwd: fake.root,
      prompt: "Continue the saved goal",
      interactionMode: "build",
      access: "full",
      sessionId: "thread-goal-resume",
      goalContinuationExpected: true,
    }), {
      onGoalUpdated: (event) => updates.push(event),
    });

    expect(result).toMatchObject({
      status: "completed",
      text: "Resumed goal turn. Automatic continuation.",
    });
    expect(updates.map(({ goal }) => goal.status)).toEqual([
      "active",
      "complete",
    ]);
    const messages = captured(fake.capturePath);
    expect(messages.filter(({ method }) => method === "turn/start"))
      .toHaveLength(1);
    expect(messages.some(({ method }) => method === "thread/goal/set"))
      .toBe(false);
  });

  it("settles without another turn when the provider exhausts the goal budget", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "goal-budget-limited";
    const manager = trackedManager(fake.command);
    const updates: ProviderGoalUpdatedEvent[] = [];

    const result = await manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-goal-budget",
      cwd: fake.root,
      prompt: "Continue until the budget boundary",
      interactionMode: "build",
      access: "full",
      sessionId: "thread-goal-budget",
      goalContinuationExpected: true,
    }), {
      onGoalUpdated: (event) => updates.push(event),
    });

    expect(result).toMatchObject({ status: "completed" });
    expect(updates.at(-1)?.goal).toMatchObject({
      status: "budgetLimited",
      tokenBudget: 12_000,
      tokensUsed: 12_000,
    });
    expect(captured(fake.capturePath).filter(({ method }) =>
      method === "turn/start")).toHaveLength(1);
  });

  it("keeps full access on App Server while streaming rich plan-turn state", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    const manager = trackedManager(fake.command);
    const approvals: string[] = [];
    const inputs: string[] = [];
    const plans: string[] = [];
    const reasoning: string[] = [];
    const usage: Array<number | null> = [];

    const result = manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-full",
      cwd: fake.root,
      prompt: "Plan with full access",
      interactionMode: "plan",
      access: "full",
      sessionId: "thread-full",
      imagePaths: [join(fake.root, "full-reference.png")],
      reasoningEffort: "high",
    }), {
      onApproval: (event) => approvals.push(event.request.requestId),
      onInput: (event) => {
        inputs.push(event.request.questions[0]?.question ?? "");
        expect(manager.respondToInput(event.conversationId, event.request.requestId, { choice: ["Direct"] })).toBe(true);
      },
      onPlan: (event) => plans.push(event.explanation ?? ""),
      onReasoning: (event) => reasoning.push(event.text),
      onUsage: (event) => usage.push(event.usage.usedTokens),
    });

    await expect(result).resolves.toMatchObject({
      status: "completed",
      sessionId: "thread-full",
      text: "Hello from Codex",
    });
    expect(approvals).toEqual([]);
    expect(inputs).toEqual(["Which path should Codex take?"]);
    expect(plans).toEqual(["A native plan"]);
    expect(reasoning).toEqual(["Checking the safest path."]);
    expect(usage).toEqual([126]);

    const messages = captured(fake.capturePath);
    const resumed = messages.find(({ method }) => method === "thread/resume") as { params: Record<string, unknown> };
    const turn = messages.find(({ method }) => method === "turn/start") as { params: Record<string, unknown> };
    expect(resumed.params).toEqual({
      threadId: "thread-full",
      excludeTurns: true,
      cwd: fake.root,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
      effort: "high",
    });
    expect(turn.params).toEqual({
      threadId: "thread-full",
      input: [
        { type: "text", text: "Plan with full access", text_elements: [] },
        { type: "localImage", path: join(fake.root, "full-reference.png") },
      ],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
      effort: "high",
      summary: "auto",
      collaborationMode: {
        mode: "plan",
        settings: { model: "fake", reasoning_effort: "high", developer_instructions: null },
      },
    });
    expect(messages.find(({ id }) => id === "input-rpc")).toMatchObject({ result: { answers: { choice: { answers: ["Direct"] } } } });
    await manager.disposeAll();
  });

  it("interrupts a full-access App Server turn without changing transport", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "wait-for-interrupt";
    const manager = trackedManager(fake.command, 500);
    let cancelled = false;

    const result = manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-full-cancel",
      cwd: fake.root,
      prompt: "Wait",
      interactionMode: "build",
      access: "full",
    }), {
      onStatus: (event) => {
        if (event.status !== "running" || cancelled) return;
        cancelled = manager.cancel(event.conversationId);
      },
    });

    await expect(result).resolves.toMatchObject({ status: "cancelled", sessionId: "thread-new" });
    expect(cancelled).toBe(true);
    const messages = captured(fake.capturePath);
    expect(messages.find(({ method }) => method === "turn/start")).toMatchObject({
      params: { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } },
    });
    expect(messages.find(({ method }) => method === "turn/interrupt")).toMatchObject({
      params: { threadId: "thread-new", turnId: "turn-1" },
    });
    await manager.disposeAll();
  });

  it("steers the exact active parent turn and projects nested collab identities", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "steer-and-collab";
    const manager = trackedManager(fake.command);
    const subagents: ProviderSubagentEvent[] = [];
    let steered = false;

    const result = manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-steer",
      runId: "run-steer",
      turnId: "local-turn-steer",
      cwd: fake.root,
      prompt: "Delegate and wait.",
      interactionMode: "build",
      access: "full",
    }), {
      onStatus: (event) => {
        if (event.status !== "running" || steered) return;
        steered = true;
        void manager.steer(
          event.conversationId,
          "Include the edge case.",
          { runId: event.runId, turnId: event.turnId! },
        );
      },
      onSubagent: (event) => subagents.push(event),
    });

    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(steered).toBe(true);
    expect(subagents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerAgentId: "child-1",
        providerToolUseId: "spawn-1",
        providerStatus: "pendingInit",
        status: "queued",
      }),
      expect.objectContaining({
        providerAgentId: "child-1",
        providerRole: "researcher",
        providerName: "Scout",
        status: "running",
      }),
      expect.objectContaining({
        providerAgentId: "child-1",
        status: "completed",
        result: "Found coverage.",
      }),
    ]));
    expect(captured(fake.capturePath).find(({ method }) =>
      method === "turn/steer")).toMatchObject({
      params: {
        threadId: "thread-new",
        expectedTurnId: "turn-1",
        input: [{
          type: "text",
          text: "Include the edge case.",
          text_elements: [],
        }],
      },
    });
  });

  it("drains a direct child outcome when the completed parent arrives first", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "parent-before-child";
    const manager = trackedManager(fake.command);
    const subagents: ProviderSubagentEvent[] = [];

    const result = manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-parent-first",
      runId: "run-parent-first",
      turnId: "local-turn-parent-first",
      cwd: fake.root,
      prompt: "Let the child finish after the parent.",
      interactionMode: "build",
      access: "full",
    }), {
      onSubagent: (event) => subagents.push(event),
    });

    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(subagents.at(-1)).toMatchObject({
      providerAgentId: "child-late",
      providerStatus: "completed",
      status: "completed",
      result: "Verified after the parent.",
    });
  });

  it("keeps a direct completed outcome over a later stale failed collab summary", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "completed-then-stale-error";
    const manager = trackedManager(fake.command);
    const subagents: ProviderSubagentEvent[] = [];

    const result = manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-real-child-outcome",
      runId: "run-real-child-outcome",
      turnId: "local-turn-real-child-outcome",
      cwd: fake.root,
      prompt: "Preserve the direct child outcome.",
      interactionMode: "build",
      access: "full",
    }), {
      onSubagent: (event) => subagents.push(event),
    });

    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(subagents.filter(({ providerAgentId }) =>
      providerAgentId === "child-stale").at(-1)).toMatchObject({
      providerStatus: "completed",
      status: "completed",
      result: "The child completed successfully.",
    });
    expect(subagents).not.toContainEqual(expect.objectContaining({
      providerAgentId: "child-stale",
      status: "failed",
    }));
  });

  it("projects multiple nested children with exact independent outcomes", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "nested-collab";
    const manager = trackedManager(fake.command);
    const subagents: ProviderSubagentEvent[] = [];

    const result = manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-nested-collab",
      runId: "run-nested-collab",
      turnId: "local-turn-nested-collab",
      cwd: fake.root,
      prompt: "Coordinate nested children.",
      interactionMode: "build",
      access: "full",
    }), {
      onSubagent: (event) => subagents.push(event),
    });

    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(subagents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerAgentId: "grandchild-a",
        parentProviderAgentId: "child-parent",
        providerStatus: "completed",
        status: "completed",
      }),
      expect.objectContaining({
        providerAgentId: "grandchild-b",
        parentProviderAgentId: "child-parent",
        providerStatus: "failed",
        status: "failed",
        result: "Path B failed.",
      }),
      expect.objectContaining({
        providerAgentId: "child-parent",
        providerStatus: "completed",
        status: "completed",
      }),
    ]));
  });

  it("drains a future collab state while preserving terminal shutdown as unknown", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "unknown-collab-state";
    const manager = trackedManager(fake.command);
    const subagents: ProviderSubagentEvent[] = [];

    const result = manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-unknown-collab",
      runId: "run-unknown-collab",
      turnId: "local-turn-unknown-collab",
      cwd: fake.root,
      prompt: "Do not relabel provider states.",
      interactionMode: "build",
      access: "full",
    }), {
      onSubagent: (event) => subagents.push(event),
    });

    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(subagents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerAgentId: "child-future",
        providerStatus: "futureState",
        status: "unknown",
        isLive: true,
      }),
      expect.objectContaining({
        providerAgentId: "child-shutdown",
        providerStatus: "shutdown",
        status: "unknown",
        isLive: false,
      }),
    ]));
    expect(subagents.filter(({ providerAgentId }) =>
      providerAgentId === "child-future").at(-1)).toMatchObject({
      providerStatus: "completed",
      status: "completed",
      isLive: false,
      result: "The future state completed directly.",
    });
    expect(subagents.filter(({ providerAgentId }) =>
      providerAgentId === "child-shutdown")).toEqual([
      expect.objectContaining({
        providerStatus: "shutdown",
        status: "unknown",
        isLive: false,
        result: "Worker shut down",
      }),
      expect.objectContaining({
        providerStatus: "completed",
        status: "completed",
        isLive: false,
      }),
    ]);
    expect(subagents).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerAgentId: "child-shutdown",
        providerStatus: "futureState",
        isLive: true,
      }),
    ]));
  });

  it("fails closed when App Server rejects full-access policy fields", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "incompatible-full-access";
    const manager = trackedManager(fake.command);
    const approvals: string[] = [];

    const result = await manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-full-incompatible",
      cwd: fake.root,
      prompt: "Run with full access",
      interactionMode: "build",
      access: "full",
    }), { onApproval: (event) => approvals.push(event.request.requestId) });

    expect(result).toMatchObject({
      status: "failed",
      error: "This Codex App Server version does not support Full Access. Update Codex CLI and try again.",
    });
    expect(result).not.toHaveProperty("compatibilityError");
    expect(approvals).toEqual([]);
    const messages = captured(fake.capturePath);
    expect(messages.find(({ method }) => method === "thread/start")).toMatchObject({
      params: { approvalPolicy: "never", sandbox: "danger-full-access" },
    });
    expect(messages.some(({ method }) => method === "turn/start")).toBe(false);
    await manager.disposeAll();
  });

  it("round-trips schema-native permission approvals without exposing raw params", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_APPROVAL_KIND = "permissions";
    const manager = trackedManager(fake.command);
    const approvalRequests: ProviderApprovalEvent["request"][] = [];
    const approvalResponses: boolean[] = [];
    const inputResponses: boolean[] = [];

    const result = manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-permissions",
      cwd: fake.root,
      prompt: "Inspect generated files",
      interactionMode: "build",
      access: "supervised",
    }), {
      onApproval: (event) => {
        approvalRequests.push(event.request);
        approvalResponses.push(manager.respondToApproval(event.conversationId, event.request.requestId, "approve"));
      },
      onInput: (event) => inputResponses.push(manager.respondToInput(event.conversationId, event.request.requestId, { choice: ["Safe"] })),
    });

    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(approvalRequests).toEqual([expect.objectContaining({
      kind: "permissions",
      permissionRoots: [{ path: normalize(join(realpathSync(fake.root), "generated")), access: "read" }],
    })]);
    expect(approvalResponses).toEqual([true]);
    expect(inputResponses).toEqual([true]);
    const response = captured(fake.capturePath).find(({ id }) => id === "approval-rpc");
    expect(response).toMatchObject({ result: { scope: "turn" } });
    const responsePath = (response as { result?: { permissions?: { fileSystem?: { read?: unknown[] } } } } | undefined)
      ?.result?.permissions?.fileSystem?.read?.[0];
    expect(typeof responsePath === "string" ? normalize(responsePath) : responsePath)
      .toBe(normalize(join(realpathSync(fake.root), "generated")));
    expect(JSON.stringify(response)).not.toContain("environmentId");
    await manager.disposeAll();
  });

  it("rejects permission approvals whose complete grant cannot be displayed", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_APPROVAL_KIND = "permissions";
    process.env.INERTIA_APP_SERVER_SCENARIO = "permission-overflow";
    const manager = trackedManager(fake.command);
    const approvals: ProviderApprovalEvent["request"][] = [];

    const result = await manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-permission-overflow",
      cwd: fake.root,
      prompt: "Inspect generated files",
      interactionMode: "build",
      access: "supervised",
    }), {
      onApproval: (event) => approvals.push(event.request),
    });

    expect(result).toMatchObject({ status: "cancelled" });
    expect(approvals).toEqual([]);
    const response = captured(fake.capturePath).find(
      ({ id }) => id === "approval-rpc",
    );
    expect(response).toMatchObject({
      error: {
        code: -32602,
        message:
          "Codex sent an approval request this client could not safely represent.",
      },
    });
    expect(response).not.toHaveProperty("result.permissions");
    await manager.disposeAll();
  });

  it("keeps plan mode read-only and cancels the active turn from an approval", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_APPROVAL_KIND = "command";
    const manager = trackedManager(fake.command, 500);

    const result = manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-cancel",
      cwd: fake.root,
      prompt: "Plan only",
      interactionMode: "plan",
      access: "auto-edit" as ProviderAccessMode,
    }), {
      onApproval: (event) => expect(manager.respondToApproval(event.conversationId, event.request.requestId, "cancel")).toBe(true),
    });

    await expect(result).resolves.toMatchObject({ status: "cancelled" });
    const messages = captured(fake.capturePath);
    const turn = messages.find(({ method }) => method === "turn/start") as { params: Record<string, unknown> };
    expect(turn.params).toMatchObject({ approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } });
    expect((turn.params.input as Array<{ text?: string }>)[0]?.text).toBe("Plan only");
    expect(turn.params.collaborationMode).toEqual({
      mode: "plan",
      settings: { model: "fake", reasoning_effort: null, developer_instructions: null },
    });
    expect(messages.find(({ id }) => id === "approval-rpc")).toMatchObject({ result: { decision: "cancel" } });
    expect(messages.some(({ method }) => method === "turn/interrupt")).toBe(true);
    await manager.disposeAll();
  });

  it("fails closed on an oversized protocol line instead of hanging", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_OVERSIZE = "1";
    const manager = trackedManager(fake.command, 100);
    const approvals: string[] = [];
    const text: string[] = [];
    const result = await manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-overflow",
      cwd: fake.root,
      prompt: "Do nothing",
      interactionMode: "build",
      access: "supervised",
    }), {
      onApproval: (event) => approvals.push(event.request.requestId),
      onText: (event) => text.push(event.text),
    });
    expect(result).toMatchObject({
      status: "failed",
      error: "Codex produced a protocol message that was too large to process safely.",
      failure: {
        reason: "protocol-overflow",
        technicalDetail: expect.stringContaining("16777216 bytes"),
      },
    });
    expect(approvals).toEqual([]);
    expect(text).toEqual([]);
    expect(manager.activeConversationIds()).toEqual([]);
    await manager.disposeAll();
  });

  it("accepts a valid protocol frame above the former one MiB boundary", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "legacy-large-frame";
    const manager = trackedManager(fake.command);

    const result = await manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-former-boundary",
      cwd: fake.root,
      prompt: "Accept the large notification",
      interactionMode: "build",
      access: "full",
    }));
    expect(result).toMatchObject({ status: "completed" });
    expect(result).not.toHaveProperty("failure");
  });

  it("classifies aggregate protocol overflow and terminates the owned process", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "aggregate-overflow";
    const run = startCodexAppServerRun({
      executable: fake.command,
      environment: process.env,
      cwd: fake.root,
      prompt: "Exercise the aggregate protocol budget",
      planMode: false,
      access: "full",
      protocolLimits: {
        maxFrameBytes: 1_024,
        maxProtocolBytes: 4_096,
      },
    });
    const closed = run.child.exitCode !== null || run.child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => run.child.once("close", () => resolve()));

    await expect(run.result).resolves.toMatchObject({
      status: "failed",
      failure: {
        reason: "protocol-overflow",
        technicalDetail: expect.stringContaining("4096 bytes"),
      },
    });
    await closed;
    expect(run.child.exitCode !== null || run.child.signalCode !== null).toBe(true);
  });

  it("does not settle a terminal App Server result before owned cleanup completes", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "terminal-then-exit";
    let markCleanupStarted!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const run = startCodexAppServerRun({
      executable: fake.command,
      environment: process.env,
      cwd: fake.root,
      prompt: "Wait for authoritative cleanup",
      planMode: false,
      access: "full",
      terminateProcessTree: async (child, force) => {
        expect(force).toBe(true);
        markCleanupStarted();
        await cleanupGate;
        return await terminateProcessTreeAndWait(child, true);
      },
    });
    let settled = false;
    void run.result.then(() => {
      settled = true;
    });

    await cleanupStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    releaseCleanup();
    await expect(run.result).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("maps unconfirmed App Server cleanup to a failed process result", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "terminal-then-exit";
    const terminateProcessTree = vi.fn(async (child, force: boolean) => {
      await terminateProcessTreeAndWait(child, force);
      return false;
    });
    const run = startCodexAppServerRun({
      executable: fake.command,
      environment: process.env,
      cwd: fake.root,
      prompt: "Fail cleanup authoritatively",
      planMode: false,
      access: "full",
      terminateProcessTree,
    });

    await expect(run.result).resolves.toMatchObject({
      status: "failed",
      failure: {
        reason: "process-exit",
        message:
          "Codex App Server process tree could not be confirmed stopped.",
      },
    });
    expect(terminateProcessTree).toHaveBeenCalledOnce();
    expect(terminateProcessTree.mock.calls[0]?.[1]).toBe(true);
  });

  it("does not trust post-close cleanup after an unexpected direct-child exit", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "premature-exit";
    const terminateProcessTree = vi.fn(async () => true);
    const run = startCodexAppServerRun({
      executable: fake.command,
      environment: process.env,
      cwd: fake.root,
      prompt: "Exit before cleanup is armed",
      planMode: false,
      access: "full",
      terminateProcessTree,
    });

    await expect(run.result).resolves.toMatchObject({
      status: "failed",
      cleanupConfirmed: false,
      failure: { reason: "process-exit" },
    });
    expect(terminateProcessTree).toHaveBeenCalledOnce();
  });

  it.each([
    ["malformed-frame", "malformed-protocol"],
    ["premature-exit", "process-exit"],
  ] as const)("classifies %s without exposing raw diagnostics", async (scenario, reason) => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = scenario;
    const manager = trackedManager(fake.command, 100);

    const result = await manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: `conversation-${scenario}`,
      cwd: fake.root,
      prompt: "Exercise the transport failure",
      interactionMode: "build",
      access: "full",
    }));

    expect(result).toMatchObject({
      status: "failed",
      failure: {
        reason,
        technicalDetail: expect.any(String),
      },
    });
    expect(result.failure?.technicalDetail).not.toContain("super-secret-value");
    expect(result.failure?.technicalDetail?.length).toBeLessThanOrEqual(32 * 1024);
    if (scenario === "premature-exit") {
      expect(result).toMatchObject({
        exitCode: 7,
        failure: {
          activityId: "command-before-exit",
          technicalDetail: expect.stringContaining("Activity: command-before-exit"),
        },
      });
    }
    if (scenario === "premature-exit") {
      expect(manager.activeConversationIds()).toEqual([
        "conversation-premature-exit",
      ]);
      managers.splice(managers.indexOf(manager), 1);
      await expect(manager.disposeAll()).rejects.toThrow(
        "Provider process cleanup could not be confirmed.",
      );
    } else {
      expect(manager.activeConversationIds()).toEqual([]);
    }
  });

  it("classifies a parent-observed transport close and cleans up the live process", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "transport-observed";
    let run: ReturnType<typeof startCodexAppServerRun> | undefined;
    let transportClosed = false;

    run = startCodexAppServerRun({
      executable: fake.command,
      environment: process.env,
      cwd: fake.root,
      prompt: "Exercise the transport failure",
      planMode: false,
      access: "full",
      onStatus: () => {
        queueMicrotask(() => {
          if (!run || transportClosed) return;
          transportClosed = true;
          run.child.stdout.destroy();
        });
      },
    });
    const closed = new Promise<void>((resolve) => run?.child.once("close", () => resolve()));

    await expect(run.result).resolves.toMatchObject({
      status: "failed",
      failure: {
        reason: "transport-closed",
        technicalDetail: expect.any(String),
      },
    });
    await closed;
    expect(transportClosed).toBe(true);
    expect(run.child.exitCode !== null || run.child.signalCode !== null).toBe(true);
  });

  it("preserves process signals and ignores a later process exit after a terminal event", async () => {
    const signalFake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = signalFake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "signal-exit";
    const signalManager = trackedManager(signalFake.command);
    const signalled = await signalManager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-signal",
      cwd: signalFake.root,
      prompt: "Stop by signal",
      interactionMode: "build",
      access: "full",
    }));
    expect(signalled.status).toBe("failed");
    if (process.platform === "win32") {
      expect(["process-exit", "process-signal"]).toContain(signalled.failure?.reason);
    } else {
      expect(signalled).toMatchObject({
        signal: "SIGTERM",
        failure: { reason: "process-signal" },
      });
    }
    if (signalManager.activeConversationIds().length > 0) {
      expect(signalManager.activeConversationIds()).toEqual([
        "conversation-signal",
      ]);
      managers.splice(managers.indexOf(signalManager), 1);
      await expect(signalManager.disposeAll()).rejects.toThrow(
        "Provider process cleanup could not be confirmed.",
      );
    }

    const terminalFake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = terminalFake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "terminal-then-exit";
    const terminalManager = trackedManager(terminalFake.command);
    const completed = await terminalManager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-terminal-exit",
      cwd: terminalFake.root,
      prompt: "Complete first",
      interactionMode: "build",
      access: "full",
    }));
    expect(completed).toMatchObject({ status: "completed" });
    expect(completed).not.toHaveProperty("failure");
  });

  it("classifies an RPC timeout and cleans up the owned process", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "rpc-timeout";
    const run = startCodexAppServerRun({
      executable: fake.command,
      environment: process.env,
      cwd: fake.root,
      prompt: "Time out initialization",
      planMode: false,
      access: "full",
      rpcTimeoutMs: 25,
    });

    await expect(run.result).resolves.toMatchObject({
      status: "failed",
      failure: {
        reason: "rpc-timeout",
        technicalDetail: expect.stringContaining("RPC method: initialize"),
      },
    });
  });

  it("ignores a stale completion while opening the new turn", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "stale-completion";
    const manager = trackedManager(fake.command);

    const result = manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-stale",
      cwd: fake.root,
      prompt: "Continue",
      interactionMode: "build",
      access: "supervised",
    }), {
      onApproval: (event) => expect(manager.respondToApproval(event.conversationId, event.request.requestId, "approve")).toBe(true),
      onInput: (event) => expect(manager.respondToInput(event.conversationId, event.request.requestId, { choice: ["Safe"] })).toBe(true),
    });

    await expect(result).resolves.toMatchObject({ status: "completed", text: "Hello from Codex" });
    await manager.disposeAll();
  });

  it("interrupts deterministically when Codex offers only unsupported decisions", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "unsupported-decisions";
    const manager = trackedManager(fake.command, 500);
    const approvals: string[] = [];

    const result = await manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-unsupported",
      cwd: fake.root,
      prompt: "Try a command",
      interactionMode: "build",
      access: "supervised",
    }), { onApproval: (event) => approvals.push(event.request.requestId) });

    expect(result).toMatchObject({ status: "cancelled" });
    expect(approvals).toEqual([]);
    const messages = captured(fake.capturePath);
    expect(messages.find(({ id }) => id === "approval-rpc")).toMatchObject({ error: { code: -32602 } });
    expect(messages.some(({ method }) => method === "turn/interrupt")).toBe(true);
    await manager.disposeAll();
  });

  it("treats schema-native null approval decisions as the default one-turn choices", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "nullable-decisions";
    const manager = trackedManager(fake.command);
    const approvals: ProviderApprovalEvent["request"][] = [];

    const result = manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-null-decisions",
      cwd: fake.root,
      prompt: "Try a command",
      interactionMode: "build",
      access: "supervised",
    }), {
      onApproval: (event) => {
        approvals.push(event.request);
        expect(manager.respondToApproval(
          event.conversationId,
          event.request.requestId,
          "approve",
        )).toBe(true);
      },
      onInput: (event) => expect(manager.respondToInput(
        event.conversationId,
        event.request.requestId,
        { choice: ["Safe"] },
      )).toBe(true),
    });

    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(approvals).toEqual([expect.objectContaining({
      kind: "command",
      availableDecisions: ["approve", "deny", "cancel"],
    })]);
    expect(captured(fake.capturePath).find(({ id }) =>
      id === "approval-rpc"
    )).toMatchObject({ result: { decision: "accept" } });
    await manager.disposeAll();
  });

  it("keeps safe one-turn choices when Codex also advertises unsupported persistent approval", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "mixed-decisions";
    const manager = trackedManager(fake.command);
    const approvals: ProviderApprovalEvent["request"][] = [];

    const result = manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-mixed-decisions",
      cwd: fake.root,
      prompt: "Try a command",
      interactionMode: "build",
      access: "auto-edit",
    }), {
      onApproval: (event) => {
        approvals.push(event.request);
        expect(manager.respondToApproval(
          event.conversationId,
          event.request.requestId,
          "approve",
        )).toBe(true);
      },
      onInput: (event) => expect(manager.respondToInput(
        event.conversationId,
        event.request.requestId,
        { choice: ["Safe"] },
      )).toBe(true),
    });

    await expect(result).resolves.toMatchObject({ status: "completed" });
    expect(approvals).toEqual([expect.objectContaining({
      kind: "command",
      availableDecisions: ["approve", "deny", "cancel"],
    })]);
    expect(captured(fake.capturePath).find(({ id }) =>
      id === "approval-rpc"
    )).toMatchObject({ result: { decision: "accept" } });
    await manager.disposeAll();
  });

  it("interrupts an unrepresentable Codex input request without exposing a partial prompt", async () => {
    const fake = fakeAppServer();
    process.env.INERTIA_APP_SERVER_CAPTURE = fake.capturePath;
    process.env.INERTIA_APP_SERVER_SCENARIO = "unsupported-input";
    const manager = trackedManager(fake.command, 500);
    const inputs: string[] = [];

    const result = await manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-unsupported-input",
      cwd: fake.root,
      prompt: "Ask safely",
      interactionMode: "build",
      access: "full",
    }), {
      onInput: (event) => inputs.push(event.request.requestId),
    });

    expect(result).toMatchObject({ status: "cancelled" });
    expect(inputs).toEqual([]);
    const messages = captured(fake.capturePath);
    expect(messages.find(({ id }) => id === "input-rpc")).toMatchObject({
      error: {
        code: -32602,
        message: "Codex sent a user-input request this client could not safely represent.",
      },
    });
    expect(messages.some(({ method }) => method === "turn/interrupt")).toBe(true);
    expect(manager.activeConversationIds()).toEqual([]);
    await manager.disposeAll();
  });

  it("settles a missing App Server executable without leaving an active run", async () => {
    const root = portableFixtureRoot("missing app server");
    roots.push(root);
    const missing = join(root, process.platform === "win32" ? "missing.exe" : "missing");
    const manager = trackedManager(missing);

    await expect(manager.run(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "conversation-missing",
      cwd: root,
      prompt: "Start",
      interactionMode: "build",
      access: "supervised",
    }))).resolves.toMatchObject({ status: "failed" });
    expect(manager.activeConversationIds()).toEqual([]);
    await manager.disposeAll();
  });
});
