import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import {
  query as claudeQuery,
  type CanUseTool,
  type Options as ClaudeOptions,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { ProviderModel, ProviderRateLimit } from "../../shared/contracts";
import type { CodexApprovalDecision, CodexInputRequest, CodexPlanStep } from "../codex/types";
import { CappedProviderBuffer } from "./io";
import {
  createAgentHarnessEmitter,
  type AgentHarness,
  type AgentHarnessRun,
  type AgentHarnessStartOptions,
  type ClaudeAgentSdkHarnessCapabilities,
} from "./agent-harness";
import type { ProviderRunResult } from "./contracts";
import { providerTimestamp } from "./usage-values";

const MAX_RESULT_TEXT_CHARS = 4 * 1024 * 1024;
const MAX_EVENT_TEXT_CHARS = 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export const CLAUDE_AGENT_SDK_CAPABILITIES = {
  lifecycle: { events: "push", terminalStatuses: ["completed", "failed", "cancelled"] },
  session: { resume: "native", identity: "session" },
  cancellation: { graceful: "protocol-interrupt", forceFallback: "sdk-abort-close" },
  extension: {
    kind: "claude-agent-sdk",
    protocol: "claude-agent-sdk",
    approvals: "native",
    questions: "native",
    plans: "native",
    reasoning: "streaming-thinking",
    usage: "result-usage",
    images: "structured-base64-input",
    authentication: "claude-cli",
    modelMetadata: "agent-sdk",
  },
} as const satisfies ClaudeAgentSdkHarnessCapabilities;

type ClaudeQueryFactory = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: ClaudeOptions }) => Query;

export interface ClaudeAgentSdkHarnessOptions {
  createQuery?: ClaudeQueryFactory;
}

function claudeModels(models: Awaited<ReturnType<Query["supportedModels"]>>): ProviderModel[] {
  return models.slice(0, 64).map((model, index) => {
    const efforts = model.supportedEffortLevels ?? [];
    return {
      id: model.value,
      label: model.displayName || model.value,
      description: model.description || "Claude model",
      isDefault: index === 0,
      inputModalities: ["text", "image"],
      reasoningOptions: efforts.map((effort) => ({
        value: effort,
        label: effort === "xhigh" ? "Extra high" : `${effort[0]?.toUpperCase() ?? ""}${effort.slice(1)}`,
        description: `${effort === "xhigh" ? "Extra-high" : effort} reasoning effort`,
      })),
      defaultReasoningEffort: efforts.includes("high") ? "high" : efforts[0] ?? "",
    };
  });
}

export function parseClaudeRateLimits(value: unknown): ProviderRateLimit[] {
  const response = objectValue(value);
  if (response?.rate_limits_available !== true) return [];
  const limits = objectValue(response.rate_limits);
  if (!limits) return [];
  const windows: Array<{ key: string; label: string; minutes: number | null; value: unknown }> = [
    { key: "five_hour", label: "Claude · 5 hour", minutes: 300, value: limits.five_hour },
    { key: "seven_day", label: "Claude · 7 day", minutes: 10_080, value: limits.seven_day },
    { key: "seven_day_oauth_apps", label: "Claude apps · 7 day", minutes: 10_080, value: limits.seven_day_oauth_apps },
    { key: "seven_day_opus", label: "Claude Opus · 7 day", minutes: 10_080, value: limits.seven_day_opus },
    { key: "seven_day_sonnet", label: "Claude Sonnet · 7 day", minutes: 10_080, value: limits.seven_day_sonnet },
  ];
  const modelScoped = Array.isArray(limits.model_scoped) ? limits.model_scoped : [];
  modelScoped.slice(0, 8).forEach((entry, index) => {
    const model = objectValue(entry);
    windows.push({
      key: `model_${index}`,
      label: stringValue(model?.display_name) ?? `Claude model ${index + 1}`,
      minutes: 10_080,
      value: model,
    });
  });
  return windows.flatMap((window) => {
    const current = objectValue(window.value);
    const utilization = typeof current?.utilization === "number" && Number.isFinite(current.utilization) ? current.utilization : null;
    if (utilization === null) return [];
    return [{
      id: `claude:${window.key}`,
      label: window.label,
      usedPercent: utilization,
      remainingPercent: 100 - utilization,
      windowMinutes: window.minutes,
      resetsAt: providerTimestamp(current?.resets_at),
    }];
  }).slice(0, 12);
}

