import { randomUUID } from "node:crypto";

import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

import type { AgentHarnessEmitter } from "./agent-harness";
import { isSafeApprovalDisplayText } from "./approval-display";
import { claudeAttachmentReadAllowed, claudePermissionAccess } from "./attachment-read-grant";
import {
  CLAUDE_KEYED_LAUNCH_COMMAND_REFUSAL,
  claudeCommandExposesLaunchCredentials,
} from "./claude-credential-commands";
import type { ClaudeLaunchRedactor } from "./claude-launch-redaction";
import { claudeQuestions } from "./claude-questions";
import { claudeWatcherDecision } from "./claude-watcher-permissions";
import type { ProviderRunInput } from "./contracts";
import { INERTIA_HOST_MCP_NAME } from "./host-tool-mcp-config";
import type { AgentApprovalDecision, AgentInputRequest, AgentPlanStep } from "./interactions";

type ClaudeToolOptions = Parameters<CanUseTool>[2];

const MAX_EVENT_TEXT_CHARS = 1024 * 1024;
const MAX_PENDING_INTERACTIONS = 64;
const CLAUDE_CHECKLIST_TOOLS: ReadonlySet<string> = new Set([
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
]);

interface PendingApproval {
  resolve: (decision: AgentApprovalDecision) => void;
  settled: boolean;
}

interface PendingInput {
  resolve: (answers: Record<string, string[]>) => void;
  settled: boolean;
}

export interface ClaudePermissionBrokerOptions {
  input: ProviderRunInput;
  emitter: AgentHarnessEmitter;
  providerNativeToolsAvailable: boolean;
  hostToolNames: ReadonlySet<string> | undefined;
  cancelled: () => boolean;
  launchRedaction?: ClaudeLaunchRedactor | null;
}

export class ClaudePermissionBroker {
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly inputs = new Map<string, PendingInput>();

  constructor(private readonly options: ClaudePermissionBrokerOptions) {}

  readonly canUseTool: CanUseTool = async (toolName, toolInput, callbackOptions) => {
    const { emitter, input } = this.options;
    if (callbackOptions.signal.aborted || this.options.cancelled()) return deny("User cancelled the request.", true);
    const mcpServer = callbackOptions.mcpServer;
    if (
      this.options.hostToolNames?.has(toolName)
      && (!mcpServer || (mcpServer.source === "sdk" && mcpServer.name === INERTIA_HOST_MCP_NAME))
    ) {
      return { behavior: "allow", updatedInput: toolInput };
    }
    if (!this.options.providerNativeToolsAvailable) {
      return deny(
        "Provider-native tools are unavailable for this exact backend and model.",
      );
    }
    if (
      this.options.launchRedaction
      && !mcpServer
      && (toolName === "Bash" || toolName === "PowerShell")
      && typeof toolInput.command === "string"
      && claudeCommandExposesLaunchCredentials(toolInput.command)
    ) {
      return deny(CLAUDE_KEYED_LAUNCH_COMMAND_REFUSAL);
    }
    if (CLAUDE_CHECKLIST_TOOLS.has(toolName) && !mcpServer) {
      return { behavior: "allow", updatedInput: toolInput };
    }
    const watcher = input.readOnlyProfile === "watcher";
    if (toolName === "ExitPlanMode") {
      const plan = stringValue(toolInput.plan) ?? stringValue(toolInput.content);
      if (plan) emitter.rich(this.display({ type: "plan", explanation: plan, steps: planSteps(plan), handoff: true }));
      if (!watcher) return deny("The proposed plan was returned to the user for review.");
    }
    if (watcher) {
      return await this.watcherDecision(toolName, toolInput, callbackOptions);
    }
    if (toolName === "AskUserQuestion") {
      if (this.inputs.size >= MAX_PENDING_INTERACTIONS) {
        return deny("Claude exceeded the bounded question budget.", true);
      }
      const requestId = randomUUID();
      let request: AgentInputRequest;
      try {
        request = claudeQuestions(requestId, callbackOptions.toolUseID, toolInput);
      } catch (error) {
        return deny(error instanceof Error ? error.message : "Claude sent an invalid question request.");
      }
      const answers = await new Promise<Record<string, string[]>>((resolve) => {
        this.inputs.set(requestId, { resolve, settled: false });
        callbackOptions.signal.addEventListener("abort", () => this.settleInput(requestId, {}), { once: true });
        emitter.rich(this.display({ type: "input", request }));
      });
      if (callbackOptions.signal.aborted || this.options.cancelled()) return deny("User cancelled the request.", true);
      const sdkAnswers: Record<string, string> = {};
      for (const question of request.questions) {
        const labelsById = new Map(question.options.map((option) => [option.id, option.label]));
        const values = (answers[question.id] ?? []).map((value) => labelsById.get(value) ?? value);
        sdkAnswers[question.question] = values.join(", ");
      }
      return { behavior: "allow", updatedInput: { questions: toolInput.questions, answers: sdkAnswers } };
    }

    if (
      (input.access === "full" && input.interactionMode !== "plan")
      || claudeAttachmentReadAllowed(toolName, toolInput, callbackOptions.blockedPath, input.attachmentReadRoots)
    ) return { behavior: "allow", updatedInput: toolInput };
    const decision = await this.requestApproval(toolName, toolInput, callbackOptions);
    if ("behavior" in decision) return decision;
    if (decision.decision === "approve") {
      return {
        behavior: "allow",
        updatedInput: toolInput,
      } satisfies PermissionResult;
    }
    return deny(decision.decision === "cancel" ? "User cancelled tool execution." : "User declined tool execution.", decision.decision === "cancel");
  };

