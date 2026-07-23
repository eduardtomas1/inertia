import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { Readable, Transform, Writable, type TransformCallback } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
import type {
  ContentBlock,
  InitializeResponse,
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionModeState,
  SessionNotification,
  Usage,
} from "@agentclientprotocol/sdk";

import type { ProviderModel } from "../../shared/contracts";
import { INERTIA_VERSION } from "../../shared/version";
import { terminateProcessTree } from "../process-lifecycle";
import {
  createAgentHarnessEmitter,
  type AgentHarness,
  type AgentHarnessRun,
  type AgentHarnessStartOptions,
  type CursorAcpHarnessCapabilities,
} from "./agent-harness";
import type { ProviderRunResult } from "./contracts";
import type {
  AgentApprovalDecision,
  AgentInputRequest,
  AgentPlanStep,
} from "./interactions";
import { CappedProviderBuffer } from "./io";

const MAX_WIRE_LINE_BYTES = 1024 * 1024;
const MAX_EVENT_TEXT_CHARS = 1024 * 1024;
const MAX_RESULT_TEXT_CHARS = 4 * 1024 * 1024;
const MAX_STDERR_CHARS = 32 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export const CURSOR_ACP_CAPABILITIES = {
  lifecycle: { events: "push", terminalStatuses: ["completed", "failed", "cancelled"] },
  session: { resume: "native", identity: "session" },
  cancellation: { graceful: "protocol-interrupt", forceFallback: "process-tree-kill" },
  extension: {
    kind: "cursor-acp",
    protocol: "acp-v1-json-rpc",
    approvals: "native",
    questions: "cursor-extension",
    plans: "native",
    reasoning: "native",
    usage: "optional-acp-v1",
    images: "capability-negotiated",
    authentication: "cursor-cli",
    modelMetadata: "session-config-options",
  },
} as const satisfies CursorAcpHarnessCapabilities;

interface PendingApproval { resolve: (decision: AgentApprovalDecision) => void; settled: boolean }
interface PendingInput { resolve: (answers: Record<string, string[]>) => void; settled: boolean }
interface CursorContextUsage { usedTokens: number | null; maxTokens: number | null }

export function createCursorAcpHarness(): AgentHarness {
  return {
    id: "cursor-acp",
    providerId: "cursor",
    capabilities: CURSOR_ACP_CAPABILITIES,
    supports: (input) => input.providerId === "cursor",
    start: startCursorRun,
  };
}

