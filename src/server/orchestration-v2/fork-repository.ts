import type Database from "better-sqlite3";

import type { AgentTurn, Conversation } from "../../shared/contracts";
import { modelSelectionSchema } from "../../shared/model-routing";
import { forkHistoryPartSchema, forkLineageSchema, type OrchestrationForkEvent } from "../../shared/orchestration-forks";
import { isAgentTurnTerminalStatus } from "../../shared/turn-lifecycle";
import type { NewConversationOptions } from "../persistence/types";
import type { NativeBoundaryRepository } from "./native-boundary-repository";
import type { OrchestrationEventStore } from "./event-store";
import type { HistoryRollbackRepository } from "./history-rollback-repository";
import { captureForkHistory } from "./fork-history";
import { commandFingerprint } from "./json";
import { OrchestrationConflict, type CommandSource } from "./types";

export interface ForkInput {
  projectId: string;
  sourceConversationId: string;
  sourceTurnId: string;
  title?: string;
  activate?: boolean;
}

interface ForkAccess {
  conversation(id: string): Conversation;
  conversationPath(id: string): string;
  agentTurn(id: string): AgentTurn;
  createConversation(projectId: string, title: string, options: NewConversationOptions): Conversation;
}

function targetId(source: CommandSource): string {
  const hash = commandFingerprint({ namespace: "inertia-thread-fork", actorId: source.actorId, commandId: source.commandId });
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Creates only the application fork; native work is resolved lazily on its first send. */
export class ForkRepository {
  constructor(private readonly database: Database.Database, private readonly events: OrchestrationEventStore,
    private readonly boundaries: NativeBoundaryRepository, private readonly rollbacks: HistoryRollbackRepository,
    private readonly access: ForkAccess) {}

  get(threadId: string) {
    const row = this.events.projection("fork", threadId);
    return row ? forkLineageSchema.parse(row.value) : null;
  }

  history(threadId: string, afterRevision = 0, limit = 40) {
    this.access.conversation(threadId);
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Invalid fork history page.");
    }
    const rows = this.database.prepare(`SELECT revision, payload_json FROM orchestration_v2_entities
      WHERE kind = 'fork-history' AND thread_id = ? AND revision > ? ORDER BY revision LIMIT ?`)
      .all(threadId, afterRevision, limit + 1) as { revision: number; payload_json: string }[];
    const page = rows.slice(0, limit);
    return { parts: page.map(({ payload_json }) => forkHistoryPartSchema.parse(JSON.parse(payload_json))),
      next: rows.length > limit ? page.at(-1)!.revision : null };
  }

  create(input: ForkInput, source: CommandSource): Conversation {
    const threadId = targetId(source);
    const identity = { actorId: source.actorId, commandId: source.commandId, projectId: input.projectId, threadId };
    return this.database.transaction(() => {
      const receipt = this.events.receipt(identity, source.command);
      if (receipt) return this.access.conversation(threadId);
      const parent = this.access.conversation(input.sourceConversationId);
      const turn = this.access.agentTurn(input.sourceTurnId);
      if (parent.projectId !== input.projectId || turn.conversationId !== parent.id) {
        throw new OrchestrationConflict("scope-conflict");
      }
      if (!isAgentTurnTerminalStatus(turn.status)) throw new Error("Choose a finished run to fork.");
      if (this.rollbacks.rolledBack(turn.id)) throw new Error("This run was rolled back and cannot be forked.");
      const workspaceKey = this.access.conversationPath(parent.id);
      const title = input.title?.trim() || `${parent.title} fork`.slice(0, 120);
      if (title.length > 120) throw new Error("A fork title must be 120 characters or fewer.");
      const target = this.access.createConversation(parent.projectId, title, {
        id: threadId, providerId: parent.providerId, modelSelection: parent.modelSelection,
        interactionMode: parent.interactionMode, accessMode: parent.accessMode,
        branch: parent.branch, worktreePath: parent.worktreePath, activate: input.activate ?? true,
      });
      if (this.access.conversationPath(target.id) !== workspaceKey) throw new OrchestrationConflict("scope-conflict");
      const parentLineage = this.get(parent.id);
      const nativeBoundary = this.boundaries.forRun(turn.runId);
      const lineage = forkLineageSchema.parse({ threadId, projectId: parent.projectId,
        parentThreadId: parent.id, rootThreadId: parentLineage?.rootThreadId ?? parent.id,
        sourceRunId: turn.runId, sourceTurnId: turn.id, sourceWorkspaceKey: workspaceKey,
        sourceProviderId: turn.providerId, sourceSelection: turn.modelSelection, sourceIdentity: turn.continuationIdentity,
        nativeBoundary: nativeBoundary?.phase === "settled" ? nativeBoundary : null,
        inheritedItems: 0, inheritedParts: 0, transfer: "pending", createdAt: target.createdAt });
      this.events.commit({ actorId: "runtime", commandId: `fork-create:${threadId}`, projectId: parent.projectId,
        threadId, command: { type: "fork-create", threadId }, expectedRevision: 0, events: [
          { type: "thread.registered", payload: { id: target.id, projectId: target.projectId, workspaceKey,
            title: target.title, providerId: target.providerId, selection: modelSelectionSchema.parse(target.modelSelection),
            activeRunId: null, latestRunId: null, createdAt: target.createdAt, updatedAt: target.updatedAt } },
          { type: "thread.forked", payload: lineage },
        ], result: null });
      const totals = captureForkHistory(this.database, target.id, turn,
        (part) => this.commitPart(target, { type: "fork.history-part", payload: part }));
      this.events.commit({ ...identity, command: source.command, expectedRevision: this.events.revision(threadId),
        events: [{ type: "fork.history-sealed", payload: { inheritedItems: totals.items, inheritedParts: totals.parts } }],
        result: { conversationId: target.id, sourceConversationId: parent.id, sourceTurnId: turn.id } });
      return target;
    }).immediate();
  }

  private commitPart(target: Conversation, event: OrchestrationForkEvent): void {
    const revision = this.events.revision(target.id);
    this.events.commit({ actorId: "runtime", commandId: `fork-history:${target.id}:${revision}`,
      projectId: target.projectId, threadId: target.id, command: event,
      expectedRevision: revision, events: [event], result: null });
  }
}
