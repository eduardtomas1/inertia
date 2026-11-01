import type Database from "better-sqlite3";
import {
  validRuntimeGenerationId,
  validSystemBootId,
} from "../../node/runtime-process-protocol";

export interface OwnedProviderRun {
  turnId: string;
  conversationId: string;
  runId: string;
  runtimeGenerationId: string;
  systemBootId: string;
  createdAt: string;
}

interface OwnedProviderRunRow {
  turn_id: string;
  conversation_id: string;
  run_id: string;
  runtime_generation_id: string;
  system_boot_id: string;
  created_at: string;
}

function fromRow(row: OwnedProviderRunRow): OwnedProviderRun {
  return {
    turnId: row.turn_id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    runtimeGenerationId: row.runtime_generation_id,
    systemBootId: row.system_boot_id,
    createdAt: row.created_at,
  };
}

export function releaseProviderRecoveryRecords(
  database: Database.Database,
  records: readonly { turnId: string; runId: string }[],
): void {
  const release = database.prepare(`
    DELETE FROM provider_run_ownership WHERE turn_id = ? AND run_id = ?
  `);
  for (const { turnId, runId } of records) release.run(turnId, runId);
}

export class ProviderRunOwnershipRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly onOwnershipChanged?: (
      identity: { turnId: string; runId: string }, cleanup: "pending" | "confirmed",
    ) => void,
  ) {}

  record(
    turnId: string,
    conversationId: string,
    runId: string,
    runtimeGenerationId: string,
    systemBootId: string,
    createdAt: string,
  ): void {
    this.database.transaction(() => {
      this.recordOwned(turnId, conversationId, runId, runtimeGenerationId, systemBootId, createdAt);
      this.onOwnershipChanged?.({ turnId, runId }, "pending");
    })();
  }

  private recordOwned(
    turnId: string, conversationId: string, runId: string,
    runtimeGenerationId: string, systemBootId: string, createdAt: string,
  ): void {
    if (!validRuntimeGenerationId(runtimeGenerationId)) {
      throw new Error("The provider run ownership generation is invalid.");
    }
    if (!validSystemBootId(systemBootId)) {
      throw new Error("The provider run ownership boot identity is invalid.");
    }
    this.database.prepare(`
      INSERT INTO provider_run_ownership (
        turn_id, conversation_id, run_id, runtime_generation_id,
        system_boot_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(turn_id) DO NOTHING
    `).run(
      turnId,
      conversationId,
      runId,
      runtimeGenerationId,
      systemBootId,
      createdAt,
    );
    const stored = this.forTurn(turnId);
    if (
      !stored
      || stored.conversationId !== conversationId
      || stored.runId !== runId
      || stored.runtimeGenerationId !== runtimeGenerationId
      || stored.systemBootId !== systemBootId
    ) throw new Error("The provider run ownership identity conflicts.");
  }

  clear(turnId: string, runId: string): void {
    this.database.transaction(() => {
      const removed = this.database.prepare(`DELETE FROM provider_run_ownership
        WHERE turn_id = ? AND run_id = ?`).run(turnId, runId);
      if (removed.changes > 0) this.onOwnershipChanged?.({ turnId, runId }, "confirmed");
    })();
  }

  clearRuntimeGeneration(runtimeGenerationId: string): void {
    this.database.transaction(() => {
      const rows = this.database.prepare(`SELECT * FROM provider_run_ownership WHERE runtime_generation_id = ?`)
        .all(runtimeGenerationId) as OwnedProviderRunRow[];
      for (const row of rows) this.clear(row.turn_id, row.run_id);
    })();
  }

  clearPriorBootSessions(systemBootId: string): void {
    if (!validSystemBootId(systemBootId)) {
      throw new Error("The provider run ownership boot identity is invalid.");
    }
    if (systemBootId === "unavailable") return;
    this.database.transaction(() => {
      const rows = this.database.prepare(`SELECT * FROM provider_run_ownership
        WHERE system_boot_id <> ? AND system_boot_id <> 'unavailable'`).all(systemBootId) as OwnedProviderRunRow[];
      for (const row of rows) this.clear(row.turn_id, row.run_id);
    })();
  }

  forTurn(turnId: string): OwnedProviderRun | null {
    const row = this.database.prepare(`
      SELECT * FROM provider_run_ownership WHERE turn_id = ?
    `).get(turnId) as OwnedProviderRunRow | undefined;
    return row ? fromRow(row) : null;
  }

  forConversation(conversationId: string): OwnedProviderRun[] {
    return (this.database.prepare(`
      SELECT * FROM provider_run_ownership
      WHERE conversation_id = ? ORDER BY created_at, turn_id
    `).all(conversationId) as OwnedProviderRunRow[]).map(fromRow);
  }

  all(): OwnedProviderRun[] {
    return (this.database.prepare(`
      SELECT * FROM provider_run_ownership ORDER BY created_at, turn_id
    `).all() as OwnedProviderRunRow[]).map(fromRow);
  }
}
