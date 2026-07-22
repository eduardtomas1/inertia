import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:net";

import {
  createOpencodeClient,
  type Agent,
  type Event,
  type Model,
  type OpencodeClient,
  type PermissionRuleset,
  type Provider,
  type QuestionInfo,
} from "@opencode-ai/sdk/v2";

import type { ProviderModel } from "../../shared/contracts";
import type { CodexApprovalDecision, CodexInputRequest, CodexPlanStep } from "../codex/types";
import { terminateProcessTree } from "../process-lifecycle";
import {
  createAgentHarnessEmitter,
  type AgentHarness,
  type AgentHarnessRun,
  type AgentHarnessStartOptions,
  type OpenCodeSdkHarnessCapabilities,
} from "./agent-harness";
import type { ProviderRunResult } from "./contracts";
import { CappedProviderBuffer } from "./io";

const MAX_EVENT_CHARS = 1024 * 1024;
const MAX_RESULT_TEXT_CHARS = 4 * 1024 * 1024;
const MAX_SERVER_OUTPUT_CHARS = 32 * 1024;
const START_TIMEOUT_MS = 10_000;

export const OPENCODE_SDK_CAPABILITIES = {
  lifecycle: { events: "push", terminalStatuses: ["completed", "failed", "cancelled"] },
  session: { resume: "native", identity: "session" },
  cancellation: { graceful: "protocol-interrupt", forceFallback: "process-tree-kill" },
  extension: {
    kind: "opencode-sdk",
    protocol: "owned-server-sse",
    approvals: "native",
    questions: "native",
    plans: "native",
    reasoning: "native",
    usage: "message-token-usage",
    images: "native-file-input",
    authentication: "opencode-cli",
    modelMetadata: "server-config",
  },
} as const satisfies OpenCodeSdkHarnessCapabilities;

interface PendingApproval { nativeId: string; settled: boolean }
interface PendingInput { nativeId: string; questions: QuestionInfo[]; settled: boolean }
interface OpenCodeMessageUsage {
  total: number | null;
  input: number | null;
  cachedRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  reasoning: number | null;
}
interface OpenCodeUsageState {
  maxTokens: number | null;
  currentContextTokens: number | null;
  messages: Map<string, OpenCodeMessageUsage>;
  last: OpenCodeMessageUsage | null;
  compactsAutomatically: true | null;
}

export function createOpenCodeSdkHarness(): AgentHarness {
  return {
    id: "opencode-sdk",
    providerId: "opencode",
    capabilities: OPENCODE_SDK_CAPABILITIES,
    supports: (input) => input.providerId === "opencode",
    start: startOpenCodeRun,
  };
}

function openCodeModels(providers: Provider[], defaults: Record<string, string>): ProviderModel[] {
  return providers.flatMap((provider) => Object.values(provider.models).map((model) => {
    const variants = Object.keys(model.variants ?? {});
    return {
      id: `${provider.id}/${model.id}`,
      label: model.name || model.id,
      description: [provider.name, model.family, model.status !== "active" ? model.status : undefined].filter(Boolean).join(" · ") || "OpenCode model",
      isDefault: defaults[provider.id] === model.id,
      inputModalities: model.capabilities.input.image ? ["text", "image"] : ["text"],
      reasoningOptions: variants.map((variant) => ({ value: variant, label: variant, description: `${variant} model variant` })),
      defaultReasoningEffort: variants[0] ?? "",
    } satisfies ProviderModel;
  })).slice(0, 128);
}