function startCursorRun(options: AgentHarnessStartOptions): AgentHarnessRun {
  const conversationId = options.input.conversationId ?? options.input.threadId ?? "";
  const emitter = createAgentHarnessEmitter("cursor", conversationId, options.callbacks);
  const resultText = new CappedProviderBuffer(MAX_RESULT_TEXT_CHARS);
  const stderr = new CappedProviderBuffer(MAX_STDERR_CHARS);
  const approvals = new Map<string, PendingApproval>();
  const inputs = new Map<string, PendingInput>();
  let sessionId = options.input.sessionId;
  let cancelRequested = false;
  let supportsImages = false;
  const contextUsage: CursorContextUsage = { usedTokens: null, maxTokens: null };
  let activeContext: acp.ClientContext | undefined;
  let child: ChildProcessWithoutNullStreams;

  const settleApproval = (requestId: string, decision: AgentApprovalDecision): boolean => {
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

  const client = acp.client({ name: "Inertia" })
    .onRequest(acp.methods.client.session.requestPermission, async ({ params, signal }) => {
      if (!sessionId || params.sessionId !== sessionId) return { outcome: { outcome: "cancelled" } };
      return await cursorPermission(params, signal, options, emitter.rich, approvals);
    })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      if (!sessionId || params.sessionId !== sessionId) return;
      handleCursorUpdate(params, resultText, emitter, supportsImages, contextUsage);
    })
    .onRequest("cursor/ask_question", parseCursorQuestionRequest, async ({ params, signal }) => {
      if (cancelRequested) return { outcome: "cancelled" };
      const requestId = randomUUID();
      const request = cursorQuestions(requestId, params);
      const answers = await new Promise<Record<string, string[]>>((resolve) => {
        inputs.set(requestId, { resolve, settled: false });
        signal.addEventListener("abort", () => settleInput(requestId, {}), { once: true });
        emitter.rich({ type: "input", request });
      });
      if (signal.aborted || cancelRequested) return { outcome: "cancelled" };
      return {
        outcome: "answered",
        answers: params.questions.map((question) => ({
          questionId: question.id,
          selectedOptionIds: (answers[question.id] ?? []).flatMap((answer) => {
            const option = question.options.find((candidate) => candidate.id === answer || candidate.label === answer);
            // Cursor's extension only names this field for option IDs. Current
            // agents also accept a raw value here for the native "Other"
            // answer; dropping it would falsely report that the user answered.
            return [option?.id ?? answer];
          }),
        })),
      };
    })
    .onRequest("cursor/create_plan", parseCursorPlanRequest, ({ params }) => {
      emitter.rich({ type: "plan", explanation: params.plan, steps: cursorTodoSteps(params.todos, params.plan) });
      return { accepted: true };
    })
    .onNotification("cursor/update_todos", parseCursorTodosRequest, ({ params }) => {
      emitter.rich({ type: "plan", explanation: null, steps: cursorTodoSteps(params.todos) });
    });

  emitter.status("starting");
  try {
    child = spawn(options.executable, ["acp"], {
      cwd: options.input.cwd,
      env: options.environment,
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    return failedCursorRun(conversationId, safeError(error, "Cursor ACP could not be started."), emitter);
  }
  child.once("error", (error) => stderr.append(safeError(error, "Cursor ACP could not be started.")));
  child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk.toString("utf8")));
  child.stdin.on("error", () => { /* Connection failure is surfaced by the ACP SDK. */ });
  const wireGuard = new BoundedJsonLineTransform(MAX_WIRE_LINE_BYTES);
  child.stdout.pipe(wireGuard);
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(wireGuard) as ReadableStream<Uint8Array>,
  );

  const result = client.connectWith(stream, async (context): Promise<ProviderRunResult> => {
    activeContext = context;
    const initialized = await context.request(acp.methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "Inertia", version: INERTIA_VERSION },
    });
    validateCursorInitialize(initialized);
    supportsImages = initialized.agentCapabilities?.promptCapabilities?.image === true;
    const cursorLogin = initialized.authMethods?.find((method) => method.id === "cursor_login");
    if (cursorLogin) await context.request(acp.methods.agent.authenticate, { methodId: cursorLogin.id });

    let modes: SessionModeState | null | undefined;
    let configOptions: SessionConfigOption[] | null | undefined;
    if (options.input.sessionId) {
      if (initialized.agentCapabilities?.loadSession !== true) throw new Error("This Cursor ACP server does not advertise session resume support.");
      const loaded = await context.request(acp.methods.agent.session.load, {
        sessionId: options.input.sessionId,
        cwd: options.input.cwd,
        mcpServers: [],
      });
      modes = loaded?.modes;
      configOptions = loaded?.configOptions;
    } else {
      const created = await context.request(acp.methods.agent.session.new, { cwd: options.input.cwd, mcpServers: [] });
      sessionId = created.sessionId;
      emitter.session(sessionId);
      modes = created.modes;
      configOptions = created.configOptions;
    }
    if (!sessionId) throw new Error("Cursor ACP did not return a session ID.");
    emitCursorMetadata(configOptions ?? [], supportsImages, emitter.rich);
    await configureCursorSession(context, sessionId, modes, configOptions ?? [], options.input.interactionMode, options.input.model, options.input.reasoningEffort);
    const prompt = await cursorPrompt(options.input.prompt, options.input.imagePaths ?? [], initialized);
    emitter.status("running");
    const response = await context.request(acp.methods.agent.session.prompt, { sessionId, prompt });
    if (response.usage) emitCursorPromptUsage(response.usage, contextUsage, emitter.rich);
    if (cancelRequested || response.stopReason === "cancelled") return finish("cancelled");
    if (response.stopReason !== "end_turn") return finish("failed", `Cursor stopped with reason: ${response.stopReason}.`);
    return finish("completed");
  }).catch((error: unknown) => {
    if (cancelRequested) return finish("cancelled");
    const diagnostic = stderr.toString().trim();
    const message = safeError(error, diagnostic ? `Cursor ACP stopped: ${diagnostic}` : "Cursor ACP stopped unexpectedly.");
    return finish("failed", message);
  }).finally(() => {
    cancelPending();
    terminateProcessTree(child, true);
  });

  function finish(status: ProviderRunResult["status"], error?: string): ProviderRunResult {
    emitter.status(status, error);
    return {
      providerId: "cursor",
      conversationId,
      status,
      ...(sessionId ? { sessionId } : {}),
      text: resultText.toString(),
      textTruncated: resultText.truncated,
      exitCode: child.exitCode,
      signal: child.signalCode,
      ...(error ? { error } : {}),
    };
  }

  const cancel = (force: boolean): void => {
    if (cancelRequested && !force) return;
    cancelRequested = true;
    emitter.status("cancelling");
    cancelPending();
    if (!force && sessionId && activeContext) {
      void activeContext.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => terminateProcessTree(child, false));
      return;
    }
    terminateProcessTree(child, force);
  };

  return {
    harnessId: "cursor-acp",
    providerId: "cursor",
    result,
    cancel,
    extension: { kind: "cursor-acp", respondToApproval: settleApproval, respondToInput: settleInput },
  };
}