  private async watcherDecision(
    toolName: string,
    toolInput: Record<string, unknown>,
    callbackOptions: ClaudeToolOptions,
  ): Promise<PermissionResult> {
    if (claudeAttachmentReadAllowed(toolName, toolInput, callbackOptions.blockedPath, this.options.input.attachmentReadRoots)) {
      return { behavior: "allow", updatedInput: toolInput };
    }
    const decision = await claudeWatcherDecision({
      toolName,
      toolInput,
      cwd: this.options.input.cwd,
      mcpServer: callbackOptions.mcpServer !== undefined,
      blockedPath: callbackOptions.blockedPath,
    });
    if (callbackOptions.signal.aborted || this.options.cancelled()) return deny("User cancelled the request.", true);
    if (decision.kind === "allow") return { behavior: "allow", updatedInput: decision.updatedInput };
    if (decision.kind === "deny") return deny(decision.message);
    const outcome = await this.requestApproval(toolName, toolInput, callbackOptions, decision.approval);
    if ("behavior" in outcome) return outcome.behavior === "deny" && outcome.interrupt !== true ? deny(decision.message) : outcome;
    return deny(decision.message, outcome.decision === "cancel");
  }

  private async requestApproval(
    toolName: string,
    toolInput: Record<string, unknown>,
    callbackOptions: ClaudeToolOptions,
    kind?: "command" | "file-change" | "permissions",
  ): Promise<PermissionResult | { decision: AgentApprovalDecision }> {
    const { emitter, input } = this.options;
    const approvalTitle = callbackOptions.title
      ?? `Claude wants to use ${toolName}`;
    const approvalDetail = callbackOptions.description
      ?? summarizeInput(toolInput);
    const approvalCommand = (toolName === "Bash" || toolName === "PowerShell")
      && typeof toolInput.command === "string"
      ? toolInput.command
      : undefined;
    const approvalReason = callbackOptions.decisionReason;
    const approvalBlockedPath = callbackOptions.blockedPath;
    if (
      !isSafeApprovalDisplayText(approvalTitle)
      || !isSafeApprovalDisplayText(approvalDetail, true)
      || (
        approvalCommand !== undefined
        && !isSafeApprovalDisplayText(approvalCommand, true)
      )
      || (
        approvalReason !== undefined
        && !isSafeApprovalDisplayText(approvalReason, true)
      )
      || (
        approvalBlockedPath !== undefined
        && !isSafeApprovalDisplayText(approvalBlockedPath)
      )
    ) {
      return deny("Claude sent unsafe permission display text.");
    }

    if (this.approvals.size >= MAX_PENDING_INTERACTIONS) {
      return deny("Claude exceeded the bounded approval budget.", true);
    }
    const requestId = randomUUID();
    const decision = await new Promise<AgentApprovalDecision>((resolve) => {
      this.approvals.set(requestId, { resolve, settled: false });
      callbackOptions.signal.addEventListener("abort", () => this.settleApproval(requestId, "cancel"), { once: true });
      emitter.rich(this.display({
        type: "approval",
        request: {
          requestId,
          kind: kind ?? (toolName === "Bash" ? "command" : /edit|write|notebook/iu.test(toolName) ? "file-change" : "permissions"),
          title: bounded(approvalTitle),
          detail: bounded(approvalDetail),
          ...(approvalCommand !== undefined
            ? { command: bounded(approvalCommand) }
            : {}),
          cwd: input.cwd,
          ...(approvalReason ? { reason: bounded(approvalReason) } : {}),
          permissionRoots: approvalBlockedPath
            ? [{ path: bounded(approvalBlockedPath), access: claudePermissionAccess(toolName) }]
            : [],
          availableDecisions: ["approve", "deny", "cancel"],
        },
      }));
    });
    if (callbackOptions.signal.aborted || this.options.cancelled()) {
      return deny("User cancelled the request.", true);
    }
    return { decision };
  }

  private display<T>(value: T): T {
    return this.options.launchRedaction?.payload(value) ?? value;
  }

  settleApproval(requestId: string, decision: AgentApprovalDecision): boolean {
    const pending = this.approvals.get(requestId);
    if (!pending || pending.settled) return false;
    pending.settled = true;
    this.approvals.delete(requestId);
    this.options.emitter.rich({ type: "approval-resolved", requestId, decision });
    pending.resolve(decision);
    return true;
  }

  settleInput(requestId: string, answers: Record<string, string[]>): boolean {
    const pending = this.inputs.get(requestId);
    if (!pending || pending.settled) return false;
    pending.settled = true;
    this.inputs.delete(requestId);
    this.options.emitter.rich({ type: "input-resolved", requestId });
    pending.resolve(answers);
    return true;
  }

  cancelPending(): void {
    for (const requestId of this.approvals.keys()) this.settleApproval(requestId, "cancel");
    for (const [requestId, pending] of this.inputs) {
      pending.settled = true;
      this.inputs.delete(requestId);
      this.options.emitter.rich({ type: "input-resolved", requestId });
      pending.resolve({});
    }
  }
}

function planSteps(markdown: string): AgentPlanStep[] {
  const steps = markdown.split("\n").map((line) => line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)/u)?.[1]?.trim()).filter((value): value is string => Boolean(value));
  return (steps.length > 0 ? steps : [markdown]).slice(0, 100).map((step) => ({ step: bounded(step), status: "pending" }));
}

function bounded(value: string): string {
  return value.slice(0, MAX_EVENT_TEXT_CHARS);
}

function summarizeInput(input: Record<string, unknown>): string {
  try { return bounded(JSON.stringify(input)); } catch { return "Claude requested permission to use a tool."; }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function deny(message: string, interrupt = false): PermissionResult {
  return { behavior: "deny", message, ...(interrupt ? { interrupt: true } : {}) };
}
