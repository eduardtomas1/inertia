// @inertia-test-suite portable
import { describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentActivity, AgentApprovalRequest } from "../../src/shared/contracts/agent";
import type { ProviderId } from "../../src/shared/provider";
import { createAgentHarnessEmitter, type AgentHarnessEvent } from "../../src/server/provider/agent-harness";
import { joinProviderActivityDetail, providerActivityDetailSections } from "../../src/server/provider/activity-detail";
import { agentActivityKind, agentActivityStatus } from "../../src/server/runtime-snapshots";
import { handleCodexItem, type CodexItemProjectionState } from "../../src/server/codex/app-server-item-events";
import { CodexCommandOutput } from "../../src/server/codex/app-server-command-output";
import { parseCodexPlan } from "../../src/server/codex/plans";
import { parseCodexApprovalRequest } from "../../src/server/codex/approvals";
import { ClaudeMessageProjector } from "../../src/server/provider/claude-message-projector";
import { ClaudeUsageLedger } from "../../src/server/provider/claude-usage";
import { CappedProviderBuffer } from "../../src/server/provider/io";
import { acpPermissionDetail } from "../../src/server/provider/acp-permission-detail";
import { createOpenCodeEventState, emitOpenCodeNextActivity, handleOpenCodePart } from "../../src/server/provider/opencode-event-projection";
import { openCodeApprovalDisplay } from "../../src/server/provider/opencode-sdk-support";
import { antigravityResultFailure, parseAntigravityLine } from "../../src/server/provider/antigravity-stream";
import { mascotPublisher, mascotShell } from "../helpers/mascot-fixture";

const owner = { conversationId: "chat", runId: "chat-run", turnId: "chat-turn" };
const WORKSPACE = "/workspace/project";
const BARE = new Set([
  "Command", "File change", "Turn started", "Turn completed", "Patch updated", "Activity", "Tool", "Thinking", "Bash", "Read", "Edit",
  "Write", "Grep", "Glob", "bash", "read", "edit", "run_command", "view_file", "Run command", "Cursor tool", "Kimi Code tool", "OpenCode tool",
]);

function at(sequence: number): string {
  return new Date(Date.parse("2026-09-06T10:00:00.000Z") + sequence * 1_000).toISOString();
}

interface ProviderApproval { requestId: string; kind: AgentApprovalRequest["kind"]; title: string; detail?: string; command?: string; reason?: string }