export async function readClaudeAgentSdkMetadata(
  executable: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs = 6_000,
  createQuery: ClaudeQueryFactory = claudeQuery,
  fields: readonly ("models" | "rateLimits")[] = ["models", "rateLimits"],
): Promise<{ models?: ProviderModel[]; rateLimits?: ProviderRateLimit[] }> {
  const abortController = new AbortController();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  async function* dormantPrompt(): AsyncIterable<SDKUserMessage> { await hold; }
  const query = createQuery({
    prompt: dormantPrompt(),
    options: { abortController, cwd, env: environment, pathToClaudeCodeExecutable: executable },
  });
  const timer = setTimeout(() => abortController.abort(), timeoutMs);
  timer.unref();
  try {
    const usageReader = query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    const [modelsResult, limitsResult] = await Promise.allSettled([
      fields.includes("models") ? query.supportedModels() : Promise.resolve(undefined),
      fields.includes("rateLimits") && typeof usageReader === "function"
        ? usageReader.call(query)
        : Promise.resolve(undefined),
    ]);
    return {
      ...(modelsResult.status === "fulfilled" && modelsResult.value !== undefined ? { models: claudeModels(modelsResult.value) } : {}),
      ...(limitsResult.status === "fulfilled" && limitsResult.value !== undefined ? { rateLimits: parseClaudeRateLimits(limitsResult.value) } : {}),
    };
  } finally {
    clearTimeout(timer);
    release();
    abortController.abort();
    try { query.close(); } catch { /* The metadata subprocess may already have exited. */ }
  }
}

export async function readClaudeAgentSdkModels(
  executable: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs = 6_000,
  createQuery: ClaudeQueryFactory = claudeQuery,
): Promise<ProviderModel[]> {
  return (await readClaudeAgentSdkMetadata(executable, environment, cwd, timeoutMs, createQuery, ["models"])).models ?? [];
}

interface PendingApproval {
  resolve: (decision: CodexApprovalDecision) => void;
  settled: boolean;
}

interface PendingInput {
  resolve: (answers: Record<string, string[]>) => void;
  settled: boolean;
}

export function createClaudeAgentSdkHarness(options: ClaudeAgentSdkHarnessOptions = {}): AgentHarness {
  return {
    id: "claude-agent-sdk",
    providerId: "claude",
    capabilities: CLAUDE_AGENT_SDK_CAPABILITIES,
    supports: (input) => input.providerId === "claude",
    start: (startOptions) => startClaudeRun(startOptions, options.createQuery ?? claudeQuery),
  };
}

