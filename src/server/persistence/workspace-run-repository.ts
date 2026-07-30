import { randomUUID } from "node:crypto";

import type { WorkspaceRun } from "../../shared/contracts";
import { workspaceRunFromRow } from "./codecs";
import type { PersistenceContext } from "./context";
import { RecordNotFoundError } from "./errors";
import type { WorkspaceRunRow } from "./rows";

type WorkspaceRunPersistenceContext = Pick<
  PersistenceContext,
  "database" | "requireConversation" | "requireProject"
>;

export class WorkspaceRunRepository {
  constructor(private readonly context: WorkspaceRunPersistenceContext) {}

  create(
    input: Omit<WorkspaceRun, "id" | "actionId" | "attentionState" | "canStop" | "startedAt" | "finishedAt"> & {
      id?: string;
      actionId?: string | null;
      attentionState?: WorkspaceRun["attentionState"];
    },
  ): WorkspaceRun {
    this.context.requireProject(input.projectId);
    if (input.conversationId) this.context.requireConversation(input.conversationId);
    const run: WorkspaceRun = {
      ...input,
      id: input.id ?? randomUUID(),
      actionId: input.actionId?.trim().slice(0, 200) || null,
      label: input.label.trim().slice(0, 200),
      detail: input.detail?.slice(0, 1_000) ?? null,
      attentionState: input.attentionState
        ?? (
          input.status === "waiting"
          || input.status === "failed"
          || (input.kind === "agent" && input.status === "succeeded")
            ? "unseen"
            : "acknowledged"
        ),
      canStop: false,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    this.context.database.prepare(`
      INSERT INTO workspace_runs (
        id, kind, project_id, conversation_id, action_id, label, detail,
        status, attention_state, port, started_at, finished_at
      )
      VALUES (
        @id, @kind, @projectId, @conversationId, @actionId, @label, @detail,
        @status, @attentionState, @port, @startedAt, @finishedAt
      )
    `).run(run);
    this.context.database.prepare(`
      DELETE FROM workspace_runs WHERE id IN (
        SELECT id FROM workspace_runs WHERE status NOT IN ('running', 'waiting') ORDER BY started_at DESC LIMIT -1 OFFSET 200
      )
    `).run();
    return run;
  }

  update(
    id: string,
    update: Partial<Pick<WorkspaceRun, "label" | "detail" | "status" | "port" | "finishedAt">>,
  ): WorkspaceRun {
    const row = this.context.database.prepare("SELECT * FROM workspace_runs WHERE id = ?").get(id) as WorkspaceRunRow | undefined;
    if (!row) throw new RecordNotFoundError("Workspace activity not found.");
    const current = workspaceRunFromRow(row);
    const nextStatus = update.status ?? current.status;
    const statusChanged = nextStatus !== current.status;
    const attentionState = !statusChanged
      ? current.attentionState
      : nextStatus === "waiting"
        || nextStatus === "failed"
        || (current.kind === "agent" && nextStatus === "succeeded")
        ? "unseen"
        : nextStatus === "cancelled" || nextStatus === "succeeded"
          ? "acknowledged"
          : current.attentionState;
    const next: WorkspaceRun = {
      ...current,
      ...update,
      attentionState,
      label: update.label === undefined ? current.label : update.label.trim().slice(0, 200),
      detail: update.detail === undefined ? current.detail : update.detail?.slice(0, 1_000) ?? null,
      finishedAt: update.finishedAt !== undefined
        ? update.finishedAt
        : update.status && !["running", "waiting"].includes(update.status)
          ? new Date().toISOString()
          : current.finishedAt,
    };
    this.context.database.prepare(`
      UPDATE workspace_runs
      SET label = ?, detail = ?, status = ?, attention_state = ?, port = ?, finished_at = ?
      WHERE id = ?
    `).run(next.label, next.detail, next.status, next.attentionState, next.port, next.finishedAt, id);
    return next;
  }

  get(id: string): WorkspaceRun {
    const row = this.context.database.prepare("SELECT * FROM workspace_runs WHERE id = ?").get(id) as WorkspaceRunRow | undefined;
    if (!row) throw new RecordNotFoundError("Workspace activity not found.");
    return workspaceRunFromRow(row);
  }

  forConversation(conversationId: string): WorkspaceRun[] {
    this.context.requireConversation(conversationId);
    return (this.context.database.prepare(`
      SELECT * FROM workspace_runs
      WHERE conversation_id = ?
      ORDER BY started_at DESC, id ASC
      LIMIT 200
    `).all(conversationId) as WorkspaceRunRow[]).map(workspaceRunFromRow);
  }

  hasActiveForProject(projectId: string): boolean {
    this.context.requireProject(projectId);
    return Boolean(this.context.database.prepare(`
      SELECT 1
      FROM workspace_runs
      WHERE project_id = ? AND status IN ('running', 'waiting')
      LIMIT 1
    `).get(projectId));
  }

  hasActiveForConversation(conversationId: string): boolean {
    this.context.requireConversation(conversationId);
    return Boolean(this.context.database.prepare(`
      SELECT 1
      FROM workspace_runs
      WHERE conversation_id = ? AND status IN ('running', 'waiting')
      LIMIT 1
    `).get(conversationId));
  }

  markSeen(id: string): WorkspaceRun {
    const run = this.get(id);
    if (run.attentionState !== "unseen") return run;
    this.context.database.prepare("UPDATE workspace_runs SET attention_state = 'seen' WHERE id = ? AND attention_state = 'unseen'")
      .run(id);
    return { ...run, attentionState: "seen" };
  }

  acknowledge(id: string): WorkspaceRun {
    const run = this.get(id);
    if (run.status === "running" || run.status === "waiting") {
      throw new Error("Active or waiting workspace activity cannot be acknowledged.");
    }
    if (run.attentionState === "acknowledged") return run;
    if (run.attentionState === "dismissed") {
      throw new Error("Dismissed workspace activity cannot be acknowledged.");
    }
    this.context.database.prepare("UPDATE workspace_runs SET attention_state = 'acknowledged' WHERE id = ?")
      .run(id);
    return { ...run, attentionState: "acknowledged" };
  }

  dismiss(id: string): void {
    const run = this.get(id);
    if (run.status === "running" || run.status === "waiting") {
      throw new Error("Active workspace activity cannot be dismissed.");
    }
    this.context.database.prepare("UPDATE workspace_runs SET attention_state = 'dismissed' WHERE id = ?")
      .run(id);
  }
}
