import type Database from "better-sqlite3";
import type { ProjectPreferences } from "../../shared/project-preferences";
import { parseWorktreeSetup, WORKTREE_SETUP_OUTPUT_LIMIT, type WorktreeSetupSummary } from "../../shared/worktree-setup";

export type WorktreeSetupAction = ProjectPreferences["actions"][number];

/** Keeps commands and output out of lightweight conversation projections. */
export class WorktreeSetupRepository {
  constructor(private readonly database: Database.Database) {}

  initialize(conversationId: string, action: WorktreeSetupAction): void {
    this.database.transaction(() => {
      const inserted = this.database.prepare("INSERT OR IGNORE INTO worktree_setups (conversation_id, action_json) VALUES (?, ?)")
        .run(conversationId, JSON.stringify(action));
      if (!inserted.changes) return;
      this.update(conversationId, { actionName: action.name, status: "pending", attempt: 0,
        detail: "Preparing this new worktree before the first prompt.", startedAt: null, finishedAt: null });
    })();
  }

  read(conversationId: string): { summary: WorktreeSetupSummary; action: WorktreeSetupAction; output: string } | null {
    const row = this.database.prepare(`SELECT c.worktree_setup_json, s.action_json, s.output
      FROM worktree_setups s JOIN conversations c ON c.id=s.conversation_id WHERE c.id=?`)
      .get(conversationId) as { worktree_setup_json: string; action_json: string; output: string } | undefined;
    if (!row) return null;
    const summary = parseWorktreeSetup(row.worktree_setup_json);
    if (!summary) throw new Error("Worktree setup state is unavailable.");
    return { summary, action: JSON.parse(row.action_json) as WorktreeSetupAction, output: row.output };
  }

  forCheckout(conversationId: string): { conversationId: string; summary: WorktreeSetupSummary; action: WorktreeSetupAction; output: string } | null {
    const own = this.read(conversationId);
    if (own) return { conversationId, ...own };
    const row = this.database.prepare(`SELECT s.conversation_id FROM worktree_setups s
      JOIN conversations c ON c.id=s.conversation_id JOIN conversations target ON target.id=?
      WHERE c.project_id=target.project_id AND c.worktree_path=target.worktree_path LIMIT 1`)
      .get(conversationId) as { conversation_id: string } | undefined;
    return row ? { conversationId: row.conversation_id, ...this.read(row.conversation_id)! } : null;
  }

  update(conversationId: string, summary: WorktreeSetupSummary, output?: string): void {
    this.database.transaction(() => {
      this.database.prepare("UPDATE conversations SET worktree_setup_json=?, updated_at=? WHERE id=?")
        .run(JSON.stringify(summary), new Date().toISOString(), conversationId);
      if (output !== undefined) this.database.prepare("UPDATE worktree_setups SET output=? WHERE conversation_id=?")
        .run(output.slice(-WORKTREE_SETUP_OUTPUT_LIMIT), conversationId);
    })();
  }

  assertReady(conversationId: string): void {
    const setup = this.forCheckout(conversationId);
    if (setup && !["succeeded", "skipped"].includes(setup.summary.status)) {
      throw new Error("Finish worktree setup, retry it, or choose Continue without setup before sending a prompt.");
    }
  }

  recoverInterrupted(): void {
    const rows = this.database.prepare("SELECT id, worktree_setup_json FROM conversations WHERE worktree_setup_json IS NOT NULL")
      .all() as Array<{ id: string; worktree_setup_json: string }>;
    for (const row of rows) {
      const summary = parseWorktreeSetup(row.worktree_setup_json);
      if (summary?.status === "pending" || summary?.status === "running") this.update(row.id, {
        ...summary, status: "interrupted", finishedAt: new Date().toISOString(),
        detail: "Setup was interrupted. Inspect the checkout, then retry or continue without setup.",
      });
    }
  }
}
