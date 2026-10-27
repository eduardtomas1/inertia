import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { vi } from "vitest";

import { CodexHostToolRuntime } from "../../src/server/codex/app-server-host-tools";
import { openCodexTurn } from "../../src/server/codex/app-server-run";
import type { CodexRunPhase } from "../../src/server/codex/app-server-config";
import type { JsonObject } from "../../src/server/codex/protocol";
import type { CodexAppServerOptions } from "../../src/server/codex/types";
import { RuntimeStore } from "../../src/server/database";
import { createClaudeHostTools } from "../../src/server/provider/claude-host-tools";
import type { ProviderHostToolBridge } from "../../src/server/provider/contracts";
import {
  handleProviderMcpBody,
  type ProviderMcpToolOptions,
} from "../../src/server/provider/host-tool-mcp-protocol";
import { ProviderHostToolRuntime } from "../../src/server/provider/host-tool-runtime";
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
} from "../../src/server/provider/interactions";
import type { RuntimeAgentBrowserBroker } from "../../src/server/runtime/agent-browser-broker-client";
import { AgentThreadManager } from "../../src/server/runtime/agent-thread-manager";
import { ConversationContextRequestCoordinator } from "../../src/server/runtime/conversation-context-request-coordinator";
import type { AccessMode } from "../../src/shared/contracts";
import { removeTemporaryDirectory } from "./temporary-directory";

export interface SurfaceRuntimeOptions {
  browser?: RuntimeAgentBrowserBroker;
  accessMode?: AccessMode;
}

export type SurfaceRuntime = Awaited<ReturnType<typeof createSurfaceRuntime>>;

