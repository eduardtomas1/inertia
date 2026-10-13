import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type RestartContinuationState = "waiting" | "dispatching" | "blocked" | "completed" | "cancelled";

export interface RestartContinuationPlan {
  id: string;
  conversationId: string;
  interruptedTurnId: string;
  routeIdentity: string;
  state: RestartContinuationState;
  attempts: number;
  turnId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RestartContinuationPlanInput {
  conversationId: string;
  interruptedTurnId: string;
  routeIdentity: string;
}

type PlanIdentity = Pick<RestartContinuationPlan, "id" | "conversationId">;

interface Row {
  id: string; conversation_id: string; interrupted_turn_id: string; route_identity: string;
  state: RestartContinuationState; attempts: number; turn_id: string | null; error: string | null;
  created_at: string; updated_at: string;
}

const MAX_ERROR_CHARACTERS = 1_000;

function project(row: Row): RestartContinuationPlan {
  return { id: row.id, conversationId: row.conversation_id, interruptedTurnId: row.interrupted_turn_id,
    routeIdentity: row.route_identity, state: row.state, attempts: row.attempts, turnId: row.turn_id,
    error: row.error, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function completeRestartContinuationPlan(database: Database.Database, planId: string, conversationId: string, turnId: string): void {
  const accepted = database.prepare(`UPDATE restart_continuation_plans SET state='completed', turn_id=?, error=NULL, updated_at=?
    WHERE id=? AND conversation_id=? AND state='dispatching'`).run(turnId, new Date().toISOString(), planId, conversationId);
  if (accepted.changes !== 1) throw new Error("The continuation plan no longer owns this dispatch.");
}

export class RestartContinuationRepository {
  constructor(private readonly database: Database.Database) {}

  createForConversations(inputs: readonly RestartContinuationPlanInput[]): RestartContinuationPlan[] {
    return this.database.transaction(() => inputs.map((input) => {
      const now = new Date().toISOString();
      this.database.prepare(`INSERT INTO restart_continuation_plans
        (id, conversation_id, interrupted_turn_id, route_identity, state, attempts, turn_id, error, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'waiting', 0, NULL, NULL, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET id=excluded.id, interrupted_turn_id=excluded.interrupted_turn_id,
          route_identity=excluded.route_identity, state='waiting', attempts=0, turn_id=NULL, error=NULL,
          created_at=excluded.created_at, updated_at=excluded.updated_at`)
        .run(randomUUID(), input.conversationId, input.interruptedTurnId, input.routeIdentity, now, now);
      return this.forConversation(input.conversationId)!;
    }))();
  }

  forConversation(conversationId: string): RestartContinuationPlan | null {
    const row = this.database.prepare("SELECT * FROM restart_continuation_plans WHERE conversation_id = ?").get(conversationId) as Row | undefined;
    return row ? project(row) : null;
  }

  listWaiting(): RestartContinuationPlan[] {
    return (this.database.prepare("SELECT * FROM restart_continuation_plans WHERE state = 'waiting' ORDER BY created_at, id").all() as Row[]).map(project);
  }

  claim(plan: PlanIdentity): boolean {
    return this.database.prepare(`UPDATE restart_continuation_plans SET state='dispatching', attempts=attempts+1, updated_at=?
      WHERE id=? AND conversation_id=? AND state='waiting'`).run(new Date().toISOString(), plan.id, plan.conversationId).changes === 1;
  }

  complete(plan: PlanIdentity, turnId: string): void {
    completeRestartContinuationPlan(this.database, plan.id, plan.conversationId, turnId);
  }

  release(plan: PlanIdentity, error: string | null): boolean {
    return this.move(plan, "waiting", ["dispatching"], error);
  }

  block(plan: PlanIdentity, error: string): boolean {
    return this.move(plan, "blocked", ["waiting", "dispatching"], error);
  }

  cancel(plan: PlanIdentity, reason: string): boolean {
    return this.move(plan, "cancelled", ["waiting", "dispatching", "blocked"], reason);
  }

  reconcile(): void {
    this.database.prepare("UPDATE restart_continuation_plans SET state='waiting', updated_at=? WHERE state='dispatching' AND turn_id IS NULL")
      .run(new Date().toISOString());
  }

  private move(plan: PlanIdentity, state: RestartContinuationState, from: readonly RestartContinuationState[], error: string | null): boolean {
    return this.database.prepare(`UPDATE restart_continuation_plans SET state=?, error=?, updated_at=?
      WHERE id=? AND conversation_id=? AND state IN (${from.map(() => "?").join(",")})`)
      .run(state, error?.slice(0, MAX_ERROR_CHARACTERS) ?? null, new Date().toISOString(), plan.id, plan.conversationId, ...from).changes === 1;
  }
}