function mascotTurn(providerId: ProviderId) {
  let shell = mascotShell("chat", "running");
  const { publisher, feed, clock } = mascotPublisher({ lookup: () => shell });
  publisher.replace([shell]);
  const activities = new Map<string, AgentActivity>();
  const lines: Array<string | null> = [];
  let text = "";
  let order = 0;
  const flushText = (): void => {
    if (!text.trim()) return;
    order += 1;
    publisher.observe({ type: "agent.commentary.persisted", message: {
      id: `message-${order}`, ...owner, role: "assistant", attachments: [], content: text, createdAt: at(order),
    } as never });
    text = "";
  };
  const approve = (request: ProviderApproval | AgentApprovalRequest): void => {
    flushText();
    shell = mascotShell("chat", "waiting-for-approval");
    publisher.observe({ type: "agent.approval.requested", request: {
      ...owner, providerId, cwd: null, networkScope: null, permissionRoots: [], availableDecisions: ["approve", "deny"],
      ...request, id: "id" in request ? request.id : request.requestId,
      detail: request.detail ?? null, command: request.command ?? null, reason: request.reason ?? null,
    } as AgentApprovalRequest });
  };
  const onEvent = (event: AgentHarnessEvent): void => {
    clock.advance(2_000);
    if (event.type === "text") { text += event.text; return; }
    if (event.type === "activity") {
      flushText();
      const id = event.activityId ?? `activity-${order += 1}`;
      const previous = activities.get(id);
      const activity: AgentActivity = {
        id, ...owner, kind: agentActivityKind(event), title: event.label,
        detail: joinProviderActivityDetail(previous?.detail ?? null, event.detail ?? null),
        status: agentActivityStatus(event), createdAt: previous?.createdAt ?? at(order += 1),
      };
      activities.set(id, activity);
      publisher.observe({ type: "agent.activity", activity });
    } else if (event.type === "extension") {
      const inner = event.event as { type: string; explanation?: string | null; steps?: never[]; request?: ProviderApproval };
      if (inner.type === "plan") {
        flushText();
        publisher.observe({ type: "agent.plan.updated", plan: { ...owner, explanation: inner.explanation ?? null, steps: inner.steps ?? [] } });
      } else if (inner.type === "approval") approve(inner.request!);
    } else return;
    lines.push(feed().status.message);
  };
  const emitter = createAgentHarnessEmitter(providerId, "chat", { onEvent }, "chat-run", "chat-turn", WORKSPACE);
  const line = (): string | null => feed().status.message;
  const resume = (): void => {
    shell = mascotShell("chat", "running");
    publisher.update(shell);
  };
  const finish = (result: string): void => {
    shell = mascotShell("chat", "completed", { updatedAt: "2026-09-06T10:20:00.000Z" });
    publisher.observe({ type: "agent.completed", ...owner, status: "completed", terminalReason: "completed", terminalAssistantMessage: {
      id: "final", ...owner, role: "assistant", content: result, attachments: [], createdAt: at(99),
    } as never });
  };
  const fail = (message: string): void => {
    shell = mascotShell("chat", "failed", { updatedAt: "2026-09-06T10:20:00.000Z" });
    publisher.observe({ type: "agent.failed", ...owner, status: "failed", terminalReason: "provider-failed", message });
  };
  const expectNoBareLabel = (): void => {
    for (const shown of lines) expect(shown === null || (!BARE.has(shown) && !shown.startsWith("Finished:"))).toBe(true);
  };
  return { emitter, onEvent, lines, line, feed, approve, resume, finish, fail, expectNoBareLabel };
}