export async function createSurfaceRuntime(options: SurfaceRuntimeOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "inertia-agent-tool-surface-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const store = new RuntimeStore(join(root, "inertia.sqlite"), workspace);
  const accessMode = options.accessMode ?? "supervised";
  const project = store.createProject("Surface project", workspace);
  const source = store.createConversation(project.id, "Parent chat", { accessMode });
  const sourceTurn = store.beginAgentTurn({
    id: randomUUID(),
    conversationId: source.id,
    runId: randomUUID(),
    content: "Coordinate the work",
    activateConversation: false,
    providerId: "codex",
    harnessId: "codex-app-server",
    backendProfileId: source.modelSelection.backendProfileId,
    model: source.modelSelection.modelId,
    modelAlias: source.modelSelection.alias,
    reasoningEffort: source.modelSelection.reasoningEffort ?? "",
    interactionMode: "build",
    accessMode,
    providerSessionBefore: null,
    usageAtStart: null,
    configurationRevision: source.modelSelection.backendConfigurationRevision,
    association: "authoritative",
  }).turn;
  const active = new Map<string, { turnId: string; runId: string }>();
  const turns = {
    isActive: (conversationId: string) => active.has(conversationId),
    activeConversationIds: () => [...active.keys()],
    activeIdentity: (conversationId: string) => active.get(conversationId) ?? null,
    queue: (request: { conversationId: string; content: string; activateConversation: boolean }) => {
      const conversation = store.conversation(request.conversationId);
      return store.beginAgentTurn({
        id: randomUUID(),
        conversationId: conversation.id,
        runId: randomUUID(),
        content: request.content,
        activateConversation: request.activateConversation,
        providerId: conversation.providerId,
        harnessId: conversation.modelSelection.harnessId,
        backendProfileId: conversation.modelSelection.backendProfileId,
        model: conversation.modelSelection.modelId,
        modelAlias: conversation.modelSelection.alias,
        reasoningEffort: conversation.modelSelection.reasoningEffort ?? "",
        interactionMode: conversation.interactionMode,
        accessMode: conversation.accessMode,
        providerSessionBefore: null,
        usageAtStart: null,
        configurationRevision: conversation.modelSelection.backendConfigurationRevision,
        association: "authoritative",
      });
    },
    start: (turnId: string) => {
      const turn = store.agentTurn(turnId);
      active.set(turn.conversationId, { turnId: turn.id, runId: turn.runId });
      return true;
    },
    failBeforeStart: vi.fn(),
    cancel: (conversationId: string) => active.delete(conversationId),
    cancelOwned: (conversationId: string, identity: { turnId: string; runId: string }) => {
      const current = active.get(conversationId);
      return current?.turnId === identity.turnId && current.runId === identity.runId
        ? active.delete(conversationId)
        : false;
    },
    waitForProviderCleanup: async () => undefined,
    acquireFollowUpAdmission: () => null,
    steer: async () => ({ kind: "rejected" }),
  };
  const contextRequests = new ConversationContextRequestCoordinator({
    pendingInputs: new Map(),
    contextPackets: store.contextPackets,
    broadcast: vi.fn(),
    broadcastConversationShell: vi.fn(),
  });
  const manager = new AgentThreadManager({
    store,
    providers: { resolveModelRoute: () => ({ providerId: "codex" }) } as never,
    backendProfileController: {
      validateSelection: (selection: unknown) => selection,
      readiness: async () => null,
    } as never,
    creation: {
      create: async (payload: Parameters<RuntimeStore["createConversation"]>[2] & {
        projectId: string;
        title: string;
      }) => store.createConversation(payload.projectId, payload.title, { ...payload, activate: false }),
    } as never,
    turns: turns as never,
    providerTerminalResumes: {
      isActive: () => false,
      acquire: () => true,
      release: () => undefined,
    },
    contextRequests,
    ...(options.browser ? { agentBrowser: options.browser } : {}),
    providerInfo: () => [{ id: "codex", canRun: true, statusMessage: null, models: [] }] as never,
    broadcastSnapshot: vi.fn(),
    broadcastConversationShell: vi.fn(),
    broadcast: vi.fn(),
    now: () => "2026-10-27T10:00:00.000Z",
  });
  const bridge = manager.bridgeFor({ conversation: source, turn: sourceTurn });
  const createManagedChat = async (title: string): Promise<string> => {
    const created = await bridge.invoke({
      providerThreadId: "setup-thread",
      providerTurnId: "setup-turn",
      toolCallId: `setup-${title}`,
      tool: "inertia_create_conversation",
      arguments: { title, prompt: `Work on ${title}` },
      signal: new AbortController().signal,
      requestApproval: async () => "approve",
    });
    if (!created.success) throw new Error(`Setup could not create a managed chat: ${created.text}`);
    return (JSON.parse(created.text) as { conversationId: string }).conversationId;
  };
  return {
    root,
    store,
    project,
    source,
    sourceTurn,
    manager,
    bridge,
    turns,
    createManagedChat,
    close: async () => {
      store.close();
      await removeTemporaryDirectory(root);
    },
  };
}

export type ToolTransport = "codex" | "mcp" | "claude";

export type ApprovalAnswer = AgentApprovalDecision | "timeout";

export interface TransportReply {
  success: boolean;
  text: string;
  protocolErrorCode?: number;
}

export interface TransportSession {
  call(tool: string, args: unknown, callId?: string): Promise<TransportReply>;
  mcpBody?(body: unknown): Promise<unknown>;
  close(): Promise<void>;
}

interface McpContent {
  type: string;
  text?: string;
}

