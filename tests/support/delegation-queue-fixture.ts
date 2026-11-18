import { createHash, randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import type WebSocket from "ws";

import type {
  AgentApprovalRequest,
  AgentInputRequest,
  AgentTurn,
  ChatAttachment,
  ClientCommand,
  ServerEvent,
} from "../../src/shared/contracts";
import type { DelegatedCompletionWake, DelegatedTask } from "../../src/shared/orchestration-delegation";
import { ConversationAttachmentStore } from "../../src/node/conversation-attachment-store";
import type { TurnInteractionCommandDependencies } from "../../src/server/runtime/commands/turn-interaction-commands";
import { createDelegationRuntime, type DelegationRuntime } from "../../src/server/runtime/delegation/delegation-runtime";
import { createQueuedMessageRuntime } from "../../src/server/runtime/queued-message-runtime";
import { settleTurnRow } from "./delegation-manager-fixture";
import {
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestIdentity,
  turnControllerTestProviderInfo,
  type TurnControllerTestRuntime,
} from "./turn-controller-runtime";

let sequence = 0;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export interface DelegationQueueFixture extends TurnControllerTestRuntime {
  database: Database.Database;
  parentId: string;
  queue: ReturnType<typeof createQueuedMessageRuntime>;
  delegation: DelegationRuntime;
  approvals: Map<string, AgentApprovalRequest>;
  inputs: Map<string, AgentInputRequest>;
  sent: ServerEvent[];
  automatic: { enabled: boolean };
  startParent(content?: string): AgentTurn;
  finishActive(status?: "completed" | "failed", text?: string): Promise<void>;
  delegate(sourceTurn: AgentTurn, options?: { wake?: DelegatedCompletionWake; title?: string }):
    Promise<{ task: DelegatedTask; childId: string; childTurn: AgentTurn }>;
  completeChild(childTurn: AgentTurn, text?: string, status?: "completed" | "failed"): Promise<void>;
  command(command: { type: ClientCommand["type"]; payload?: unknown }): Promise<string>;
  parentTurns(): AgentTurn[];
  drain(): Promise<void>;
  close(): Promise<void>;
}

export async function createDelegationQueueFixture(): Promise<DelegationQueueFixture> {
  let queue: ReturnType<typeof createQueuedMessageRuntime> | undefined;
  let delegation: DelegationRuntime | undefined;
  const tasks = new Set<Promise<unknown>>();
  const track = <T>(operation: Promise<T>): Promise<T> => {
    const tracked = operation.finally(() => tasks.delete(tracked));
    tasks.add(tracked);
    return tracked;
  };
  const runtime = await createTurnControllerTestRuntime({
    onTurnSettled: (turn) => {
      queue?.onTurnSettled(turn);
      if (delegation) void track(delegation.onTurnSettled(turn)).catch(() => undefined);
    },
  }, { id: randomUUID });
  const database = (runtime.store as unknown as { database: Database.Database }).database;
  const attachments = await ConversationAttachmentStore.open(runtime.directory);
  const abort = new AbortController();
  const approvals = new Map<string, AgentApprovalRequest>();
  const inputs = new Map<string, AgentInputRequest>();
  const sent: ServerEvent[] = [];
  const automatic = {
    get enabled(): boolean { return runtime.store.appSettings().delegationAutomaticWakes; },
    set enabled(value: boolean) { runtime.store.updateSettings({ delegationAutomaticWakes: value }); },
  };
  const dependencies: TurnInteractionCommandDependencies = {
    store: runtime.store, turns: runtime.controller, conversationAttachments: attachments,
    backendProfileController: {
      validateSelection: (selection: unknown) => selection, isExternalSelection: () => false, readiness: async () => null,
    } as unknown as TurnInteractionCommandDependencies["backendProfileController"],
    isolatedRuns: { has: () => false } as unknown as TurnInteractionCommandDependencies["isolatedRuns"],
    workspaceRuns: {} as TurnInteractionCommandDependencies["workspaceRuns"],
    pendingApprovals: approvals, pendingInputs: inputs, dataDirectory: runtime.directory, enableProviders: true,
    attachmentResolver: {
      resolvePayloads: async (requested: ChatAttachment[]) => requested.map((attachment) => ({ attachment, bytes: Buffer.alloc(8) })),
      releaseAll: async () => undefined, relinquishAll: async () => undefined,
    } as unknown as TurnInteractionCommandDependencies["attachmentResolver"],
    generatedAttachments: { release: async () => undefined } as unknown as TurnInteractionCommandDependencies["generatedAttachments"],
    workflows: { resolveTurnSkills: async () => ({ inputs: [], routeKey: null }), assertTurnSkillsCurrent: () => undefined } as unknown as TurnInteractionCommandDependencies["workflows"],
    providerTerminalResumes: { isActive: () => false, acquireWhenAvailable: async () => true, release: () => undefined } as unknown as TurnInteractionCommandDependencies["providerTerminalResumes"],
    providerInfo: () => [turnControllerTestProviderInfo()], broadcast: () => undefined,
    broadcastSnapshot: () => undefined, send: (_socket, event) => { sent.push(event); },
  };
  delegation = createDelegationRuntime({ store: runtime.store, turns: runtime.controller, pendingApprovals: approvals,
    pendingInputs: inputs, broadcast: () => undefined, queue: () => queue, pollMs: 5 });
  queue = createQueuedMessageRuntime(dependencies, { signal: abort.signal, track: (operation) => track(operation()),
    delegated: () => delegation?.queueHooks });
  const drain = async () => {
    for (let round = 0; round < 6; round += 1) {
      await flushTurnControllerTestPromises();
      while (tasks.size) await Promise.allSettled(tasks);
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const parentId = runtime.conversationId;
  const parent = runtime.store.conversation(parentId);
  return {
    ...runtime, database, parentId, queue, delegation, approvals, inputs, sent, automatic, drain,
    startParent(content = "Coordinate the work") {
      const queued = runtime.controller.queue({ conversationId: parentId, content });
      runtime.controller.start(queued.turn.id);
      runtime.provider.emit({ ...turnControllerTestIdentity(runtime), type: "status", status: "running" });
      return runtime.store.agentTurn(queued.turn.id);
    },
    async finishActive(status = "completed", text = "Parent answer") {
      runtime.provider.resolve(status === "failed" ? { status: "failed" } : { text });
      await drain();
    },
    async delegate(sourceTurn, options = {}) {
      const childId = runtime.store.createConversation(parent.projectId, options.title ?? `Child ${++sequence}`, {
        providerId: "codex", model: "gpt-test", reasoningEffort: "high", interactionMode: "build", accessMode: "supervised",
      }).id;
      database.prepare(`INSERT INTO agent_managed_conversations (child_conversation_id, source_conversation_id, source_turn_id,
        source_run_id, root_conversation_id, source_harness_id, depth, created_at) VALUES (?, ?, ?, ?, ?, 'codex-app-server', 1, ?)`)
        .run(childId, parentId, sourceTurn.id, sourceTurn.runId, parentId, new Date().toISOString());
      const childTurn = runtime.controller.queue({ conversationId: childId, content: "Delegated work" }).turn;
      const operationId = digest(`operation-${randomUUID()}`);
      const now = new Date().toISOString();
      database.prepare(`INSERT INTO agent_thread_operations (id, source_conversation_id, source_turn_id, source_run_id,
        tool_call_id_hash, tool_name, request_fingerprint, status, child_conversation_id, input_chars, created_at, updated_at,
        target_turn_id, target_run_id) VALUES (?, ?, ?, ?, ?, 'inertia_delegate_task', ?, 'dispatching', ?, 0, ?, ?, ?, ?)`)
        .run(operationId, parentId, sourceTurn.id, sourceTurn.runId, digest(operationId), digest("request"), childId, now, now,
          childTurn.id, childTurn.runId);
      const task = await delegation!.service.create({ operationId, kind: "original", originalTaskId: null,
        parentConversationId: parentId, sourceTurnId: sourceTurn.id, sourceRunId: sourceTurn.runId, childConversationId: childId,
        firstChildTurnId: childTurn.id, firstChildRunId: childTurn.runId, title: options.title ?? "Investigate the cache",
        role: null, route: { providerId: "codex", harnessId: "codex-app-server", modelId: "gpt-test", reasoningEffort: "high" },
        accessMode: "supervised", interactionMode: "build", workspace: "project", completionWake: options.wake ?? "always" });
      return { task, childId, childTurn };
    },
    async completeChild(childTurn, text = "Child result", status = "completed") {
      settleTurnRow(runtime.store, database, childTurn.id, status, status === "completed" ? text : undefined);
      await delegation!.onTurnSettled(runtime.store.agentTurn(childTurn.id));
      await drain();
    },
    async command(command) {
      const requestId = randomUUID();
      const full = { ...command, requestId } as ClientCommand;
      await queue!.handler(null as unknown as WebSocket, full);
      await drain();
      return requestId;
    },
    parentTurns() {
      return (database.prepare("SELECT id FROM agent_turns WHERE conversation_id = ? ORDER BY requested_at, id")
        .all(parentId) as { id: string }[]).map(({ id }) => runtime.store.agentTurn(id));
    },
    async close() {
      abort.abort();
      await drain();
      await runtime.controller.dispose();
      await attachments.close();
      runtime.store.close();
    },
  };
}