async function cursorPermission(
  params: RequestPermissionRequest,
  signal: AbortSignal,
  options: AgentHarnessStartOptions,
  emit: ReturnType<typeof createAgentHarnessEmitter>["rich"],
  approvals: Map<string, PendingApproval>,
): Promise<RequestPermissionResponse> {
  const allow = permissionOption(params.options, true);
  if (options.input.access === "full" || (options.input.access === "auto-edit" && params.toolCall.kind === "edit")) {
    return allow ? { outcome: { outcome: "selected", optionId: allow.optionId } } : { outcome: { outcome: "cancelled" } };
  }
  const requestId = randomUUID();
  const decision = await new Promise<AgentApprovalDecision>((resolve) => {
    approvals.set(requestId, { resolve, settled: false });
    signal.addEventListener("abort", () => {
      const pending = approvals.get(requestId);
      if (!pending || pending.settled) return;
      pending.settled = true;
      approvals.delete(requestId);
      emit({ type: "approval-resolved", requestId, decision: "cancelled" });
      resolve("cancel");
    }, { once: true });
    emit({
      type: "approval",
      request: {
        requestId,
        kind: params.toolCall.kind === "execute" ? "command" : params.toolCall.kind === "edit" || params.toolCall.kind === "delete" || params.toolCall.kind === "move" ? "file-change" : "permissions",
        title: bounded(params.toolCall.title || "Cursor requested permission"),
        detail: bounded(jsonSummary(params.toolCall.rawInput)),
        cwd: options.input.cwd,
        permissionRoots: [],
        availableDecisions: ["approve", "deny", "cancel"],
      },
    });
  });
  if (decision === "cancel") return { outcome: { outcome: "cancelled" } };
  const selected = permissionOption(params.options, decision === "approve");
  return selected ? { outcome: { outcome: "selected", optionId: selected.optionId } } : { outcome: { outcome: "cancelled" } };
}

function permissionOption(options: PermissionOption[], allow: boolean): PermissionOption | undefined {
  const kinds = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  return kinds.flatMap((kind) => options.filter((option) => option.kind === kind)).at(0);
}

function handleCursorUpdate(
  notification: SessionNotification,
  resultText: CappedProviderBuffer,
  emitter: ReturnType<typeof createAgentHarnessEmitter>,
  supportsImages: boolean,
  contextUsage: CursorContextUsage,
): void {
  const update = notification.update;
  if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
    const value = bounded(update.content.text);
    resultText.append(value);
    emitter.text(value);
  } else if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text") {
    emitter.rich({ type: "reasoning-summary", text: bounded(update.content.text) });
  } else if (update.sessionUpdate === "tool_call") {
    emitter.activity(update.kind === "execute" ? "command" : "tool", "started", bounded(update.title));
  } else if (update.sessionUpdate === "tool_call_update") {
    const phase = update.status === "failed" ? "failed" : update.status === "completed" ? "completed" : "info";
    emitter.activity(update.kind === "execute" ? "command" : "tool", phase, bounded(update.title ?? update.name ?? "Cursor tool"));
  } else if (update.sessionUpdate === "plan") {
    emitter.rich({ type: "plan", explanation: null, steps: update.entries.map((entry) => ({ step: bounded(entry.content), status: entry.status === "in_progress" ? "inProgress" : entry.status })) });
  } else if (update.sessionUpdate === "usage_update") {
    contextUsage.usedTokens = tokenCount(update.used);
    contextUsage.maxTokens = tokenCount(update.size);
    emitter.rich({
      type: "usage",
      usage: {
        usedTokens: contextUsage.usedTokens,
        totalProcessedTokens: null,
        totalProcessedScope: "session",
        maxTokens: contextUsage.maxTokens,
        inputTokens: null,
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
        outputTokens: null,
        reasoningOutputTokens: null,
        compactsAutomatically: null,
      },
    });
  } else if (update.sessionUpdate === "config_option_update") {
    emitCursorMetadata(update.configOptions, supportsImages, emitter.rich);
  }
}

