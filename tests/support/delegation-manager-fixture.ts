import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type Database from "better-sqlite3";
import { vi } from "vitest";

import type { AgentApprovalRequest, AgentInputRequest, AgentTurn, Conversation } from "../../src/shared/contracts";
import { RuntimeStore } from "../../src/server/database";
import type { ProviderHostToolCall, ProviderHostToolResult } from "../../src/server/provider/contracts";
import type { AgentApprovalDecision } from "../../src/server/provider/interactions";
import { AgentThreadManager } from "../../src/server/runtime/agent-thread-manager";
import { ConversationContextRequestCoordinator } from "../../src/server/runtime/conversation-context-request-coordinator";
import { DelegationTaskService } from "../../src/server/runtime/delegation/task-service";

const roots: string[] = [];
let callSequence = 0;

export interface DelegationManagerFixture {
  store: RuntimeStore;
  database: Database.Database;
  manager: AgentThreadManager;
  service: DelegationTaskService;
  source: Conversation;
  sourceTurn: AgentTurn;
  approvals: Map<string, AgentApprovalRequest>;
  inputs: Map<string, AgentInputRequest>;
  live: Map<string, number>;
  offers: string[];
  starts: string[];
  active: Map<string, { turnId: string; runId: string }>;
  turns: ReturnType<typeof fakeTurns>;
  invoke(tool: string, args: unknown, options?: CallOptions): Promise<ProviderHostToolResult>;
  invokeAs(source: { conversation: Conversation; turn: AgentTurn }, tool: string, args: unknown, options?: CallOptions):
    Promise<ProviderHostToolResult>;
  call(tool: string, args: unknown, options?: CallOptions): ProviderHostToolCall;
  beginTurn(conversationId: string, content?: string): AgentTurn;
  settle(turnId: string, status: "completed" | "failed" | "cancelled" | "interrupted", text?: string): Promise<AgentTurn>;
  drain(): Promise<void>;
  close(): Promise<void>;
}

export interface CallOptions {
  decision?: AgentApprovalDecision | "timeout";
  toolCallId?: string;
  signal?: AbortSignal;
  approval?: ProviderHostToolCall["requestApproval"];
}

export function parsed<T = Record<string, unknown>>(result: ProviderHostToolResult): T {
  return JSON.parse(result.text) as T;
}

export function errorCode(result: ProviderHostToolResult): string | undefined {
  return result.success ? undefined : (JSON.parse(result.text) as { error: { code: string } }).error.code;
}

export function settleTurnRow(store: RuntimeStore, database: Database.Database, turnId: string,
  status: "completed" | "failed" | "cancelled" | "interrupted", text?: string): void {
  const turn = store.agentTurn(turnId);
  const message = text === undefined ? null : store.createMessage(turn.conversationId, text, "assistant", [], turnId);
  const reason = status === "completed" ? "provider-completed" : status === "failed" ? "provider-error"
    : status === "cancelled" ? "user-cancelled" : "runtime-crash";
  database.prepare(`UPDATE agent_turns SET status = ?, run_state = ?, terminal_reason = ?,
    terminal_assistant_message_id = ?, started_at = COALESCE(started_at, requested_at),
    completed_at = COALESCE(started_at, requested_at), updated_at = MAX(updated_at, COALESCE(started_at, requested_at))
    WHERE id = ?`).run(status, status, reason, message?.id ?? null, turnId);
}

export function beginStoreTurn(store: RuntimeStore, conversationId: string, content: string) {
  const conversation = store.conversation(conversationId);
  return store.beginAgentTurn({
    id: randomUUID(), conversationId, runId: randomUUID(), content, activateConversation: false,
    providerId: conversation.providerId, harnessId: conversation.modelSelection.harnessId,
    backendProfileId: conversation.modelSelection.backendProfileId, model: conversation.modelSelection.modelId,
    modelAlias: conversation.modelSelection.alias, reasoningEffort: conversation.modelSelection.reasoningEffort ?? "",
    interactionMode: conversation.interactionMode, accessMode: conversation.accessMode, providerSessionBefore: null,
    usageAtStart: null, configurationRevision: conversation.modelSelection.backendConfigurationRevision,
    association: "authoritative",
  });
}

function fakeTurns(store: RuntimeStore, database: Database.Database, onSettled: (turn: AgentTurn) => void) {
  const active = new Map<string, { turnId: string; runId: string }>();
  const starts: string[] = [];
  const steers: string[] = [];
  const stopped: string[] = [];
  let followUpAdmission = true;
  const begin = (conversationId: string, content: string) => beginStoreTurn(store, conversationId, content);
  return {
    active, starts, steers, stopped, begin,
    acquireTurnAdmission: async (conversationId: string) => active.has(conversationId) ? null
      : { conversationId, token: Symbol("test-admission"), release: () => undefined },
    isActive: (conversationId: string) => active.has(conversationId),
    activeConversationIds: () => [...active.keys()],
    activeIdentity: (conversationId: string) => active.get(conversationId) ?? null,
    queue: (request: { conversationId: string; content: string }) => begin(request.conversationId, request.content),
    start: (turnId: string) => {
      const turn = store.agentTurn(turnId);
      starts.push(turnId);
      active.set(turn.conversationId, { turnId: turn.id, runId: turn.runId });
      return true;
    },
    failBeforeStart: vi.fn(),
    cancel: (conversationId: string) => active.delete(conversationId),
    cancelOwned: (conversationId: string, identity: { turnId: string; runId: string }) => {
      const current = active.get(conversationId);
      if (current?.turnId !== identity.turnId || current.runId !== identity.runId) return false;
      active.delete(conversationId);
      stopped.push(identity.turnId);
      settleTurnRow(store, database, identity.turnId, "cancelled");
      onSettled(store.agentTurn(identity.turnId));
      return true;
    },
    waitForProviderCleanup: async () => true,
    acquireFollowUpAdmission: (conversationId: string) => (
      active.has(conversationId) && followUpAdmission
        ? { conversationId, ...active.get(conversationId)!, supportsImages: false, release: vi.fn() }
        : null
    ),
    setFollowUpAdmission: (accepted: boolean) => { followUpAdmission = accepted; },
    steer: async (lease: { turnId: string }, input: { content: string }, _attachments: unknown, acknowledged?: () => void) => {
      steers.push(input.content);
      acknowledged?.();
      return { kind: "accepted", message: { id: randomUUID(), turnId: lease.turnId } };
    },
  };
}