export function mcpReply(body: unknown): TransportReply {
  const message = body as {
    result?: { content?: McpContent[]; isError?: boolean };
    error?: { code: number; message: string };
  };
  if (message.error) {
    return { success: false, text: message.error.message, protocolErrorCode: message.error.code };
  }
  const text = (message.result?.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
  return { success: message.result?.isError !== true, text };
}

const APPROVAL_TIMEOUT_MS = 5;

function answerApprovals(
  answer: ApprovalAnswer,
  respond: (requestId: string, decision: AgentApprovalDecision) => boolean,
) {
  return (request: AgentApprovalRequest): void => {
    if (answer === "timeout") return;
    queueMicrotask(() => {
      respond(request.requestId, answer);
    });
  };
}

function hostRuntime(bridge: ProviderHostToolBridge, answer: ApprovalAnswer): ProviderHostToolRuntime {
  const owner: { runtime?: ProviderHostToolRuntime } = {};
  owner.runtime = new ProviderHostToolRuntime({
    bridge,
    conversationId: "provider-thread",
    turnId: "provider-turn",
    cwd: "/project",
    onApproval: answerApprovals(answer, (id, decision) => owner.runtime!.respondToApproval(id, decision)),
    onApprovalResolved: () => undefined,
    approvalTimeoutMs: APPROVAL_TIMEOUT_MS,
  });
  return owner.runtime;
}

async function mcpSession(
  bridge: ProviderHostToolBridge,
  answer: ApprovalAnswer,
): Promise<TransportSession> {
  const runtime = hostRuntime(bridge, answer);
  const signal = new AbortController().signal;
  let nextId = 1;
  const body = async (message: unknown) => (await handleProviderMcpBody(message, runtime, signal)).body;
  return {
    mcpBody: body,
    call: async (tool, args, callId) => mcpReply(await body({
      jsonrpc: "2.0",
      id: callId ?? nextId++,
      method: "tools/call",
      params: { name: tool, arguments: args },
    })),
    close: async () => runtime.settle(),
  };
}

async function claudeSession(
  bridge: ProviderHostToolBridge,
  answer: ApprovalAnswer,
): Promise<TransportSession> {
  const runtime = hostRuntime(bridge, answer);
  const tools = createClaudeHostTools(runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "inertia-misuse-eval", version: "1.0.0" });
  await tools.config.instance.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    call: async (tool, args) => {
      try {
        const result = await client.callTool({ name: tool, arguments: args as Record<string, unknown> });
        return mcpReply({ result });
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        return {
          success: false,
          text: error instanceof Error ? error.message : String(error),
          ...(typeof code === "number" ? { protocolErrorCode: code } : {}),
        };
      }
    },
    close: async () => {
      await tools.close();
      await client.close().catch(() => undefined);
    },
  };
}

async function codexSession(
  bridge: ProviderHostToolBridge,
  answer: ApprovalAnswer,
): Promise<TransportSession> {
  const written = new Map<string | number, (message: JsonObject) => void>();
  const owner: { codex?: CodexHostToolRuntime } = {};
  owner.codex = new CodexHostToolRuntime({
    options: {
      executable: "/fake/codex",
      environment: {},
      cwd: "/project",
      prompt: "",
      planMode: false,
      access: "supervised",
      hostTools: bridge,
      hostToolApprovalTimeoutMs: APPROVAL_TIMEOUT_MS,
      onApproval: answerApprovals(answer, (id, decision) => owner.codex!.respondToApproval(id, decision)),
      onApprovalResolved: () => undefined,
    } as CodexAppServerOptions,
    isSettled: () => false,
    providerThreadId: () => "codex-thread",
    activeTurnId: () => "codex-turn",
    isOwnedTurn: () => true,
    reserveServerRequest: () => true,
    releaseServerRequest: () => undefined,
    writeMessage: (message) => {
      written.get(message.id as string | number)?.(message);
      return true;
    },
    cancel: () => undefined,
  });
  let nextId = 1;
  return {
    call: async (tool, args, callId) => {
      const id = nextId++;
      const message = new Promise<JsonObject>((resolve) => written.set(id, resolve));
      owner.codex!.handle(id, {
        threadId: "codex-thread",
        turnId: "codex-turn",
        callId: callId ?? `codex-call-${id}`,
        tool,
        arguments: args as JsonObject,
      });
      const reply = await message;
      const error = reply.error as { code: number; message: string } | undefined;
      if (error) return { success: false, text: error.message, protocolErrorCode: error.code };
      const result = reply.result as { contentItems: Array<{ type: string; text?: string }>; success: boolean };
      return {
        success: result.success,
        text: result.contentItems.filter((item) => item.type === "inputText").map((item) => item.text ?? "").join("\n"),
      };
    },
    close: async () => owner.codex!.settle("cancel"),
  };
}

export async function openToolTransport(
  transport: ToolTransport,
  bridge: ProviderHostToolBridge,
  answer: ApprovalAnswer = "approve",
): Promise<TransportSession> {
  if (transport === "codex") return await codexSession(bridge, answer);
  if (transport === "claude") return await claudeSession(bridge, answer);
  return await mcpSession(bridge, answer);
}