function cursorSelectChoices(option: SessionConfigOption | undefined): Array<{ value: string; name: string; description?: string | null }> {
  if (!option || option.type !== "select") return [];
  return option.options.flatMap((entry) => "options" in entry ? entry.options : [entry]).slice(0, 64);
}

function emitCursorMetadata(
  configOptions: SessionConfigOption[],
  supportsImages: boolean,
  emit: ReturnType<typeof createAgentHarnessEmitter>["rich"],
): void {
  const modelOption = configOptions.find((option) => option.type === "select" && option.category === "model");
  const models = cursorSelectChoices(modelOption);
  if (!modelOption || modelOption.type !== "select" || models.length === 0) return;
  const effortOption = configOptions.find((option) => option.type === "select" && option.category === "thought_level");
  const efforts = cursorSelectChoices(effortOption).slice(0, 12);
  const defaultEffort = effortOption?.type === "select" && typeof effortOption.currentValue === "string"
    ? effortOption.currentValue
    : "";
  const metadata: ProviderModel[] = models.map((model) => ({
    id: bounded(model.value),
    label: bounded(model.name || model.value),
    description: bounded(model.description || "Cursor session model"),
    isDefault: modelOption.currentValue === model.value,
    inputModalities: supportsImages ? ["text", "image"] : ["text"],
    reasoningOptions: efforts.map((effort) => ({
      value: bounded(effort.value),
      label: bounded(effort.name || effort.value),
      description: bounded(effort.description || `${effort.name || effort.value} reasoning`),
    })),
    defaultReasoningEffort: defaultEffort,
  }));
  emit({ type: "metadata", metadata: { models: metadata }, source: "session", complete: true });
}

async function configureCursorSession(
  context: acp.ClientContext,
  sessionId: string,
  modes: SessionModeState | null | undefined,
  configOptions: SessionConfigOption[],
  interactionMode: "build" | "plan",
  model?: string,
  effort?: string,
): Promise<void> {
  const wantedMode = interactionMode === "plan" ? /plan|architect/iu : /build|agent|code/iu;
  const nativeMode = modes?.availableModes.find((mode) => wantedMode.test(`${mode.id} ${mode.name}`));
  const configMode = findConfigValue(configOptions, "mode", interactionMode === "plan" ? "plan" : "build", wantedMode);
  if (nativeMode && modes?.currentModeId !== nativeMode.id) {
    await context.request(acp.methods.agent.session.setMode, { sessionId, modeId: nativeMode.id });
  } else if (!nativeMode && configMode) {
    await context.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: configMode.id, value: configMode.value });
  } else if (interactionMode === "plan" && !nativeMode) {
    throw new Error("This Cursor ACP server does not advertise a plan mode.");
  }
  if (model) {
    const selected = findConfigValue(configOptions, "model", model);
    if (!selected) throw new Error(`Cursor ACP does not advertise the selected model '${model}'.`);
    await context.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: selected.id, value: selected.value });
  }
  if (effort) {
    const selected = findConfigValue(configOptions, "thought_level", effort);
    if (!selected) throw new Error(`Cursor ACP does not advertise the selected reasoning effort '${effort}'.`);
    await context.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: selected.id, value: selected.value });
  }
}

function findConfigValue(
  configOptions: SessionConfigOption[],
  category: string,
  wanted: string,
  fallbackPattern?: RegExp,
): { id: string; value: string } | undefined {
  const option = configOptions.find((candidate) => candidate.type === "select" && candidate.category === category);
  if (!option || option.type !== "select") return undefined;
  const choices = option.options.flatMap((entry) => "options" in entry ? entry.options : [entry]);
  const wantedLower = wanted.toLowerCase();
  const selected = choices.find((choice) => choice.value.toLowerCase() === wantedLower || choice.name.toLowerCase() === wantedLower)
    ?? (fallbackPattern ? choices.find((choice) => fallbackPattern.test(`${choice.value} ${choice.name}`)) : undefined);
  return selected ? { id: option.id, value: selected.value } : undefined;
}