function startClaudeRun(options: AgentHarnessStartOptions, createQuery: ClaudeQueryFactory): AgentHarnessRun {
  const conversationId = options.input.conversationId ?? options.input.threadId ?? "";
  const emitter = createAgentHarnessEmitter("claude", conversationId, options.callbacks);
  const text = new CappedProviderBuffer(MAX_RESULT_TEXT_CHARS);
  const approvals = new Map<string, PendingApproval>();
  const inputs = new Map<string, PendingInput>();
  const abortController = new AbortController();
  let query: Query | undefined;
  let cancelRequested = false;
  let sessionId = options.input.sessionId;

  const settleApproval = (requestId: string, decision: CodexApprovalDecision): boolean => {
    const pending = approvals.get(requestId);
    if (!pending || pending.settled) return false;
    pending.settled = true;
    approvals.delete(requestId);
    emitter.rich({ type: "approval-resolved", requestId, decision });
    pending.resolve(decision);
    return true;
  };
  const settleInput = (requestId: string, answers: Record<string, string[]>): boolean => {
    const pending = inputs.get(requestId);
    if (!pending || pending.settled) return false;
    pending.settled = true;
    inputs.delete(requestId);
    emitter.rich({ type: "input-resolved", requestId });
    pending.resolve(answers);
    return true;
  };
  const cancelPending = (): void => {
    for (const requestId of [...approvals.keys()]) settleApproval(requestId, "cancel");
    for (const [requestId, pending] of inputs) {
      pending.settled = true;
      inputs.delete(requestId);
      emitter.rich({ type: "input-resolved", requestId });
      pending.resolve({});
    }
  };

  const canUseTool: CanUseTool = async (toolName, toolInput, callbackOptions) => {
    if (toolName === "AskUserQuestion") {
      const requestId = randomUUID();
      const request = claudeQuestions(requestId, toolInput);
      if (request.questions.length === 0) return deny("Claude sent an invalid question request.");
      const answers = await new Promise<Record<string, string[]>>((resolve) => {
        inputs.set(requestId, { resolve, settled: false });
        callbackOptions.signal.addEventListener("abort", () => settleInput(requestId, {}), { once: true });
        emitter.rich({ type: "input", request });
      });
      if (callbackOptions.signal.aborted || cancelRequested) return deny("User cancelled the request.", true);
      const sdkAnswers = Object.fromEntries(Object.entries(answers).map(([key, values]) => [key, values.join(", ")]));
      return { behavior: "allow", updatedInput: { questions: toolInput.questions, answers: sdkAnswers } };
    }

    if (toolName === "ExitPlanMode") {
      const plan = stringValue(toolInput.plan) ?? stringValue(toolInput.content);
      if (plan) emitter.rich({ type: "plan", explanation: plan, steps: planSteps(plan) });
      return deny("The proposed plan was returned to the user for review.");
    }

    if (options.input.access === "full") return { behavior: "allow", updatedInput: toolInput };
    const requestId = randomUUID();
    const decision = await new Promise<CodexApprovalDecision>((resolve) => {
      approvals.set(requestId, { resolve, settled: false });
      callbackOptions.signal.addEventListener("abort", () => settleApproval(requestId, "cancel"), { once: true });
      emitter.rich({
        type: "approval",
        request: {
          requestId,
          kind: toolName === "Bash" ? "command" : /edit|write|notebook/iu.test(toolName) ? "file-change" : "permissions",
          title: bounded(callbackOptions.title ?? `Claude wants to use ${toolName}`),
          detail: bounded(callbackOptions.description ?? summarizeInput(toolInput)),
          ...(toolName === "Bash" && typeof toolInput.command === "string" ? { command: bounded(toolInput.command) } : {}),
          cwd: options.input.cwd,
          ...(callbackOptions.decisionReason ? { reason: bounded(callbackOptions.decisionReason) } : {}),
          permissionRoots: callbackOptions.blockedPath ? [{ path: callbackOptions.blockedPath, access: "write" }] : [],
          availableDecisions: ["approve", "deny", "cancel"],
        },
      });
    });
    if (decision === "approve") {
      return {
        behavior: "allow",
        updatedInput: toolInput,
      } satisfies PermissionResult;
    }
    return deny(decision === "cancel" ? "User cancelled tool execution." : "User declined tool execution.", decision === "cancel");
  };

  emitter.status("starting");
  const result = (async (): Promise<ProviderRunResult> => {
    try {
      const prompt = await claudePrompt(options.input.prompt, options.input.imagePaths ?? []);
      query = createQuery({
        prompt: oneMessage(prompt),
        options: {
          abortController,
          cwd: options.input.cwd,
          env: options.environment,
          pathToClaudeCodeExecutable: options.executable,
          includePartialMessages: true,
          permissionMode: options.input.interactionMode === "plan"
            ? "plan"
            : options.input.access === "full"
              ? "bypassPermissions"
              : options.input.access === "auto-edit"
                ? "acceptEdits"
                : "default",
          allowDangerouslySkipPermissions: options.input.access === "full",
          canUseTool,
          ...(options.input.sessionId ? { resume: options.input.sessionId } : {}),
          ...(options.input.model ? { model: options.input.model } : {}),
          ...(claudeEffort(options.input.reasoningEffort) ? { effort: claudeEffort(options.input.reasoningEffort) } : {}),
        },
      });
      await emitClaudeModelMetadata(query, emitter.rich);
      emitter.status("running");
      let sawStreamText = false;
      let failure: string | undefined;
      for await (const message of query) {
        const record = message as unknown as Record<string, unknown>;
        if (typeof record.session_id === "string" && record.session_id !== sessionId) {
          sessionId = record.session_id;
          emitter.session(sessionId);
        }
        if (message.type === "stream_event") {
          const delta = objectValue(objectValue(record.event)?.delta);
          const deltaType = stringValue(delta?.type);
          const value = stringValue(delta?.text) ?? stringValue(delta?.thinking);
          if (value && deltaType === "text_delta") {
            sawStreamText = true;
            emitText(value, text, emitter.text);
          } else if (value && deltaType === "thinking_delta") {
            emitter.rich({ type: "reasoning-summary", text: bounded(value) });
          }
          continue;
        }
        if (message.type === "assistant") {
          const content = Array.isArray(objectValue(record.message)?.content) ? objectValue(record.message)?.content as unknown[] : [];
          for (const block of content) {
            const item = objectValue(block);
            if (!item) continue;
            if (item.type === "text" && !sawStreamText && typeof item.text === "string") emitText(item.text, text, emitter.text);
            if (item.type === "thinking" && typeof item.thinking === "string") emitter.rich({ type: "reasoning-summary", text: bounded(item.thinking) });
            if (item.type === "tool_use") {
              const name = stringValue(item.name) ?? "tool";
              emitter.activity(name === "Bash" ? "command" : "tool", "started", bounded(name));
              const input = objectValue(item.input);
              if (name === "ExitPlanMode" && input) {
                const plan = stringValue(input.plan) ?? stringValue(input.content);
                if (plan) emitter.rich({ type: "plan", explanation: plan, steps: planSteps(plan) });
              }
            }
          }
          continue;
        }
        if (message.type === "user") {
          emitter.activity("tool", "completed", "Claude finished a tool call");
          continue;
        }
        if (message.type === "result") {
          const contextUsage = await readClaudeContextUsage(query);
          emitClaudeUsage(record, contextUsage, emitter.rich);
          await emitClaudeRateLimitMetadata(query, emitter.rich);
          if (message.subtype === "success") {
            if (!sawStreamText && typeof message.result === "string") emitText(message.result, text, emitter.text);
          } else {
            failure = Array.isArray(message.errors) ? message.errors.filter((value): value is string => typeof value === "string").join("\n") : "Claude could not complete the request.";
          }
          break;
        }
      }
      if (cancelRequested) return finishResult("cancelled");
      if (failure) return finishResult("failed", failure);
      return finishResult("completed");
    } catch (error) {
      if (cancelRequested || abortController.signal.aborted) return finishResult("cancelled");
      return finishResult("failed", safeError(error, "Claude Agent SDK stopped unexpectedly."));
    } finally {
      cancelPending();
      try { query?.close(); } catch { /* The SDK process may already be closed. */ }
    }
  })();

  function finishResult(status: ProviderRunResult["status"], error?: string): ProviderRunResult {
    emitter.status(status, error);
    return {
      providerId: "claude",
      conversationId,
      status,
      ...(sessionId ? { sessionId } : {}),
      text: text.toString(),
      textTruncated: text.truncated,
      exitCode: null,
      signal: null,
      ...(error ? { error } : {}),
    };
  }

  const cancel = (force: boolean): void => {
    if (cancelRequested && !force) return;
    cancelRequested = true;
    emitter.status("cancelling");
    cancelPending();
    if (force) {
      abortController.abort();
      try { query?.close(); } catch { /* Best-effort force close. */ }
      return;
    }
    void query?.interrupt().catch(() => abortController.abort());
  };

  return {
    harnessId: "claude-agent-sdk",
    providerId: "claude",
    result,
    cancel,
    extension: { kind: "claude-agent-sdk", respondToApproval: settleApproval, respondToInput: settleInput },
  };
}