export async function createDelegationManagerFixture(options: { pollMs?: number } = {}): Promise<DelegationManagerFixture> {
  const root = await mkdtemp(join(tmpdir(), "inertia-delegation-manager-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const store = new RuntimeStore(join(root, "inertia.sqlite"), workspace);
  const database = (store as unknown as { database: Database.Database }).database;
  const project = store.createProject("Delegation project", workspace);
  const approvals = new Map<string, AgentApprovalRequest>();
  const inputs = new Map<string, AgentInputRequest>();
  const live = new Map<string, number>();
  const offers: string[] = [];
  const pending = new Set<Promise<unknown>>();
  let service!: DelegationTaskService;
  const track = (promise: Promise<unknown>) => {
    const tracked = promise.catch(() => undefined).finally(() => pending.delete(tracked));
    pending.add(tracked);
  };
  const turns = fakeTurns(store, database, (turn) => track(service.onTurnSettled(turn)));
  store.orchestration.delegation.useLiveNativeChildren((conversationId, turnId) => live.get(`${conversationId}:${turnId}`) ?? 0);
  service = new DelegationTaskService({
    store, turns: turns as never, interactions: { approvals, inputs }, pollMs: options.pollMs ?? 5,
    queue: () => ({
      offerDelegated: async (conversationId) => { offers.push(conversationId); },
      sendDelegated: async (conversationId) => { offers.push(`send:${conversationId}`); },
    }),
  });
  const source = store.createConversation(project.id, "Parent chat", { accessMode: "auto-edit" });
  const sourceTurn = turns.begin(source.id, "Coordinate the work").turn;
  turns.active.set(source.id, { turnId: sourceTurn.id, runId: sourceTurn.runId });
  const manager = new AgentThreadManager({
    store,
    providers: { resolveModelRoute: () => ({ providerId: "codex" }) } as never,
    backendProfileController: { validateSelection: (selection: unknown) => selection, readiness: async () => null } as never,
    creation: {
      create: async (payload: Parameters<RuntimeStore["createConversation"]>[2] & { projectId: string; title: string }) =>
        store.createConversation(payload.projectId, payload.title, { ...payload, activate: false }),
    } as never,
    turns: turns as never,
    providerTerminalResumes: { isActive: () => false, acquire: () => true, release: () => undefined },
    contextRequests: new ConversationContextRequestCoordinator({ pendingInputs: inputs, contextPackets: store.contextPackets,
      broadcast: vi.fn(), broadcastConversationShell: vi.fn() }),
    delegation: service,
    providerInfo: () => [{ id: "codex", canRun: true, statusMessage: null }] as never,
    broadcastSnapshot: vi.fn(),
    broadcastConversationShell: vi.fn(),
    broadcast: vi.fn(),
  });
  const call = (tool: string, args: unknown, callOptions: CallOptions = {}): ProviderHostToolCall => ({
    providerThreadId: "provider-thread",
    providerTurnId: "provider-turn",
    toolCallId: callOptions.toolCallId ?? `call-${++callSequence}`,
    tool,
    arguments: args,
    signal: callOptions.signal ?? new AbortController().signal,
    requestApproval: callOptions.approval ?? vi.fn(async () => callOptions.decision ?? "approve"),
  });
  const drain = async () => {
    for (let round = 0; round < 8; round += 1) {
      await Promise.allSettled(pending);
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return {
    store, database, manager, service, source, sourceTurn, approvals, inputs, live, offers, turns,
    starts: turns.starts, active: turns.active,
    call,
    invoke: (tool, args, callOptions) => manager.bridgeFor({ conversation: source, turn: sourceTurn }).invoke(call(tool, args, callOptions)),
    invokeAs: (as, tool, args, callOptions) => manager.bridgeFor(as).invoke(call(tool, args, callOptions)),
    beginTurn: (conversationId, content = "More work") => turns.begin(conversationId, content).turn,
    async settle(turnId, status, text) {
      const turn = store.agentTurn(turnId);
      if (turns.active.get(turn.conversationId)?.turnId === turnId) turns.active.delete(turn.conversationId);
      settleTurnRow(store, database, turnId, status, text);
      await service.onTurnSettled(store.agentTurn(turnId));
      await drain();
      return store.agentTurn(turnId);
    },
    drain,
    async close() {
      await drain();
      store.close();
      await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
    },
  };
}