export interface AdvertisedSurface {
  tools: Array<Record<string, unknown> & { name: string }>;
  instructions: string | null;
}

function silentRuntime(bridge: ProviderHostToolBridge): ProviderHostToolRuntime {
  return new ProviderHostToolRuntime({
    bridge,
    conversationId: "provider-thread",
    turnId: "provider-turn",
    cwd: "/project",
    onApproval: () => undefined,
    onApprovalResolved: () => undefined,
  });
}

export async function claudeAdvertisedSurface(bridge: ProviderHostToolBridge): Promise<AdvertisedSurface> {
  const runtime = silentRuntime(bridge);
  const tools = createClaudeHostTools(runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const sent: JSONRPCMessage[] = [];
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, options) => {
    sent.push(structuredClone(message));
    await send(message, options);
  };
  const client = new Client({ name: "inertia-surface-budget", version: "1.0.0" });
  await tools.config.instance.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await client.listTools();
    const results = sent
      .map((message) => (message as { result?: Record<string, unknown> }).result)
      .filter((result): result is Record<string, unknown> => result !== undefined);
    const initialized = results.find((result) => "protocolVersion" in result);
    const listed = results.find((result) => Array.isArray(result.tools));
    return {
      tools: listed!.tools as AdvertisedSurface["tools"],
      instructions: typeof initialized?.instructions === "string" ? initialized.instructions : null,
    };
  } finally {
    await tools.close();
    await client.close().catch(() => undefined);
  }
}

export async function httpMcpAdvertisedSurface(
  bridge: ProviderHostToolBridge,
  options: ProviderMcpToolOptions,
): Promise<AdvertisedSurface> {
  const runtime = silentRuntime(bridge);
  const signal = new AbortController().signal;
  const request = async (method: string) => (await handleProviderMcpBody({
    jsonrpc: "2.0",
    id: method,
    method,
    params: method === "initialize" ? { protocolVersion: "2025-06-18" } : {},
  }, runtime, signal, options)).body as { result: Record<string, unknown> };
  const initialized = await request("initialize");
  const listed = await request("tools/list");
  runtime.settle();
  return {
    tools: listed.result.tools as AdvertisedSurface["tools"],
    instructions: typeof initialized.result.instructions === "string" ? initialized.result.instructions : null,
  };
}

export async function codexAdvertisedSurface(bridge: ProviderHostToolBridge): Promise<AdvertisedSurface> {
  const calls: Array<{ method: string; params: JsonObject }> = [];
  let activeTurnId: string | undefined;
  let phase: CodexRunPhase = "opening";
  await openCodexTurn({
    options: {
      executable: "/fake/codex",
      environment: {},
      cwd: "/workspace",
      prompt: "Surface budget",
      planMode: false,
      access: "supervised",
      hostTools: bridge,
    },
    modelProvider: undefined,
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "initialize") return { userAgent: "fake" };
      if (method === "thread/start") return { thread: { id: "surface-thread" }, model: "fake" };
      if (method === "turn/start") return { turn: { id: "surface-turn", status: "inProgress" } };
      throw new Error(`Unexpected Codex request: ${method}`);
    },
    notify: vi.fn(),
    setProviderThreadId: vi.fn(),
    activeTurnId: () => activeTurnId,
    setActiveTurnId: (value) => {
      activeTurnId = value;
    },
    phase: () => phase,
    hasObservedTurn: () => false,
    goalProjectionSequence: () => 0,
    beginGoalMutation: vi.fn(),
    endGoalMutation: vi.fn(),
    awaitInitialGoalTurn: vi.fn(),
    projectGoalResponse: () => null,
    setContinuationError: vi.fn(),
    setPhase: (value) => {
      phase = value;
    },
    isSettled: () => false,
    isCancelRequested: () => false,
    finish: vi.fn(),
  });
  const started = calls.find(({ method }) => method === "thread/start");
  return {
    tools: started!.params.dynamicTools as unknown as AdvertisedSurface["tools"],
    instructions: null,
  };
}