async function cursorPrompt(prompt: string, paths: readonly string[], initialized: InitializeResponse): Promise<ContentBlock[]> {
  if (paths.length > 0 && initialized.agentCapabilities?.promptCapabilities?.image !== true) {
    throw new Error("This Cursor ACP server did not advertise image prompt support.");
  }
  const blocks: ContentBlock[] = [];
  let total = 0;
  for (const path of paths) {
    const mimeType = imageMediaType(path);
    if (!mimeType) throw new Error(`Cursor does not support the attached image type: ${extname(path) || "unknown"}.`);
    const data = await readFile(path);
    total += data.byteLength;
    if (total > MAX_IMAGE_BYTES) throw new Error("Cursor image attachments exceed the 20 MB safety limit.");
    blocks.push({ type: "image", mimeType, data: data.toString("base64") });
  }
  blocks.push({ type: "text", text: prompt });
  return blocks;
}

function validateCursorInitialize(initialized: InitializeResponse): void {
  if (initialized.protocolVersion !== 1) throw new Error(`Unsupported Cursor ACP protocol version: ${initialized.protocolVersion}.`);
  const name = initialized.agentInfo?.name?.toLowerCase() ?? "";
  if (name && !name.includes("cursor")) throw new Error(`The selected executable exposed ACP as '${initialized.agentInfo?.name}', not Cursor.`);
}

function emitCursorPromptUsage(
  usage: Usage,
  contextUsage: CursorContextUsage,
  emit: ReturnType<typeof createAgentHarnessEmitter>["rich"],
): void {
  emit({
    type: "usage",
    usage: {
      usedTokens: contextUsage.usedTokens,
      totalProcessedTokens: tokenCount(usage.totalTokens),
      totalProcessedScope: "session",
      maxTokens: contextUsage.maxTokens,
      inputTokens: tokenCount(usage.inputTokens),
      cachedInputTokens: tokenCount(usage.cachedReadTokens),
      cacheWriteInputTokens: tokenCount(usage.cachedWriteTokens),
      outputTokens: tokenCount(usage.outputTokens),
      reasoningOutputTokens: tokenCount(usage.thoughtTokens),
      compactsAutomatically: null,
    },
  });
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

interface CursorQuestionParams {
  toolCallId: string;
  title?: string;
  questions: Array<{ id: string; prompt: string; options: Array<{ id: string; label: string }>; allowMultiple?: boolean }>;
}
interface CursorPlanParams { toolCallId: string; plan: string; todos: CursorTodo[] }
interface CursorTodosParams { toolCallId: string; todos: CursorTodo[]; merge: boolean }
interface CursorTodo { id?: string; content?: string; title?: string; status?: string }

function parseCursorQuestionRequest(value: unknown): CursorQuestionParams {
  const record = requireObject(value, "Cursor question request");
  const rawQuestions = requireArray(record.questions, "questions");
  return {
    toolCallId: requireString(record.toolCallId, "toolCallId"),
    ...(typeof record.title === "string" ? { title: bounded(record.title) } : {}),
    questions: rawQuestions.slice(0, 3).map((raw) => {
      const question = requireObject(raw, "question");
      return {
        id: requireNativeId(question.id, "question.id", 120),
        prompt: requireString(question.prompt, "question.prompt"),
        options: requireArray(question.options, "question.options").slice(0, 20).map((rawOption) => {
          const option = requireObject(rawOption, "question option");
          return {
            id: requireNativeId(option.id, "option.id", 160),
            label: requireString(option.label, "option.label"),
          };
        }),
        ...(typeof question.allowMultiple === "boolean" ? { allowMultiple: question.allowMultiple } : {}),
      };
    }),
  };
}

function parseCursorPlanRequest(value: unknown): CursorPlanParams {
  const record = requireObject(value, "Cursor plan request");
  return { toolCallId: requireString(record.toolCallId, "toolCallId"), plan: requireString(record.plan, "plan"), todos: parseTodos(record.todos) };
}

function parseCursorTodosRequest(value: unknown): CursorTodosParams {
  const record = requireObject(value, "Cursor todo request");
  if (typeof record.merge !== "boolean") throw new Error("Cursor todo request is missing merge.");
  return { toolCallId: requireString(record.toolCallId, "toolCallId"), todos: parseTodos(record.todos), merge: record.merge };
}

function parseTodos(value: unknown): CursorTodo[] {
  return requireArray(value, "todos").slice(0, 100).map((raw) => {
    const todo = requireObject(raw, "todo");
    return {
      ...(typeof todo.id === "string" ? { id: bounded(todo.id) } : {}),
      ...(typeof todo.content === "string" ? { content: bounded(todo.content) } : {}),
      ...(typeof todo.title === "string" ? { title: bounded(todo.title) } : {}),
      ...(typeof todo.status === "string" ? { status: todo.status } : {}),
    };
  });
}

function cursorQuestions(requestId: string, params: CursorQuestionParams): AgentInputRequest {
  return {
    requestId,
    autoResolutionMs: null,
    questions: params.questions.map((question) => ({
      id: question.id,
      header: bounded(params.title ?? "Question"),
      question: bounded(question.prompt),
      isOther: true,
      isSecret: false,
      allowMultiple: question.allowMultiple === true,
      options: question.options.map((option) => ({
        id: bounded(option.id),
        label: bounded(option.label),
        description: "",
      })),
    })),
  };
}

function cursorTodoSteps(todos: CursorTodo[], fallback?: string): AgentPlanStep[] {
  const steps = todos.flatMap((todo) => {
    const step = todo.content?.trim() || todo.title?.trim();
    if (!step) return [];
    return [{ step: bounded(step), status: todo.status === "completed" ? "completed" as const : todo.status === "in_progress" || todo.status === "inProgress" ? "inProgress" as const : "pending" as const }];
  });
  return steps.length > 0 ? steps : fallback ? [{ step: bounded(fallback), status: "pending" }] : [];
}

class BoundedJsonLineTransform extends Transform {
  private pending = Buffer.alloc(0);
  constructor(private readonly maxLineBytes: number) { super(); }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.pending = Buffer.concat([this.pending, chunk]);
      if (this.pending.length > this.maxLineBytes && !this.pending.includes(0x0a)) throw new Error("Cursor ACP sent an oversized JSON-RPC frame.");
      let newline: number;
      while ((newline = this.pending.indexOf(0x0a)) >= 0) {
        const line = this.pending.subarray(0, newline);
        this.pending = this.pending.subarray(newline + 1);
        this.validateAndPush(line);
      }
      callback();
    } catch (error) { callback(error as Error); }
  }
  override _flush(callback: TransformCallback): void {
    try { if (this.pending.length > 0) this.validateAndPush(this.pending); callback(); } catch (error) { callback(error as Error); }
  }
  private validateAndPush(line: Buffer): void {
    if (line.length === 0) return;
    if (line.length > this.maxLineBytes) throw new Error("Cursor ACP sent an oversized JSON-RPC frame.");
    const parsed: unknown = JSON.parse(line.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Cursor ACP sent a malformed JSON-RPC frame.");
    this.push(Buffer.concat([line, Buffer.from("\n")]));
  }
}