async function emitClaudeRateLimitMetadata(
  query: Query,
  emit: ReturnType<typeof createAgentHarnessEmitter>["rich"],
): Promise<void> {
  const reader = query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
  if (typeof reader !== "function") return;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), 2_000);
      timer.unref();
    });
    const response = await Promise.race([reader.call(query), timeout]);
    if (response === undefined) return;
    const rateLimits = parseClaudeRateLimits(response);
    if (rateLimits.length > 0) emit({ type: "metadata", metadata: { rateLimits }, source: "provider", complete: true });
  } catch {
    // Experimental usage metadata is optional and must not affect the provider run.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function emitClaudeModelMetadata(
  query: Query,
  emit: ReturnType<typeof createAgentHarnessEmitter>["rich"],
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), 2_000);
      timer.unref();
    });
    const models = await Promise.race([query.supportedModels().catch(() => undefined), timeout]);
    if (!models) return;
    const mapped = claudeModels(models);
    if (mapped.length > 0) emit({ type: "metadata", metadata: { models: mapped }, source: "provider", complete: true });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function* oneMessage(message: SDKUserMessage): AsyncIterable<SDKUserMessage> {
  yield message;
}

async function claudePrompt(prompt: string, imagePaths: readonly string[]): Promise<SDKUserMessage> {
  const content: Array<Record<string, unknown>> = [];
  let imageBytes = 0;
  for (const path of imagePaths) {
    const mediaType = imageMediaType(path);
    if (!mediaType) throw new Error(`Claude does not support the attached image type: ${extname(path) || "unknown"}.`);
    const data = await readFile(path);
    imageBytes += data.byteLength;
    if (imageBytes > MAX_IMAGE_BYTES) throw new Error("Claude image attachments exceed the 20 MB safety limit.");
    content.push({ type: "image", source: { type: "base64", media_type: mediaType, data: data.toString("base64") } });
  }
  content.push({ type: "text", text: prompt });
  return { type: "user", message: { role: "user", content } as unknown as SDKUserMessage["message"], parent_tool_use_id: null };
}

