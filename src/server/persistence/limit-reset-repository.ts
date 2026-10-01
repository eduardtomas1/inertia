import type Database from "better-sqlite3";
import type { LimitResetPlan } from "../../shared/limit-reset";

export interface StoredLimitResetPlan extends LimitResetPlan {
  routeIdentity: string; accountIdentity: string; nextAttemptAt: string; attempts: number; turnId: string | null;
}
interface Row {
  id: string; conversation_id: string; failed_turn_id: string; route_identity: string; account_identity: string;
  resets_at: string; next_attempt_at: string; attempts: number; state: LimitResetPlan["state"]; error: string | null; turn_id: string | null;
}
function project(row: Row): StoredLimitResetPlan {
  return { id: row.id, conversationId: row.conversation_id, failedTurnId: row.failed_turn_id,
    routeIdentity: row.route_identity, accountIdentity: row.account_identity, resetsAt: row.resets_at,
    nextAttemptAt: row.next_attempt_at, attempts: row.attempts, state: row.state, error: row.error, turnId: row.turn_id };
}
export function publicLimitResetPlan(plan: StoredLimitResetPlan): LimitResetPlan {
  const { id, conversationId, failedTurnId, resetsAt, state, error } = plan;
  return { id, conversationId, failedTurnId, resetsAt, state, error };
}
export class LimitResetRepository {
  constructor(private readonly database: Database.Database) {}
  get(conversationId: string): StoredLimitResetPlan | null {
    const row = this.database.prepare("SELECT * FROM usage_limit_resume_plans WHERE conversation_id = ?").get(conversationId) as Row | undefined;
    return row ? project(row) : null;
  }
  pending(): StoredLimitResetPlan[] {
    return (this.database.prepare("SELECT * FROM usage_limit_resume_plans WHERE state IN ('waiting','dispatching') ORDER BY next_attempt_at").all() as Row[]).map(project);
  }
  save(plan: StoredLimitResetPlan): void {
    this.database.prepare(`INSERT INTO usage_limit_resume_plans
      (id, conversation_id, failed_turn_id, route_identity, account_identity, resets_at, next_attempt_at, attempts, state, error, turn_id)
      VALUES (@id, @conversationId, @failedTurnId, @routeIdentity, @accountIdentity, @resetsAt, @nextAttemptAt, @attempts, @state, @error, @turnId)
      ON CONFLICT(conversation_id) DO UPDATE SET id=excluded.id, failed_turn_id=excluded.failed_turn_id,
        route_identity=excluded.route_identity, account_identity=excluded.account_identity,
        resets_at=excluded.resets_at, next_attempt_at=excluded.next_attempt_at, attempts=excluded.attempts,
        state=excluded.state, error=excluded.error, turn_id=excluded.turn_id`).run(plan);
  }
  claim(plan: StoredLimitResetPlan): boolean {
    return this.database.prepare("UPDATE usage_limit_resume_plans SET state='dispatching', attempts=attempts+1 WHERE id=? AND conversation_id=? AND state='waiting'")
      .run(plan.id, plan.conversationId).changes === 1;
  }
  settle(plan: StoredLimitResetPlan, state: "blocked" | "cancelled", error: string | null): void {
    this.database.prepare("UPDATE usage_limit_resume_plans SET state=?, error=? WHERE id=? AND conversation_id=? AND state IN ('waiting','dispatching','blocked')")
      .run(state, error?.slice(0, 1000) ?? null, plan.id, plan.conversationId);
  }
  retry(plan: StoredLimitResetPlan, nextAttemptAt: string): void {
    this.database.prepare("UPDATE usage_limit_resume_plans SET state='waiting', next_attempt_at=? WHERE id=? AND conversation_id=? AND state='dispatching'")
      .run(nextAttemptAt, plan.id, plan.conversationId);
  }
  reconcile(): void {
    this.database.prepare("UPDATE usage_limit_resume_plans SET state='waiting' WHERE state='dispatching' AND turn_id IS NULL").run();
  }
}