function failedCursorRun(conversationId: string, message: string, emitter: ReturnType<typeof createAgentHarnessEmitter>): AgentHarnessRun {
  emitter.status("failed", message);
  return {
    harnessId: "cursor-acp",
    providerId: "cursor",
    result: Promise.resolve({ providerId: "cursor", conversationId, status: "failed", text: "", textTruncated: false, exitCode: null, signal: null, error: message }),
    cancel: () => {},
    extension: { kind: "cursor-acp", respondToApproval: () => false, respondToInput: () => false },
  };
}

function imageMediaType(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".png": return "image/png";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    default: return undefined;
  }
}
function bounded(value: string): string { return value.slice(0, MAX_EVENT_TEXT_CHARS); }
function safeError(error: unknown, fallback: string): string { return error instanceof Error && error.message ? bounded(error.message) : fallback; }
function jsonSummary(value: unknown): string { try { return value === undefined ? "Cursor requested permission." : JSON.stringify(value); } catch { return "Cursor requested permission."; } }
function requireObject(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`); return value as Record<string, unknown>; }
function requireArray(value: unknown, label: string): unknown[] { if (!Array.isArray(value)) throw new Error(`${label} must be an array.`); return value; }
function requireString(value: unknown, label: string): string { if (typeof value !== "string" || value.length === 0 || value.length > MAX_EVENT_TEXT_CHARS) throw new Error(`${label} must be a bounded non-empty string.`); return value; }
function requireNativeId(value: unknown, label: string, maxLength: number): string {
  const id = requireString(value, label);
  if (id.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters.`);
  return id;
}