describe("mascot bubble lines for each provider's real event shapes", () => {
  it("Codex: commands, file changes, the agent's words, plans and command approvals", () => {
    const turn = mascotTurn("codex");
    const state: CodexItemProjectionState = {
      deltaItems: new Set(), outputItems: new Set(), commandOutput: new CodexCommandOutput(), reasoningDeltaItems: new Set(),
      itemActivities: new Map(), completedPlanItemIds: new Set(), maxTrackedActivities: 100,
    };
    const host = {
      options: {
        onActivity: turn.emitter.activity, onText: (value: string) => turn.emitter.text(value),
        onPlan: (explanation: string | null, steps: never[]) => turn.emitter.codex({ type: "plan", explanation, steps }),
        onReasoning: () => undefined,
      },
      appendResultText: () => undefined, setLastActivityId: () => undefined, handleSubagentItem: () => false,
    };
    const item = (method: "item/started" | "item/completed", value: Record<string, unknown>): void => {
      handleCodexItem(host as never, state, method, { threadId: "thread", turnId: "turn", item: value });
    };
    turn.emitter.activity("turn", "started", "Turn started", { activityId: "codex-turn" });
    expect(turn.line()).toBeNull();
    const search = { id: "c1", type: "commandExecution", command: `/bin/zsh -lc 'rg -n mascot ${WORKSPACE}/src/server/runtime'`, status: "inProgress" };
    item("item/started", search);
    expect(turn.line()).toBe("Running rg -n mascot src/server/runtime");
    item("item/completed", { ...search, status: "completed", aggregatedOutput: "src/server/runtime/mascot-status.ts:68: export class", exitCode: 0 });
    expect(turn.line()).toBe("Ran rg -n mascot src/server/runtime");
    item("item/started", { id: "f1", type: "fileChange", status: "inProgress", changes: [{ path: `${WORKSPACE}/src/server/runtime/mascot-status.ts`, kind: { type: "update" }, diff: "" }] });
    expect(turn.line()).toBe("Editing mascot-status.ts");
    const words = "The publisher overwrites the preview with every tool title, so I'm going to keep the assistant's own words instead.";
    item("item/completed", { id: "a1", type: "agentMessage", text: words });
    item("item/started", { id: "c2", type: "commandExecution", command: ["npm", "test", "--", "tests/server/mascot-status.test.ts"], status: "inProgress" });
    expect(turn.line()).toBe(words);
    host.options.onPlan(parseCodexPlan({ plan: [{ step: "Read the publisher", status: "completed" }, { step: "Keep the agent's words", status: "inProgress" }] }).explanation, parseCodexPlan({ plan: [{ step: "Read the publisher", status: "completed" }, { step: "Keep the agent's words", status: "inProgress" }] }).steps as never[]);
    expect(turn.feed().status).toMatchObject({ message: words, steps: { completed: 1, total: 2 } });
    const approval = parseCodexApprovalRequest("item/commandExecution/requestApproval", {
      command: "rm -rf node_modules/.vite && npm ci", cwd: WORKSPACE, availableDecisions: ["accept", "decline"],
      reason: "Clear the Vite cache and reinstall dependencies.",
    })!;
    turn.approve({ ...approval.request, id: "approval" });
    expect(turn.line()).toBe(`${approval.request.title}: rm -rf node_modules/.vite && npm ci — Clear the Vite cache and reinstall dependencies.`);
    turn.resume();
    turn.finish("## Summary\n\nI split the **status feed** into `MascotFeed` per chat and kept the ranking stable.\n\n- Updated `mascot-status.ts`");
    expect(turn.line()).toBe("I split the status feed into MascotFeed per chat and kept the ranking stable.");
    turn.expectNoBareLabel();
  });

  it("Claude: raw tool names become plain words, Bash shows its command, and assistant text wins", () => {
    const turn = mascotTurn("claude");
    const projector = new ClaudeMessageProjector({
      emitter: turn.emitter, text: new CappedProviderBuffer(1024 * 1024), usesNativeAnthropic: false,
      usage: new ClaudeUsageLedger(false), contextUsage: () => undefined, acceptContextUsage: () => undefined, refreshContextUsage: () => undefined,
    });
    let sequence = 0;
    const assistant = (content: unknown[]): void => {
      sequence += 1;
      projector.observe({
        type: "assistant", uuid: `assistant-${sequence}`, session_id: "session", parent_tool_use_id: null,
        message: { id: `api-${sequence}`, type: "message", role: "assistant", model: "claude-test", content, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
      } as unknown as SDKMessage, false);
    };
    assistant([{ type: "tool_use", id: "read", name: "Read", input: { file_path: `${WORKSPACE}/src/server/runtime/mascot-status.ts` } }]);
    expect(turn.line()).toBe("Reading files");
    assistant([{ type: "tool_use", id: "bash", name: "Bash", input: { command: "npm test -- tests/server/mascot-status.test.ts" } }]);
    expect(turn.line()).toBe("Running npm test -- tests/server/mascot-status.test.ts");
    assistant([{ type: "tool_use", id: "search", name: "mcp__github__search_issues", input: { query: "mascot" } }]);
    expect(turn.line()).toBe("Using github search issues");
    assistant([
      { type: "text", text: "Found the stale preview in the publisher. I'm updating it to keep the agent's words." },
      { type: "tool_use", id: "edit", name: "Edit", input: { file_path: `${WORKSPACE}/src/server/runtime/mascot-status.ts` } },
    ]);
    expect(turn.line()).toBe("I'm updating it to keep the agent's words.");
    turn.approve({ requestId: "approval", kind: "command", title: "Claude wants to use Bash", detail: "npm run build", command: "npm run build" });
    expect(turn.line()).toBe("Claude wants to use Bash: npm run build");
    turn.resume();
    turn.fail("Claude Code process exited with code 1: ENOENT: no such file or directory, open 'package.json'");
    expect(turn.line()).toBe("Claude Code process exited with code 1: ENOENT: no such file or directory, open 'package.json'");
    expect(turn.lines.slice(0, 3)).toEqual(["Reading files", "Running npm test -- tests/server/mascot-status.test.ts", "Using github search issues"]);
    turn.expectNoBareLabel();
  });

  it.each([
    ["cursor", "Run command", "Edit file", "Cursor requested permission"],
    ["kimi", "Run checks", "Edit", "Kimi Code requested permission"],
  ] as const)("%s: ACP tool calls name the command and edited file, and permission JSON names the command", (providerId, commandTitle, editTitle, permissionTitle) => {
    const turn = mascotTurn(providerId);
    turn.emitter.activity("command", "started", commandTitle, { activityId: "tool-1", detail: providerActivityDetailSections({ command: "npm run check" }) ?? undefined });
    expect(turn.line()).toBe("Running npm run check");
    turn.emitter.activity("command", "completed", commandTitle, { activityId: "tool-1", detail: providerActivityDetailSections({ output: "ok" }) ?? undefined });
    expect(turn.line()).toBe("Ran npm run check");
    turn.emitter.activity("tool", "completed", editTitle, { activityId: "tool-2", detail: providerActivityDetailSections({
      output: [{ type: "diff", path: `${WORKSPACE}/src/renderer/src/mascot/Mascot.ts`, oldText: "a", newText: "b" }],
    }) ?? undefined });
    expect(turn.line()).toBe("Edited Mascot.ts");
    turn.emitter.activity("tool", "started", providerId === "cursor" ? "Cursor tool" : "Kimi Code tool", { activityId: "tool-3" });
    expect(turn.line()).toBe("Edited Mascot.ts");
    turn.approve({ requestId: "permission", kind: "command", title: permissionTitle,
      detail: acpPermissionDetail({ toolCall: { toolCallId: "tool-4", title: commandTitle, rawInput: { command: "git push origin feature" } } } as never, permissionTitle) });
    expect(turn.line()).toBe(`${permissionTitle}: git push origin feature`);
    turn.resume();
    turn.fail(`${providerId === "cursor" ? "Cursor" : "Kimi Code"}: model quota exceeded for this workspace`);
    expect(turn.line()).toMatch(/quota exceeded/u);
    turn.expectNoBareLabel();
  });

  it("OpenCode: tool parts, shell events and permission patterns", () => {
    const turn = mascotTurn("opencode");
    const state = createOpenCodeEventState();
    const usage = { maxTokens: null, currentContextTokens: null, messages: new Map(), totalProcessedTokens: 0, unknownTotalMessages: 0, last: null, compactsAutomatically: null };
    const part = (value: Record<string, unknown>): void => {
      handleOpenCodePart({ messageID: "assistant", type: "tool", ...value }, new Map(), new CappedProviderBuffer(1024), turn.emitter, usage, state);
    };
    part({ id: "p1", callID: "read", tool: "read", state: { status: "running", input: { filePath: `${WORKSPACE}/README.md` } } });
    expect(turn.line()).toBe("Reading files");
    part({ id: "p2", callID: "tests", tool: "bash", state: { status: "running", title: "Run tests", input: { command: "npm test" } } });
    expect(turn.line()).toBe("Running npm test");
    part({ id: "p2", callID: "tests", tool: "bash", state: { status: "error", title: "Run tests", input: { command: "npm test" }, error: { message: "exit 1" } } });
    expect(turn.line()).toBe("npm test failed");
    emitOpenCodeNextActivity("session.next.shell.started", { callID: "lint", command: "npm run lint -- --fix" }, turn.emitter, state);
    expect(turn.line()).toBe("Running npm run lint -- --fix");
    const display = openCodeApprovalDisplay({ permission: "bash", patterns: ["git push origin feature"] })!;
    turn.approve({ requestId: "permission", kind: "command", title: display.title, detail: display.detail });
    expect(turn.line()).toBe("OpenCode wants to use bash: git push origin feature");
    turn.expectNoBareLabel();
  });

  it("every provider's plan, task-list, resource and notebook tools read as what they do", () => {
    const claude = mascotTurn("claude");
    const projector = new ClaudeMessageProjector({
      emitter: claude.emitter, text: new CappedProviderBuffer(1024 * 1024), usesNativeAnthropic: false,
      usage: new ClaudeUsageLedger(false), contextUsage: () => undefined, acceptContextUsage: () => undefined, refreshContextUsage: () => undefined,
    });
    const claudeLine = (name: string, input: Record<string, unknown>): string | null => {
      projector.observe({
        type: "assistant", uuid: `assistant-${name}`, session_id: "session", parent_tool_use_id: null,
        message: { id: `api-${name}`, type: "message", role: "assistant", model: "claude-test", content: [{ type: "tool_use", id: name, name, input }],
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
      } as unknown as SDKMessage, false);
      return claude.line();
    };
    expect(claudeLine("TodoWrite", { todos: [{ content: "Ship", status: "in_progress", activeForm: "Shipping" }] })).toBe("Updating the plan");
    expect(claudeLine("NotebookRead", { notebook_path: `${WORKSPACE}/analysis.ipynb` })).toBe("Reading files");
    expect(claudeLine("TaskCreate", { subject: "Ship the mascot" })).toBe("Updating the plan");
    expect(claudeLine("TaskList", {})).toBe("Listing tasks");
    expect(claudeLine("ListMcpResourcesTool", {})).toBe("Listing resources");

    const opencode = mascotTurn("opencode");
    const state = createOpenCodeEventState();
    const usage = { maxTokens: null, currentContextTokens: null, messages: new Map(), totalProcessedTokens: 0, unknownTotalMessages: 0, last: null, compactsAutomatically: null };
    const tool = (name: string): string | null => {
      handleOpenCodePart({ messageID: "assistant", type: "tool", id: `p-${name}`, callID: name, tool: name, state: { status: "running", input: {} } },
        new Map(), new CappedProviderBuffer(1024), opencode.emitter, usage, state);
      return opencode.line();
    };
    expect(tool("todowrite")).toBe("Updating the plan");
    expect(tool("todoread")).toBe("Reading the plan");

    const kimi = mascotTurn("kimi");
    kimi.emitter.activity("tool", "started", "SetTodoList", { activityId: "kimi-todo" });
    expect(kimi.line()).toBe("Updating the plan");

    const antigravity = mascotTurn("antigravity");
    for (const event of parseAntigravityLine(JSON.stringify({ event: "step_update", step_update: { tool_name: "write_todos", step_index: 1, state: "RUNNING" } })) ?? []) {
      if (event.kind === "tool") antigravity.emitter.activity("tool", event.phase, event.label, { activityId: `antigravity:chat-run:${event.id}` });
    }
    expect(antigravity.line()).toBe("Updating the plan");
  });

  it("Antigravity: raw step tool names become plain words and the real error is kept", () => {
    const turn = mascotTurn("antigravity");
    const step = (value: Record<string, unknown>): void => {
      for (const event of parseAntigravityLine(JSON.stringify({ event: "step_update", step_update: value })) ?? []) {
        if (event.kind !== "tool") continue;
        turn.emitter.activity("tool", event.phase, event.label, { activityId: `antigravity:chat-run:${event.id}`, ...(event.detail ? { detail: event.detail } : {}) });
      }
    };
    step({ tool_name: "view_file", step_index: 1, state: "RUNNING" });
    expect(turn.line()).toBe("Reading files");
    step({ tool_name: "replace_file_content", step_index: 2, state: "RUNNING" });
    expect(turn.line()).toBe("Editing files");
    step({ tool_name: "run_command", step_index: 3, state: "RUNNING" });
    expect(turn.line()).toBe("Running a command");
    step({ tool_name: "run_command", step_index: 4, tool_info: { error: { type: "CommandFailed", message: "exit status 1" } } });
    expect(turn.line()).toBe("Running a command failed");
    const failure = antigravityResultFailure({ status: "ERROR", conversationId: null, response: "", error: "Gemini API returned 429: resource exhausted", usage: null }, WORKSPACE)!;
    turn.fail(failure.message);
    expect(turn.line()).toMatch(/429/u);
    turn.expectNoBareLabel();
  });
});
