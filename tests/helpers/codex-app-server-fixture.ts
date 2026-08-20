import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CODEX_METADATA_MAX_FRAME_BYTES } from "../../src/server/codex-metadata";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  writeNodeSubcommand,
} from "./portable-provider-fixture";

export function fakeAppServer(roots: string[]): { root: string; command: string; capturePath: string } {
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
if (message.method === "model/list") return send({ id: message.id, result: { data: [{ id: "model-a", model: "model-a", displayName: "Model A", description: "A test model", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Quick" }, { reasoningEffort: "high", description: "Careful" }], defaultReasoningEffort: "low", inputModalities: ["text", "image"], serviceTiers: [{ id: "priority", name: "Fast", description: "Faster responses" }], defaultServiceTier: null, isDefault: true }], nextCursor: null } });
if (message.method === "account/rateLimits/read") return send({ id: message.id, result: { rateLimits: { limitId: "codex", limitName: null, primary: { usedPercent: 37, windowDurationMins: 10080, resetsAt: 1893456000 }, secondary: null }, rateLimitsByLimitId: null } });
if (message.method === "thread/start" || message.method === "thread/resume") {
  if (process.env.INERTIA_APP_SERVER_SCENARIO === "incompatible-full-access" && message.params.approvalPolicy === "never") {
    return send({ id: message.id, error: { code: -32602, message: "invalid params: unknown variant danger-full-access" } });
  }
  if (process.env.INERTIA_APP_SERVER_SCENARIO === "stale-resume" && message.method === "thread/resume") {
    return send({ id: message.id, error: { code: -32001, message: "thread not found" } });
  }
  threadId = message.params.threadId || "thread-new";
  send({ id: message.id, result: { thread: { id: threadId }, cwd: process.cwd(), model: "fake", serviceTier: message.params.serviceTier ?? null } });
  if (process.env.INERTIA_APP_SERVER_SCENARIO === "stale-completion") {
    send({ method: "turn/completed", params: { threadId, turn: { id: "stale-turn", status: "completed", items: [], error: null } } });
  }
  return;
}
if (message.method === "thread/compact/start") {
  send({ id: message.id, result: {} });
  send({ method: "item/started", params: { threadId, turnId: "compact-turn-1", startedAtMs: Date.now(), item: { id: "compact-1", type: "contextCompaction" } } });
  send({ method: "item/completed", params: { threadId, turnId: "compact-turn-1", completedAtMs: Date.now(), item: { id: "compact-1", type: "contextCompaction" } } });
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
  if (process.env.INERTIA_APP_SERVER_SCENARIO === "protocol-burst-overflow") {
    for (let index = 0; index < 12; index += 1) {
      send({ method: "account/rateLimits/updated", params: { padding: "x".repeat(512), index } });
    }
    return;
  }
  if (process.env.INERTIA_APP_SERVER_SCENARIO === "rich-item-events") {
    sendBatch([
      { method: "windows/worldWritableWarning", params: { samplePaths: [path.join(process.cwd(), "shared")], extraCount: 2, failedScan: false } },
      { method: "windowsSandbox/setupCompleted", params: { mode: "elevated", success: true, error: null } },
      { method: "configWarning", params: { summary: "Config needs attention", details: "A recoverable setting was ignored.", path: path.join(process.cwd(), "config.toml") } },
      { method: "deprecationNotice", params: { summary: "Legacy setting is deprecated", details: "Use the replacement setting." } },
      { method: "warning", params: { threadId, message: "Codex recovered from a warning." } },
      { method: "guardianWarning", params: { threadId: "thread-unrelated", message: "UNRELATED_GUARDIAN_WARNING" } },
      { method: "guardianWarning", params: { threadId, message: "Guardian is reviewing a sensitive action." } },
      { method: "mcpServer/startupStatus/updated", params: { threadId: "thread-unrelated", name: "UNRELATED_MCP", status: "failed", error: "UNRELATED_MCP_ERROR", failureReason: null } },
      { method: "mcpServer/startupStatus/updated", params: { threadId, name: "workspace-tools", status: "starting", error: null, failureReason: null } },
      { method: "mcpServer/startupStatus/updated", params: { threadId, name: "workspace-tools", status: "failed", error: "OAuth token expired.", failureReason: "reauthenticationRequired" } },
      { method: "item/autoApprovalReview/started", params: { threadId: "thread-unrelated", turnId, startedAtMs: Date.now(), reviewId: "UNRELATED_REVIEW", targetItemId: null, review: { status: "inProgress", riskLevel: null, userAuthorization: null, rationale: null }, action: { type: "command", source: "shell", command: "UNRELATED_COMMAND", cwd: process.cwd() } } },
      { method: "item/autoApprovalReview/started", params: { threadId, turnId, startedAtMs: Date.now(), reviewId: "review-rich", targetItemId: "command-rich", review: { status: "inProgress", riskLevel: "medium", userAuthorization: "high", rationale: "Checking command safety." }, action: { type: "command", source: "shell", command: "npm run check", cwd: process.cwd() } } },
      { method: "item/autoApprovalReview/completed", params: { threadId, turnId, startedAtMs: Date.now(), completedAtMs: Date.now(), reviewId: "review-rich", targetItemId: "command-rich", decisionSource: "agent", review: { status: "approved", riskLevel: "low", userAuthorization: "high", rationale: "The command is scoped to tests." }, action: { type: "command", source: "shell", command: "npm run check", cwd: process.cwd() } } },
      { method: "model/safetyBuffering/updated", params: { threadId, turnId, model: "model-b", useCases: ["cyber"], reasons: ["Verifying trusted access"], showBufferingUi: true, fasterModel: "model-a" } },
      { method: "model/verification", params: { threadId, turnId, verifications: ["trustedAccessForCyber"] } },
      { method: "model/safetyBuffering/updated", params: { threadId, turnId, model: "model-b", useCases: ["cyber"], reasons: [], showBufferingUi: false, fasterModel: null } },
      { method: "thread/reverted", params: { threadId } },
      { method: "thread/environment/connected", params: { threadId, environmentId: "workspace-environment" } },
      { method: "thread/environment/disconnected", params: { threadId, environmentId: "workspace-environment" } },
      { method: "thread/settings/updated", params: { threadId, threadSettings: { cwd: process.cwd(), approvalPolicy: "untrusted", approvalsReviewer: "auto_review", sandboxPolicy: { type: "readOnly", networkAccess: false }, activePermissionProfile: null, model: "model-b", modelProvider: "openai", serviceTier: "priority", effort: "high", summary: "auto", collaborationMode: { mode: "default", settings: {} }, multiAgentMode: "explicitRequestOnly", personality: "pragmatic" } } },
      { method: "error", params: { threadId, turnId, itemId: "retry-1", error: { message: "Temporary upstream failure." }, willRetry: true } },
      { method: "model/rerouted", params: { threadId, turnId, fromModel: "model-a", toModel: "model-b", reason: "highRiskCyberActivity" } },
      { method: "hook/started", params: { threadId, turnId, run: { id: "hook-1", eventName: "stop", status: "running", statusMessage: null, entries: [] } } },
      { method: "hook/completed", params: { threadId, turnId, run: { id: "hook-1", eventName: "stop", status: "completed", statusMessage: "Hook passed.", entries: [{ kind: "context", text: "Checked policy." }] } } },
      { method: "hook/completed", params: { threadId, turnId, run: { id: "hook-stopped", eventName: "stop", status: "stopped", statusMessage: "Hook was stopped.", entries: [] } } },
      { method: "item/started", params: { threadId, turnId, item: { id: "command-rich", type: "commandExecution", command: "npm run check", status: "inProgress" } } },
      { method: "item/commandExecution/outputDelta", params: { threadId, turnId, itemId: "command-rich", delta: "checking..." } },
      { method: "item/commandExecution/terminalInteraction", params: { threadId, turnId, itemId: "command-rich", processId: "process-1", stdin: "y\\n" } },
      { method: "item/completed", params: { threadId, turnId, item: { id: "command-rich", type: "commandExecution", command: "npm run check", status: "failed", aggregatedOutput: "check failed" } } },
      { method: "item/completed", params: { threadId, turnId, item: { id: "command-declined", type: "commandExecution", command: "npm publish", status: "declined", aggregatedOutput: "" } } },
      { method: "item/started", params: { threadId, turnId, item: { id: "files-rich", type: "fileChange", status: "inProgress", changes: [{ path: "src/example.ts", kind: "update", diff: "" }] } } },
      { method: "item/fileChange/outputDelta", params: { threadId, turnId, itemId: "files-rich", delta: "Applying patch" } },
      { method: "item/completed", params: { threadId, turnId, item: { id: "files-rich", type: "fileChange", status: "completed", changes: [{ path: "src/example.ts", kind: "update", diff: "" }] } } },
      { method: "item/completed", params: { threadId, turnId, item: { id: "files-declined", type: "fileChange", status: "declined", changes: [{ path: "src/declined.ts", kind: "update", diff: "" }] } } },
      { method: "item/started", params: { threadId, turnId, item: { id: "mcp-rich", type: "mcpToolCall", server: "docs", tool: "search", status: "inProgress", arguments: {} } } },
      { method: "item/mcpToolCall/progress", params: { threadId, turnId, itemId: "mcp-rich", message: "Searching official docs" } },
      { method: "item/completed", params: { threadId, turnId, item: { id: "mcp-rich", type: "mcpToolCall", server: "docs", tool: "search", status: "completed", arguments: {}, result: { content: [{ type: "text", text: "Found the reference." }], structuredContent: null }, error: null } } },
      { method: "item/started", params: { threadId, turnId, item: { id: "dynamic-rich", type: "dynamicToolCall", tool: "preview", status: "inProgress", arguments: {} } } },
      { method: "item/completed", params: { threadId, turnId, item: { id: "dynamic-rich", type: "dynamicToolCall", tool: "preview", status: "completed", arguments: {}, contentItems: [{ type: "inputText", text: "Preview ready." }], success: true } } },
      { method: "item/started", params: { threadId, turnId, item: { id: "web-rich", type: "webSearch", query: "Codex App Server", action: { type: "search", query: "Codex App Server", queries: null } } } },
      { method: "item/completed", params: { threadId, turnId, item: { id: "web-rich", type: "webSearch", query: "Codex App Server", action: { type: "search", query: "Codex App Server", queries: null } } } },
      { method: "item/completed", params: { threadId, turnId, item: { id: "image-rich", type: "imageView", path: path.join(process.cwd(), "reference.png") } } },
      { method: "item/completed", params: { threadId, turnId, item: { id: "generated-rich", type: "imageGeneration", status: "completed", revisedPrompt: null, result: "generated.png" } } },
      { method: "item/started", params: { threadId, turnId, item: { id: "compact-rich", type: "contextCompaction" } } },
      { method: "item/completed", params: { threadId, turnId, item: { id: "compact-rich", type: "contextCompaction" } } },
      { method: "item/completed", params: { threadId, turnId, item: { id: "reason-rich", type: "reasoning", summary: ["Verified the provider surface."], content: [] } } },
      { method: "item/completed", params: { threadId, turnId, item: { id: "plan-rich", type: "plan", text: "1. Inspect\\n2. Verify" } } },
      { method: "item/plan/delta", params: { threadId, turnId, itemId: "plan-rich", delta: "Verifying implementation" } },
      { method: "turn/diff/updated", params: { threadId, turnId, diff: "diff --git a/src/example.ts b/src/example.ts" } },
      { method: "item/completed", params: { threadId, turnId, item: { id: "review-in", type: "enteredReviewMode", review: "Review changes" } } },
      { method: "item/completed", params: { threadId, turnId, item: { id: "review-out", type: "exitedReviewMode", review: "No findings" } } },
      { method: "thread/compacted", params: { threadId, turnId } },
      { method: "future/notification", params: { threadId, turnId, payload: "ignored safely" } },
      { method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "message-rich", delta: "Done" } },
      { method: "item/completed", params: { threadId, turnId, item: { id: "message-rich", type: "agentMessage", text: "Done", phase: "final_answer" } } },
      { method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [], error: null } } },
    ]);
    return;
  }
  if (process.env.INERTIA_APP_SERVER_SCENARIO === "thread-deleted") {
    send({ method: "thread/deleted", params: { threadId } });
    return;
  }
  if (process.env.INERTIA_APP_SERVER_SCENARIO === "thread-closed") {
    send({ method: "thread/closed", params: { threadId } });
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
  if (process.env.INERTIA_APP_SERVER_SCENARIO === "server-resolved-approval") {
    send({ id: "approval-rpc", method: approvalMethod, params });
    setTimeout(() => {
      send({ method: "serverRequest/resolved", params: { threadId, requestId: "approval-rpc" } });
      complete();
    }, 10);
    return;
  }
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

export function captured(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
