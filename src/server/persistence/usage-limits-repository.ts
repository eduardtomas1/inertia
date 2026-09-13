import type Database from "better-sqlite3";
import { usageSourceSchema, usageResetConfirmationSchema, type UsageSource, type UsageResetConfirmation, type UsageResetOutcome } from "../../shared/provider-usage-limits";

export interface StoredResetAttempt {
  confirmation: UsageResetConfirmation;
  outcome: UsageResetOutcome | null;
  attempted: boolean;
}
export class UsageLimitsRepository {
  constructor(private readonly database: Database.Database) {}
  sources(): UsageSource[] {
    return this.database.prepare("SELECT * FROM usage_limit_sources ORDER BY rowid").all()
      .map((raw) => { const row = raw as UsageSource; return usageSourceSchema.parse({ ...row, enabled: Boolean(row.enabled) }); });
  }
  saveSource(source: UsageSource): void {
    if (!this.sources().some(({ id }) => id === source.id) && this.sources().length >= 4) throw new Error("Up to four usage hubs can be connected.");
    this.database.prepare("INSERT INTO usage_limit_sources VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET label=excluded.label, url=excluded.url, enabled=excluded.enabled")
      .run(source.id, source.label, source.url, Number(source.enabled));
  }
  removeSource(id: string): void { this.database.prepare("DELETE FROM usage_limit_sources WHERE id=?").run(id); }
  attempt(id: string): StoredResetAttempt | null {
    const row = this.database.prepare("SELECT * FROM usage_reset_attempts WHERE id=?").get(id) as { confirmation_json: string; outcome: UsageResetOutcome | null; attempted: number } | undefined;
    return row ? { confirmation: usageResetConfirmationSchema.parse(JSON.parse(row.confirmation_json)), outcome: row.outcome, attempted: Boolean(row.attempted) } : null;
  }
  pending(accountKey: string): StoredResetAttempt | null {
    const row = this.database.prepare("SELECT id FROM usage_reset_attempts WHERE account_key=? AND attempted=1 AND outcome IS NULL LIMIT 1").get(accountKey) as { id: string } | undefined;
    return row ? this.attempt(row.id) : null;
  }
  prepare(creditKey: string, confirmation: UsageResetConfirmation): UsageResetConfirmation {
    const open = this.database.prepare("SELECT id FROM usage_reset_attempts WHERE account_key=? AND outcome IS NULL AND (attempted=1 OR json_extract(confirmation_json, '$.expiresAt')>?) ORDER BY attempted DESC LIMIT 1").get(confirmation.accountKey, new Date().toISOString()) as { id: string } | undefined;
    const pending = open ? this.attempt(open.id) : null;
    const prior = pending ? { id: pending.confirmation.id } : this.database.prepare("SELECT id FROM usage_reset_attempts WHERE credit_key=?").get(creditKey) as { id: string } | undefined;
    if (prior) {
      const existing = this.attempt(prior.id)!;
      if (existing.confirmation.accountKey !== confirmation.accountKey) throw new Error("The reset account changed.");
      // Rebind a freshly verified route while retaining the exact provider account,
      // original credit (including server selection) and provider idempotency key.
      const renewed = { ...confirmation, id: existing.confirmation.id, creditId: existing.confirmation.creditId };
      this.database.prepare("UPDATE usage_reset_attempts SET account_id=?,confirmation_json=? WHERE id=?").run(renewed.accountId, JSON.stringify(renewed), prior.id);
      return renewed;
    }
    this.database.prepare("INSERT INTO usage_reset_attempts(id,credit_key,account_id,account_key,credit_id,confirmation_json) VALUES (?,?,?,?,?,?)")
      .run(confirmation.id, creditKey, confirmation.accountId, confirmation.accountKey, confirmation.creditId, JSON.stringify(confirmation));
    return confirmation;
  }
  markAttempted(id: string): void { this.database.prepare("UPDATE usage_reset_attempts SET attempted=1 WHERE id=?").run(id); }
  settle(id: string, outcome: UsageResetOutcome): void { this.database.prepare("UPDATE usage_reset_attempts SET outcome=? WHERE id=?").run(outcome, id); }
}
