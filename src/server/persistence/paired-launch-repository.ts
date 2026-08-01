import type Database from "better-sqlite3";

import type {
  DuoDispatchState,
  DuoLaunchState,
  DuoLaunchStatus,
} from "../../shared/contracts";
import { RecordNotFoundError } from "./errors";
import type { PairedLaunchRow, PairedLaunchSideRow } from "./rows";

export interface PairedLaunchSidePlan {
  ordinal: 0 | 1;
  projectId: string;
  plannedConversationId: string;
  plannedWorktreePath: string | null;
  plannedBranch: string | null;
  ownsWorktree: boolean;
}

export interface StoredPairedLaunch extends DuoLaunchStatus {
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
  plans: [PairedLaunchSidePlan, PairedLaunchSidePlan];
}

function boundedFailure(message: string | null): string | null {
  return message === null ? null : message.slice(0, 2_000);
}

export class PairedLaunchRepository {
  constructor(private readonly database: Database.Database) {}

  create(
    launchId: string,
    sides: [PairedLaunchSidePlan, PairedLaunchSidePlan],
    now: string,
  ): StoredPairedLaunch {
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO paired_launches (
          id, status, cancel_requested, failure_message, created_at, updated_at
        ) VALUES (?, 'preparing', 0, NULL, ?, ?)
      `).run(launchId, now, now);
      const insertSide = this.database.prepare(`
        INSERT INTO paired_launch_sides (
          launch_id, ordinal, project_id, planned_conversation_id,
          conversation_id, turn_id, planned_worktree_path, planned_branch,
          owns_worktree, dispatch_state
        ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, 'pending')
      `);
      for (const side of sides) {
        insertSide.run(
          launchId,
          side.ordinal,
          side.projectId,
          side.plannedConversationId,
          side.plannedWorktreePath,
          side.plannedBranch,
          Number(side.ownsWorktree),
        );
      }
    })();
    return this.get(launchId);
  }

  find(launchId: string): StoredPairedLaunch | null {
    const launch = this.database.prepare(
      "SELECT * FROM paired_launches WHERE id = ?",
    ).get(launchId) as PairedLaunchRow | undefined;
    if (!launch) return null;
    const sides = this.database.prepare(`
      SELECT * FROM paired_launch_sides
      WHERE launch_id = ? ORDER BY ordinal ASC
    `).all(launchId) as PairedLaunchSideRow[];
    if (sides.length !== 2 || sides[0]?.ordinal !== 0 || sides[1]?.ordinal !== 1) {
      throw new Error("The durable Duo launch has an invalid side layout.");
    }
    return {
      launchId: launch.id,
      state: launch.status,
      error: launch.failure_message,
      cancelRequested: launch.cancel_requested === 1,
      createdAt: launch.created_at,
      updatedAt: launch.updated_at,
      sides: sides.map((side) => ({
        ordinal: side.ordinal,
        conversationId: side.conversation_id,
        turnId: side.turn_id,
        dispatchState: side.dispatch_state,
      })) as StoredPairedLaunch["sides"],
      plans: sides.map((side) => ({
        ordinal: side.ordinal,
        projectId: side.project_id,
        plannedConversationId: side.planned_conversation_id,
        plannedWorktreePath: side.planned_worktree_path,
        plannedBranch: side.planned_branch,
        ownsWorktree: side.owns_worktree === 1,
      })) as StoredPairedLaunch["plans"],
    };
  }

  get(launchId: string): StoredPairedLaunch {
    const launch = this.find(launchId);
    if (!launch) throw new RecordNotFoundError("Duo launch not found.");
    return launch;
  }

  updateWorktree(
    launchId: string,
    ordinal: 0 | 1,
    worktreePath: string | null,
    branch: string | null,
  ): void {
    const result = this.database.prepare(`
      UPDATE paired_launch_sides
      SET planned_worktree_path = ?, planned_branch = ?
      WHERE launch_id = ? AND ordinal = ?
    `).run(worktreePath, branch, launchId, ordinal);
    if (result.changes !== 1) throw new RecordNotFoundError("Duo launch side not found.");
  }

  attachConversations(
    launchId: string,
    conversationIds: [string, string],
    now: string,
  ): void {
    const update = this.database.prepare(`
      UPDATE paired_launch_sides SET conversation_id = ?
      WHERE launch_id = ? AND ordinal = ? AND conversation_id IS NULL
    `);
    conversationIds.forEach((conversationId, ordinal) => {
      if (update.run(conversationId, launchId, ordinal).changes !== 1) {
        throw new Error("The Duo conversation identity was already adopted.");
      }
    });
    this.touch(launchId, "preparing", null, now);
  }

  attachTurns(
    launchId: string,
    turnIds: [string, string],
    now: string,
  ): void {
    const update = this.database.prepare(`
      UPDATE paired_launch_sides SET turn_id = ?
      WHERE launch_id = ? AND ordinal = ?
        AND conversation_id IS NOT NULL AND turn_id IS NULL
    `);
    turnIds.forEach((turnId, ordinal) => {
      if (update.run(turnId, launchId, ordinal).changes !== 1) {
        throw new Error("The Duo turn identity was already adopted.");
      }
    });
    this.touch(launchId, "prepared", null, now);
  }

  requestCancel(launchId: string, now: string): StoredPairedLaunch {
    const result = this.database.prepare(`
      UPDATE paired_launches SET cancel_requested = 1, updated_at = ?
      WHERE id = ? AND status NOT IN ('cancelled', 'failed', 'interrupted')
    `).run(now, launchId);
    if (result.changes === 0) this.get(launchId);
    return this.get(launchId);
  }

  claimDispatch(launchId: string, now: string): boolean {
    return this.database.transaction(() => {
      const launch = this.get(launchId);
      if (launch.state !== "prepared" || launch.cancelRequested) return false;
      const launchUpdate = this.database.prepare(`
        UPDATE paired_launches SET status = 'dispatching', updated_at = ?
        WHERE id = ? AND status = 'prepared' AND cancel_requested = 0
      `).run(now, launchId);
      if (launchUpdate.changes !== 1) return false;
      const sides = this.database.prepare(`
        UPDATE paired_launch_sides SET dispatch_state = 'claimed'
        WHERE launch_id = ? AND dispatch_state = 'pending'
      `).run(launchId);
      if (sides.changes !== 2) {
        throw new Error("The Duo dispatch claim was not atomic.");
      }
      return true;
    })();
  }

  finishDispatch(
    launchId: string,
    started: readonly [boolean, boolean],
    now: string,
    failure: string | null = null,
  ): StoredPairedLaunch {
    return this.database.transaction(() => {
      const updateSide = this.database.prepare(`
        UPDATE paired_launch_sides SET dispatch_state = ?
        WHERE launch_id = ? AND ordinal = ? AND dispatch_state = 'claimed'
      `);
      started.forEach((value, ordinal) => {
        const state: DuoDispatchState = value ? "started" : "failed";
        if (updateSide.run(state, launchId, ordinal).changes !== 1) {
          throw new Error("The Duo dispatch result was already recorded.");
        }
      });
      const state: DuoLaunchState = started.every(Boolean) ? "running" : "failed";
      this.touch(launchId, state, failure, now);
      return this.get(launchId);
    })();
  }

  finishCancellation(
    launchId: string,
    now: string,
    failure: string | null = null,
  ): StoredPairedLaunch {
    return this.database.transaction(() => {
      this.database.prepare(`
        UPDATE paired_launch_sides SET dispatch_state = 'cancelled'
        WHERE launch_id = ? AND dispatch_state IN ('pending', 'claimed')
      `).run(launchId);
      this.touch(
        launchId,
        failure ? "recovery-required" : "cancelled",
        failure,
        now,
      );
      return this.get(launchId);
    })();
  }

  fail(
    launchId: string,
    state: Extract<DuoLaunchState, "failed" | "interrupted" | "recovery-required">,
    message: string,
    now: string,
  ): StoredPairedLaunch {
    return this.database.transaction(() => {
      if (state === "interrupted") {
        this.database.prepare(`
          UPDATE paired_launch_sides SET dispatch_state = 'uncertain'
          WHERE launch_id = ? AND dispatch_state = 'claimed'
        `).run(launchId);
      }
      this.touch(launchId, state, message, now);
      return this.get(launchId);
    })();
  }

  recoverInterrupted(now: string): StoredPairedLaunch[] {
    const ids = this.database.prepare(`
      SELECT id FROM paired_launches
      WHERE status IN ('preparing', 'prepared', 'dispatching')
      ORDER BY created_at ASC, id ASC
    `).all() as Array<{ id: string }>;
    this.database.transaction(() => {
      for (const { id } of ids) {
        const current = this.get(id);
        const uncertain = current.state === "dispatching";
        this.database.prepare(`
          UPDATE paired_launch_sides
          SET dispatch_state = CASE
            WHEN dispatch_state = 'claimed' THEN 'uncertain'
            WHEN dispatch_state = 'pending' THEN 'cancelled'
            ELSE dispatch_state
          END
          WHERE launch_id = ?
        `).run(id);
        this.touch(
          id,
          uncertain ? "interrupted" : "recovery-required",
          uncertain
            ? "Dispatch was interrupted after its durable claim. It was not retried."
            : "Duo preparation was interrupted. Review the idle chats before starting new work.",
          now,
        );
      }
    })();
    return ids.map(({ id }) => this.get(id));
  }

  private touch(
    launchId: string,
    status: DuoLaunchState,
    failure: string | null,
    now: string,
  ): void {
    const result = this.database.prepare(`
      UPDATE paired_launches
      SET status = ?, failure_message = ?, updated_at = ?
      WHERE id = ?
    `).run(status, boundedFailure(failure), now, launchId);
    if (result.changes !== 1) throw new RecordNotFoundError("Duo launch not found.");
  }
}