function imageMediaType(path: string): "image/jpeg" | "image/png" | "image/gif" | "image/webp" | undefined {
  switch (extname(path).toLowerCase()) {
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".png": return "image/png";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    default: return undefined;
  }
}

function claudeQuestions(requestId: string, input: Record<string, unknown>): CodexInputRequest {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  return {
    requestId,
    autoResolutionMs: null,
    questions: questions.slice(0, 3).flatMap((value, index) => {
      const question = objectValue(value);
      if (!question) return [];
      const text = bounded(stringValue(question.question) ?? `Question ${index + 1}`);
      const options = Array.isArray(question.options) ? question.options : [];
      return [{
        id: text,
        header: bounded(stringValue(question.header) ?? `Question ${index + 1}`),
        question: text,
        isOther: true,
        isSecret: false,
        options: options.slice(0, 20).flatMap((option) => {
          const item = objectValue(option);
          return item ? [{ label: bounded(stringValue(item.label) ?? "Option"), description: bounded(stringValue(item.description) ?? "") }] : [];
        }),
      }];
    }),
  };
}

function planSteps(markdown: string): CodexPlanStep[] {
  const steps = markdown.split("\n").map((line) => line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)/u)?.[1]?.trim()).filter((value): value is string => Boolean(value));
  return (steps.length > 0 ? steps : [markdown]).slice(0, 100).map((step) => ({ step: bounded(step), status: "pending" }));
}

function emitClaudeUsage(
  record: Record<string, unknown>,
  contextUsage: Record<string, unknown> | undefined,
  emit: (event: Parameters<ReturnType<typeof createAgentHarnessEmitter>["rich"]>[0]) => void,
): void {
  const usage = objectValue(record.usage);
  if (!usage && !contextUsage) return;
  const input = finiteNumber(usage?.input_tokens);
  const output = finiteNumber(usage?.output_tokens);
  const cached = finiteNumber(usage?.cache_read_input_tokens);
  const cacheWrite = finiteNumber(usage?.cache_creation_input_tokens);
  const inputParts = [input, cached, cacheWrite].filter((value): value is number => value !== null);
  const totalInput = inputParts.length > 0 ? inputParts.reduce((sum, value) => sum + value, 0) : null;
  const modelUsage = objectValue(record.modelUsage);
  const contextWindows = modelUsage ? Object.values(modelUsage).map((value) => finiteNumber(objectValue(value)?.contextWindow)).filter((value): value is number => value !== null) : [];
  const uniqueContextWindows = [...new Set(contextWindows)];
  const contextTokens = finiteNumber(contextUsage?.totalTokens);
  const contextMax = finiteNumber(contextUsage?.maxTokens);
  const autoCompact = typeof contextUsage?.isAutoCompactEnabled === "boolean" ? contextUsage.isAutoCompactEnabled : null;
  emit({
    type: "usage",
    usage: {
      usedTokens: contextTokens,
      totalProcessedTokens: totalInput !== null && output !== null ? totalInput + output : null,
      totalProcessedScope: "run",
      maxTokens: contextMax ?? (uniqueContextWindows.length === 1 ? uniqueContextWindows[0]! : null),
      inputTokens: totalInput,
      cachedInputTokens: cached,
      cacheWriteInputTokens: cacheWrite,
      outputTokens: output,
      reasoningOutputTokens: null,
      compactsAutomatically: autoCompact,
    },
  });
}

async function readClaudeContextUsage(query: Query): Promise<Record<string, unknown> | undefined> {
  if (typeof query.getContextUsage !== "function") return undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), 2_000);
      timer.unref();
    });
    const value = await Promise.race([query.getContextUsage(), timeout]);
    return objectValue(value);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function emitText(value: string, buffer: CappedProviderBuffer, emit: (text: string) => void): void {
  const safe = bounded(value);
  buffer.append(safe);
  emit(safe);
}

function bounded(value: string): string {
  return value.slice(0, MAX_EVENT_TEXT_CHARS);
}

function summarizeInput(input: Record<string, unknown>): string {
  try { return bounded(JSON.stringify(input)); } catch { return "Claude requested permission to use a tool."; }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function deny(message: string, interrupt = false): PermissionResult {
  return { behavior: "deny", message, ...(interrupt ? { interrupt: true } : {}) };
}

function safeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? bounded(error.message) : fallback;
}

function claudeEffort(value: string | undefined): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" ? value : undefined;
}