export async function readOpenCodeSdkModels(
  executable: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<ProviderModel[]> {
  const output = new CappedProviderBuffer(MAX_SERVER_OUTPUT_CHARS);
  const port = await availablePort();
  const started = await startOwnedServer(executable, cwd, environment, port, output);
  const client = createOpencodeClient({ baseUrl: started.url, directory: cwd, throwOnError: true });
  try {
    await waitForHealth(client, started.child);
    const response = await client.provider.list({ directory: cwd }, { throwOnError: true });
    return openCodeModels(response.data.all, response.data.default);
  } finally {
    terminateProcessTree(started.child, true);
  }
}

function startOpenCodeRun(options: AgentHarnessStartOptions): AgentHarnessRun {
  const conversationId = options.input.conversationId ?? options.input.threadId ?? "";
  const emitter = createAgentHarnessEmitter("opencode", conversationId, options.callbacks);
  const text = new CappedProviderBuffer(MAX_RESULT_TEXT_CHARS);
  const serverOutput = new CappedProviderBuffer(MAX_SERVER_OUTPUT_CHARS);
  const approvals = new Map<string, PendingApproval>();
  const inputs = new Map<string, PendingInput>();
  const eventAbort = new AbortController();
  const assistantMessages = new Set<string>();
  const emittedParts = new Map<string, string>();
  const usageState: OpenCodeUsageState = { maxTokens: null, currentContextTokens: null, messages: new Map(), last: null, compactsAutomatically: null };
  let sessionId = options.input.sessionId;
  let client: OpencodeClient | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  let cancelRequested = false;
  let terminalError: string | undefined;

  const failInteraction = (error: unknown): void => {
    terminalError = safeError(error, "OpenCode could not deliver an interactive response.");
    eventAbort.abort();
    if (child) terminateProcessTree(child, false);
  };
  const settleApproval = (requestId: string, decision: CodexApprovalDecision): boolean => {
    const pending = approvals.get(requestId);
    if (!pending || pending.settled || !client) return false;
    pending.settled = true;
    approvals.delete(requestId);
    const reply = decision === "approve" ? "once" : "reject";
    void client.permission.reply({ requestID: pending.nativeId, reply }, { throwOnError: true }).then(() => {
      emitter.rich({ type: "approval-resolved", requestId, decision });
    }).catch(failInteraction);
    return true;
  };
  const settleInput = (requestId: string, answers: Record<string, string[]>): boolean => {
    const pending = inputs.get(requestId);
    if (!pending || pending.settled || !client) return false;
    pending.settled = true;
    inputs.delete(requestId);
    const ordered = pending.questions.map((_, index) => answers[openCodeQuestionId(index, pending.questions[index]!)] ?? []);
    void client.question.reply({ requestID: pending.nativeId, answers: ordered }, { throwOnError: true }).then(() => {
      emitter.rich({ type: "input-resolved", requestId });
    }).catch(failInteraction);
    return true;
  };
  const rejectPending = (): void => {
    if (!client) return;
    for (const [requestId, pending] of approvals) {
      pending.settled = true;
      approvals.delete(requestId);
      void client.permission.reply({ requestID: pending.nativeId, reply: "reject" }, { throwOnError: true }).catch(() => {});
      emitter.rich({ type: "approval-resolved", requestId, decision: "cancelled" });
    }
    for (const [requestId, pending] of inputs) {
      pending.settled = true;
      inputs.delete(requestId);
      void client.question.reject({ requestID: pending.nativeId }, { throwOnError: true }).catch(() => {});
      emitter.rich({ type: "input-resolved", requestId });
    }
  };

  emitter.status("starting");
  const result = (async (): Promise<ProviderRunResult> => {
    try {
      const port = await availablePort();
      const started = await startOwnedServer(options.executable, options.input.cwd, options.environment, port, serverOutput);
      child = started.child;
      client = createOpencodeClient({ baseUrl: started.url, directory: options.input.cwd, throwOnError: true });
      await waitForHealth(client, child);

      const [providerData, agents] = await Promise.all([
        client.provider.list({ directory: options.input.cwd }, { throwOnError: true }),
        client.app.agents({ directory: options.input.cwd }, { throwOnError: true }),
      ]);
      const discoveredModels = openCodeModels(providerData.data.all, providerData.data.default);
      if (discoveredModels.length > 0) {
        emitter.rich({ type: "metadata", metadata: { models: discoveredModels }, source: "provider", complete: true });
      }
      const selectedModel = resolveOpenCodeModel(options.input.model, providerData.data.all);
      const agent = resolveOpenCodeAgent(options.input.interactionMode, agents.data);
      if (options.input.reasoningEffort && selectedModel && !selectedModel.variants?.[options.input.reasoningEffort]) {
        throw new Error(`OpenCode does not advertise the selected reasoning variant '${options.input.reasoningEffort}'.`);
      }

      if (sessionId) {
        await client.session.get({ sessionID: sessionId, directory: options.input.cwd }, { throwOnError: true });
        await client.session.update({ sessionID: sessionId, directory: options.input.cwd, permission: openCodePermissions(options.input.access) }, { throwOnError: true });
      } else {
        const created = await client.session.create({
          directory: options.input.cwd,
          ...(selectedModel ? { model: { id: selectedModel.id, providerID: selectedModel.providerID, ...(options.input.reasoningEffort ? { variant: options.input.reasoningEffort } : {}) } } : {}),
          ...(agent ? { agent: agent.name } : {}),
          permission: openCodePermissions(options.input.access),
        }, { throwOnError: true });
        sessionId = created.data.id;
        emitter.session(created.data.id);
      }
      if (!sessionId) throw new Error("OpenCode did not return a session ID.");

      const session = await client.session.get({ sessionID: sessionId, directory: options.input.cwd }, { throwOnError: true });
      const effectiveModel = selectedModel ?? (session.data.model ? findOpenCodeModel(session.data.model.providerID, session.data.model.id, providerData.data.all) : undefined);
      if (options.input.reasoningEffort && (!effectiveModel || !effectiveModel.variants?.[options.input.reasoningEffort])) {
        throw new Error(`The active OpenCode model does not advertise reasoning variant '${options.input.reasoningEffort}'.`);
      }
      if ((options.input.imagePaths?.length ?? 0) > 0 && effectiveModel?.capabilities.input.image !== true) {
        throw new Error("The active OpenCode model does not advertise image input support.");
      }
      usageState.maxTokens = finite(effectiveModel?.limit.context);
      const subscribed = await client.event.subscribe({ directory: options.input.cwd }, { signal: eventAbort.signal, throwOnError: true });
      emitter.status("running");
      const pump = pumpOpenCodeEvents(subscribed.stream, sessionId, {
        onEvent: (event) => handleOpenCodeEvent(event, options, client!, text, emitter, approvals, inputs, assistantMessages, emittedParts, usageState, failInteraction),
        isDone: (event) => event.type === "session.idle" || event.type === "session.error",
      });
      await client.session.promptAsync({
        sessionID: sessionId,
        directory: options.input.cwd,
        ...(effectiveModel ? { model: { providerID: effectiveModel.providerID, modelID: effectiveModel.id } } : {}),
        ...(agent ? { agent: agent.name } : {}),
        ...(options.input.reasoningEffort ? { variant: options.input.reasoningEffort } : {}),
        parts: [
          { type: "text", text: options.input.prompt },
          ...(options.input.imagePaths ?? []).map((path) => ({ type: "file" as const, mime: imageMime(path), filename: path.split(/[\\/]/u).at(-1), url: pathToFileURL(path).href })),
        ],
      }, { throwOnError: true });
      await pump;
      if (cancelRequested) return finish("cancelled");
      if (terminalError) return finish("failed", terminalError);
      return finish("completed");
    } catch (error) {
      if (cancelRequested) return finish("cancelled");
      return finish("failed", terminalError ?? safeError(error, serverDiagnostic(serverOutput)));
    } finally {
      eventAbort.abort();
      rejectPending();
      if (child) terminateProcessTree(child, true);
    }
  })();

  function finish(status: ProviderRunResult["status"], error?: string): ProviderRunResult {
    emitter.status(status, error);
    return {
      providerId: "opencode",
      conversationId,
      status,
      ...(sessionId ? { sessionId } : {}),
      text: text.toString(),
      textTruncated: text.truncated,
      exitCode: child?.exitCode ?? null,
      signal: child?.signalCode ?? null,
      ...(error ? { error } : {}),
    };
  }

  const cancel = (force: boolean): void => {
    if (cancelRequested && !force) return;
    cancelRequested = true;
    emitter.status("cancelling");
    rejectPending();
    if (!force && client && sessionId) {
      void client.session.abort({ sessionID: sessionId, directory: options.input.cwd }, { throwOnError: true }).catch(() => {
        if (child) terminateProcessTree(child, false);
      });
      return;
    }
    eventAbort.abort();
    if (child) terminateProcessTree(child, force);
  };

  return {
    harnessId: "opencode-sdk",
    providerId: "opencode",
    result,
    cancel,
    extension: { kind: "opencode-sdk", respondToApproval: settleApproval, respondToInput: settleInput },
  };
}

async function startOwnedServer(
  executable: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  port: number,
  output: CappedProviderBuffer,
): Promise<{ child: ChildProcessWithoutNullStreams; url: string }> {
  const child = spawn(executable, ["serve", "--hostname=127.0.0.1", `--port=${port}`], {
    cwd,
    env: environment,
    detached: process.platform !== "win32",
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end();
  child.stdout.on("data", (chunk: Buffer) => output.append(chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => output.append(chunk.toString("utf8")));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for the OpenCode server to start.")), START_TIMEOUT_MS);
      timer.unref();
      child.once("spawn", () => { clearTimeout(timer); resolve(); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
  } catch (error) {
    terminateProcessTree(child, true);
    throw error;
  }
  return { child, url: `http://127.0.0.1:${port}` };
}

async function waitForHealth(client: OpencodeClient, child: ChildProcessWithoutNullStreams): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("OpenCode server exited during startup.");
    try { await client.global.health({ throwOnError: true }); return; } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(safeError(lastError, "Timed out waiting for the OpenCode server health check."));
}

async function pumpOpenCodeEvents(
  stream: AsyncGenerator<Event>,
  sessionId: string,
  handlers: { onEvent: (event: Event) => void; isDone: (event: Event) => boolean },
): Promise<void> {
  for await (const event of stream) {
    const serialized = JSON.stringify(event);
    if (serialized.length > MAX_EVENT_CHARS) throw new Error("OpenCode sent an oversized event.");
    if (openCodeEventSessionId(event) !== sessionId) continue;
    handlers.onEvent(event);
    if (handlers.isDone(event)) return;
  }
  throw new Error("OpenCode closed its event stream before the session completed.");
}

function handleOpenCodeEvent(
  event: Event,
  options: AgentHarnessStartOptions,
  client: OpencodeClient,
  resultText: CappedProviderBuffer,
  emitter: ReturnType<typeof createAgentHarnessEmitter>,
  approvals: Map<string, PendingApproval>,
  inputs: Map<string, PendingInput>,
  assistantMessages: Set<string>,
  emittedParts: Map<string, string>,
  usageState: OpenCodeUsageState,
  onFailure: (error: unknown) => void,
): void {
  const properties = event.properties as Record<string, unknown>;
  if (event.type === "message.updated") {
    const info = objectValue(properties.info);
    if (info?.role === "assistant" && typeof info.id === "string") {
      assistantMessages.add(info.id);
      const tokens = objectValue(info.tokens);
      if (tokens) emitOpenCodeUsage(info.id, tokens, usageState, emitter.rich);
      const error = objectValue(info.error);
      if (error) emitter.activity("system", "failed", bounded(errorMessage(error)));
    }
  } else if (event.type === "message.part.updated") {
    const part = objectValue(properties.part);
    if (part) handleOpenCodePart(part, assistantMessages, emittedParts, resultText, emitter, usageState);
  } else if (event.type === "message.part.delta") {
    const partId = stringValue(properties.partID);
    const messageId = stringValue(properties.messageID);
    const delta = stringValue(properties.delta);
    if (partId && messageId && delta && assistantMessages.has(messageId)) {
      const next = `${emittedParts.get(partId) ?? ""}${delta}`;
      emittedParts.set(partId, next);
      emitOpenCodeText(delta, resultText, emitter.text);
    }
  } else if (event.type === "todo.updated") {
    const todos = Array.isArray(properties.todos) ? properties.todos : [];
    emitter.rich({ type: "plan", explanation: null, steps: todos.flatMap(todoStep) });
  } else if (event.type === "permission.asked" || event.type === "permission.v2.asked") {
    const nativeId = stringValue(properties.id);
    if (!nativeId) return;
    const permission = stringValue(properties.permission) ?? stringValue(properties.action) ?? "tool";
    if (options.input.access === "full" || (options.input.access === "auto-edit" && permission === "edit")) {
      void client.permission.reply({ requestID: nativeId, reply: "once" }, { throwOnError: true }).catch(onFailure);
      return;
    }
    const requestId = randomUUID();
    approvals.set(requestId, { nativeId, settled: false });
    const patterns = Array.isArray(properties.patterns) ? properties.patterns.filter((value): value is string => typeof value === "string") : [];
    const resources = Array.isArray(properties.resources) ? properties.resources.filter((value): value is string => typeof value === "string") : [];
    emitter.rich({
      type: "approval",
      request: {
        requestId,
        kind: permission === "bash" ? "command" : permission === "edit" ? "file-change" : "permissions",
        title: bounded(`OpenCode wants to use ${permission}`),
        detail: bounded([...patterns, ...resources].join("\n") || jsonSummary(properties.metadata)),
        cwd: options.input.cwd,
        permissionRoots: resources.map((path) => ({ path: bounded(path), access: "write" as const })).slice(0, 20),
        availableDecisions: ["approve", "deny", "cancel"],
      },
    });
  } else if (event.type === "question.asked" || event.type === "question.v2.asked") {
    const nativeId = stringValue(properties.id);
    const questions = Array.isArray(properties.questions) ? properties.questions.filter(isQuestionInfo) : [];
    if (!nativeId || questions.length === 0) return;
    const requestId = randomUUID();
    inputs.set(requestId, { nativeId, questions, settled: false });
    emitter.rich({ type: "input", request: openCodeQuestions(requestId, questions) });
  } else if (event.type === "session.error") {
    const error = objectValue(properties.error);
    const message = error ? errorMessage(error) : "OpenCode reported a session error.";
    emitter.activity("system", "failed", bounded(message));
    throw new Error(message);
  } else if (event.type === "session.compacted") {
    usageState.currentContextTokens = null;
    emitOpenCodeUsageSnapshot(usageState, emitter.rich);
    emitter.activity("system", "info", "OpenCode compacted the session context");
  }
}

function handleOpenCodePart(
  part: Record<string, unknown>,
  assistantMessages: Set<string>,
  emittedParts: Map<string, string>,
  resultText: CappedProviderBuffer,
  emitter: ReturnType<typeof createAgentHarnessEmitter>,
  usageState: OpenCodeUsageState,
): void {
  if (part.type === "compaction") {
    usageState.currentContextTokens = null;
    if (part.auto === true) usageState.compactsAutomatically = true;
    emitOpenCodeUsageSnapshot(usageState, emitter.rich);
  }
  const id = stringValue(part.id);
  const messageId = stringValue(part.messageID);
  if (!id || !messageId || !assistantMessages.has(messageId)) return;
  if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
    const previous = emittedParts.get(id) ?? "";
    const next = bounded(part.text);
    const delta = next.slice(commonPrefixLength(previous, next));
    emittedParts.set(id, next);
    if (!delta) return;
    if (part.type === "reasoning") emitter.rich({ type: "reasoning-summary", text: delta });
    else emitOpenCodeText(delta, resultText, emitter.text);
  } else if (part.type === "tool") {
    const state = objectValue(part.state);
    const status = stringValue(state?.status) ?? "pending";
    const phase = status === "completed" ? "completed" : status === "error" ? "failed" : "started";
    const tool = stringValue(part.tool) ?? "OpenCode tool";
    emitter.activity(tool === "bash" ? "command" : "tool", phase, bounded(stringValue(state?.title) ?? tool));
  }
}

function resolveOpenCodeModel(selection: string | undefined, providers: Provider[]): Model | undefined {
  if (!selection) return undefined;
  const slash = selection.indexOf("/");
  if (slash > 0) {
    const providerId = selection.slice(0, slash);
    const modelId = selection.slice(slash + 1);
    const model = findOpenCodeModel(providerId, modelId, providers);
    if (!model) throw new Error(`OpenCode does not advertise the selected model '${selection}'.`);
    return model;
  }
  const matches = providers.flatMap((provider) => Object.values(provider.models)).filter((model) => model.id === selection || model.name === selection);
  if (matches.length !== 1) throw new Error(`OpenCode model '${selection}' is unavailable or ambiguous; select provider/model.`);
  return matches[0];
}

function findOpenCodeModel(providerId: string, modelId: string, providers: Provider[]): Model | undefined {
  return providers.find((provider) => provider.id === providerId)?.models[modelId];
}

function resolveOpenCodeAgent(mode: "build" | "plan", agents: Agent[]): Agent | undefined {
  if (mode === "build") return undefined;
  const agent = agents.find((candidate) => candidate.name === "plan" && candidate.mode !== "subagent");
  if (!agent) throw new Error("OpenCode does not advertise its native plan agent.");
  return agent;
}

function openCodePermissions(access: "full" | "supervised" | "auto-edit"): PermissionRuleset {
  if (access === "full") return [{ permission: "*", pattern: "*", action: "allow" }];
  return [
    { permission: "*", pattern: "*", action: "ask" },
    ...(access === "auto-edit" ? [{ permission: "edit", pattern: "*", action: "allow" } as const] : []),
    { permission: "question", pattern: "*", action: "allow" },
  ];
}

function emitOpenCodeUsage(
  messageId: string,
  tokens: Record<string, unknown>,
  state: OpenCodeUsageState,
  emit: ReturnType<typeof createAgentHarnessEmitter>["rich"],
): void {
  const input = finite(tokens.input);
  const output = finite(tokens.output);
  const reasoning = finite(tokens.reasoning);
  const cache = objectValue(tokens.cache);
  const cachedRead = finite(cache?.read);
  const cacheWrite = finite(cache?.write);
  const messageUsage: OpenCodeMessageUsage = {
    total: finite(tokens.total) ?? sumTokenParts([input, output, reasoning, cachedRead, cacheWrite]),
    input,
    cachedRead,
    cacheWrite,
    output,
    reasoning,
  };
  state.messages.set(messageId, messageUsage);
  state.last = messageUsage;
  state.currentContextTokens = sumTokenParts([input, cachedRead, cacheWrite]);
  emitOpenCodeUsageSnapshot(state, emit);
}

function sumTokenParts(values: Array<number | null>): number | null {
  return values.every((value): value is number => value !== null) ? values.reduce((sum, value) => sum + value, 0) : null;
}

function emitOpenCodeUsageSnapshot(state: OpenCodeUsageState, emit: ReturnType<typeof createAgentHarnessEmitter>["rich"]): void {
  const knownTotals = [...state.messages.values()].map(({ total }) => total).filter((value): value is number => value !== null);
  const last = state.last;
  emit({
    type: "usage",
    usage: {
      usedTokens: state.currentContextTokens,
      totalProcessedTokens: state.messages.size > 0 && knownTotals.length === state.messages.size ? knownTotals.reduce((sum, value) => sum + value, 0) : null,
      totalProcessedScope: "run",
      maxTokens: state.maxTokens,
      inputTokens: last?.input ?? null,
      cachedInputTokens: last?.cachedRead ?? null,
      cacheWriteInputTokens: last?.cacheWrite ?? null,
      outputTokens: last?.output ?? null,
      reasoningOutputTokens: last?.reasoning ?? null,
      compactsAutomatically: state.compactsAutomatically,
    },
  });
}

function openCodeQuestions(requestId: string, questions: QuestionInfo[]): CodexInputRequest {
  return {
    requestId,
    autoResolutionMs: null,
    questions: questions.slice(0, 3).map((question, index) => ({
      id: openCodeQuestionId(index, question),
      header: bounded(question.header),
      question: bounded(question.question),
      isOther: question.custom !== false,
      isSecret: false,
      options: question.options.slice(0, 20).map((option) => ({ label: bounded(option.label), description: bounded(option.description) })),
    })),
  };
}

function openCodeQuestionId(index: number, question: QuestionInfo): string {
  const header = question.header.toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^-|-$/gu, "");
  return header ? `question-${index}-${header}` : `question-${index}`;
}

function todoStep(value: unknown): CodexPlanStep[] {
  const todo = objectValue(value);
  const content = stringValue(todo?.content);
  if (!content) return [];
  const status = todo?.status === "completed" ? "completed" : todo?.status === "in_progress" ? "inProgress" : "pending";
  return [{ step: bounded(content), status }];
}

function openCodeEventSessionId(event: Event): string | undefined {
  const properties = event.properties as Record<string, unknown>;
  return stringValue(properties.sessionID) ?? stringValue(objectValue(properties.info)?.sessionID);
}

function isQuestionInfo(value: unknown): value is QuestionInfo {
  const question = objectValue(value);
  return typeof question?.question === "string" && typeof question.header === "string" && Array.isArray(question.options);
}

function emitOpenCodeText(value: string, buffer: CappedProviderBuffer, emit: (value: string) => void): void {
  const safe = bounded(value);
  buffer.append(safe);
  emit(safe);
}

async function availablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : port > 0 ? resolve(port) : reject(new Error("Could not reserve a local OpenCode port.")));
    });
  });
}

function imageMime(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".png": return "image/png";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    default: throw new Error(`OpenCode does not support the attached image type: ${extname(path) || "unknown"}.`);
  }
}
function bounded(value: string): string { return value.slice(0, MAX_EVENT_CHARS); }
function commonPrefixLength(left: string, right: string): number { let index = 0; while (index < left.length && index < right.length && left[index] === right[index]) index += 1; return index; }
function objectValue(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function finite(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
function jsonSummary(value: unknown): string { try { return value === undefined ? "" : JSON.stringify(value); } catch { return ""; } }
function errorMessage(error: Record<string, unknown>): string { return stringValue(objectValue(error.data)?.message) ?? stringValue(error.message) ?? stringValue(error.name) ?? "OpenCode reported an error."; }
function safeError(error: unknown, fallback: string): string { return error instanceof Error && error.message ? bounded(error.message) : fallback; }
function serverDiagnostic(output: CappedProviderBuffer): string { const value = output.toString().trim(); return value ? bounded(`OpenCode server stopped: ${value}`) : "OpenCode server stopped unexpectedly."; }
