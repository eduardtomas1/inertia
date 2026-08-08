import type Database from "better-sqlite3";

import type {
  AgentTurnTerminalStatus,
  DuoComparisonState,
  DuoDispatchState,
  DuoLaunchState,
  DuoLaunchStatus,
} from "../../shared/contracts";
import { RecordNotFoundError } from "./errors";
import type { PairedLaunchRow, PairedLaunchSideRow } from "./rows";
import {
  parseWorktreeFilesystemReceipt,
  serializeWorktreeFilesystemReceipt,
  type WorktreeFilesystemReceipt,
} from "../worktree-filesystem-identity";

export interface PairedLaunchSidePlan {
  ordinal: 0 | 1;
  projectId: string;
  plannedConversationId: string;
  plannedWorktreePath: string | null;
  plannedBranch: string | null;
  ownsWorktree: boolean;
}

export interface StoredPairedLaunchSidePlan extends PairedLaunchSidePlan {
  cleanupWorktreeToken: string | null;
  cleanupWorktreeId: string | null;
  cleanupRepositoryIdentity: string | null;
  cleanupFilesystemReceipt: WorktreeFilesystemReceipt | null;
  cleanupBranchHead: string | null;
  worktreeCreationState: "pending" | "creating" | "created" | "not-created";
  worktreeRemovalStarted: boolean;
  worktreeRemovalConfirmed: boolean;
  worktreeCleanupOutcome: "absent" | "retained" | null;
  worktreeCleanupTopology: "owned" | "conflict" | null;
  cleanupObservedPath: string | null;
  cleanupObservedBranch: string | null;
  cleanupObservedHead: string | null;
  branchCleanupOutcome: "absent" | "retained" | null;
}

export interface StoredPairedLaunch extends DuoLaunchStatus {
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
  comparison?: DuoLaunchStatus["comparison"] & {
    plannedConversationId: string;
  };
  plans: [StoredPairedLaunchSidePlan, StoredPairedLaunchSidePlan];
}

export interface PairedLaunchComparisonPlan {
  plannedConversationId: string;
}

export interface PairedLaunchTurnOwner {
  launchId: string;
  role: "source" | "comparison";
}

export interface PendingPairedLaunchIds {
  launchIds: string[];
  hasMore: boolean;
}

function boundedFailure(message: string | null): string | null {
  return message === null ? null : message.slice(0, 2_000);
}

const INTERRUPTED_ACKNOWLEDGEMENT =
  "Uncertain provider dispatch acknowledged by the user.";

export class PairedLaunchRepository {
  constructor(private readonly database: Database.Database) {}

  create(
    launchId: string,
    sides: [PairedLaunchSidePlan, PairedLaunchSidePlan],
    now: string,
    comparison: PairedLaunchComparisonPlan | null = null,
  ): StoredPairedLaunch {
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO paired_launches (
          id, status, cancel_requested, failure_message,
          comparison_state, comparison_planned_conversation_id,
          comparison_conversation_id, comparison_turn_id,
          comparison_attempt, comparison_failure_message,
          created_at, updated_at
        ) VALUES (?, 'preparing', 0, NULL, ?, ?, NULL, NULL, 0, NULL, ?, ?)
      `).run(
        launchId,
        comparison ? "waiting" : null,
        comparison?.plannedConversationId ?? null,
        now,
        now,
      );
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
      ...(launch.comparison_state && launch.comparison_planned_conversation_id
        ? {
            comparison: {
              state: launch.comparison_state,
              plannedConversationId:
                launch.comparison_planned_conversation_id,
              conversationId: launch.comparison_conversation_id,
              turnId: launch.comparison_turn_id,
              attempt: launch.comparison_attempt,
              error: launch.comparison_failure_message,
            },
          }
        : {}),
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
        worktreeCreationState: side.worktree_creation_state,
        cleanupWorktreeToken: side.cleanup_worktree_token,
        cleanupWorktreeId: side.cleanup_worktree_id,
        cleanupRepositoryIdentity: side.cleanup_repository_identity,
        cleanupFilesystemReceipt: parseWorktreeFilesystemReceipt(
          side.cleanup_filesystem_identity_json,
        ),
        cleanupBranchHead: side.cleanup_branch_head,
        worktreeRemovalStarted: side.worktree_removal_started === 1,
        worktreeRemovalConfirmed: side.worktree_removal_confirmed === 1,
        worktreeCleanupOutcome: side.worktree_cleanup_outcome,
        worktreeCleanupTopology: side.worktree_cleanup_topology,
        cleanupObservedPath: side.cleanup_observed_path,
        cleanupObservedBranch: side.cleanup_observed_branch,
        cleanupObservedHead: side.cleanup_observed_head,
        branchCleanupOutcome: side.branch_cleanup_outcome,
      })) as StoredPairedLaunch["plans"],
    };
  }

  get(launchId: string): StoredPairedLaunch {
    const launch = this.find(launchId);
    if (!launch) throw new RecordNotFoundError("Duo launch not found.");
    return launch;
  }

  pendingLaunchIdsForProjects(
    projectIds: readonly string[],
    limit: number,
  ): PendingPairedLaunchIds {
    const exactProjectIds = [...new Set(projectIds)];
    if (
      exactProjectIds.length < 1
      || exactProjectIds.length > 3
      || !Number.isInteger(limit)
      || limit < 1
      || limit > 32
    ) {
      throw new Error("The pending Duo lookup bounds are invalid.");
    }
    const placeholders = exactProjectIds.map(() => "?").join(", ");
    const rows = this.database.prepare(`
      SELECT launch.id
      FROM paired_launches AS launch
      WHERE (
        launch.status IN (
          'preparing', 'prepared', 'dispatching', 'interrupted',
          'recovery-required'
        )
        OR launch.comparison_state IN (
          'waiting', 'dispatching', 'running', 'failed', 'interrupted'
        )
      )
        AND (
          EXISTS (
          SELECT 1
          FROM paired_launch_sides AS project_side
          WHERE project_side.launch_id = launch.id
            AND project_side.project_id IN (${placeholders})
          )
          OR EXISTS (
            SELECT 1
            FROM conversations AS comparison_conversation
            WHERE comparison_conversation.id = launch.comparison_conversation_id
              AND comparison_conversation.project_id IN (${placeholders})
          )
        )
      ORDER BY launch.created_at DESC, launch.id ASC
      LIMIT ?
    `).all(
      ...exactProjectIds,
      ...exactProjectIds,
      limit + 1,
    ) as Array<{ id: string }>;
    return {
      launchIds: rows.slice(0, limit).map(({ id }) => id),
      hasMore: rows.length > limit,
    };
  }

  assertConversationDeletionAllowed(conversationId: string): void {
    const blocked = this.database.prepare(`
      SELECT 1
      FROM paired_launches AS launch
      WHERE (
        launch.comparison_conversation_id = ?
        OR EXISTS (
          SELECT 1
          FROM paired_launch_sides AS conversation_side
          WHERE conversation_side.launch_id = launch.id
            AND conversation_side.conversation_id = ?
        )
      )
        AND (
          launch.status IN (
            'preparing', 'prepared', 'dispatching', 'interrupted',
            'recovery-required'
          )
          OR EXISTS (
            SELECT 1
            FROM paired_launch_sides AS live_side
            JOIN agent_turns AS live_turn ON live_turn.id = live_side.turn_id
            WHERE live_side.launch_id = launch.id
              AND live_turn.status NOT IN (
                'completed', 'failed', 'cancelled', 'interrupted'
              )
          )
          OR (
            launch.status = 'running'
            AND EXISTS (
              SELECT 1
              FROM paired_launch_sides AS missing_turn
              WHERE missing_turn.launch_id = launch.id
                AND missing_turn.turn_id IS NULL
              )
          )
          OR launch.comparison_state IN (
            'waiting', 'dispatching', 'running', 'failed', 'interrupted'
          )
        )
      LIMIT 1
    `).get(conversationId, conversationId);
    if (blocked) {
      throw new Error(
        "Cancel the active Duo launch, acknowledge an interrupted dispatch, or cancel the locked comparison before deleting this thread.",
      );
    }
  }

  assertProjectDeletionAllowed(projectId: string): void {
    const blocked = this.database.prepare(`
      SELECT 1
      FROM paired_launches AS launch
      WHERE (
        EXISTS (
          SELECT 1
          FROM paired_launch_sides AS project_side
          WHERE project_side.launch_id = launch.id
            AND project_side.project_id = ?
        )
        OR EXISTS (
          SELECT 1
          FROM conversations AS comparison_conversation
          WHERE comparison_conversation.id = launch.comparison_conversation_id
            AND comparison_conversation.project_id = ?
        )
      )
        AND (
          launch.status IN (
            'preparing', 'prepared', 'dispatching', 'interrupted',
            'recovery-required'
          )
          OR EXISTS (
            SELECT 1
            FROM paired_launch_sides AS live_side
            JOIN agent_turns AS live_turn ON live_turn.id = live_side.turn_id
            WHERE live_side.launch_id = launch.id
              AND live_turn.status NOT IN (
                'completed', 'failed', 'cancelled', 'interrupted'
              )
          )
          OR (
            launch.status = 'running'
            AND EXISTS (
              SELECT 1
              FROM paired_launch_sides AS missing_turn
              WHERE missing_turn.launch_id = launch.id
                AND missing_turn.turn_id IS NULL
            )
          )
          OR EXISTS (
            SELECT 1
            FROM paired_launch_sides AS unresolved_worktree
            WHERE unresolved_worktree.launch_id = launch.id
              AND unresolved_worktree.project_id = ?
              AND unresolved_worktree.owns_worktree = 1
              AND unresolved_worktree.conversation_id IS NULL
              AND unresolved_worktree.worktree_creation_state IN (
                'creating', 'created'
              )
              AND (
                unresolved_worktree.worktree_cleanup_outcome IS NULL
                OR unresolved_worktree.worktree_cleanup_outcome <> 'absent'
              )
          )
          OR launch.comparison_state IN (
            'waiting', 'dispatching', 'running', 'failed', 'interrupted'
          )
        )
      LIMIT 1
    `).get(projectId, projectId, projectId);
    if (blocked) {
      throw new Error(
        "Cancel the active Duo launch, acknowledge an interrupted dispatch, or cancel the locked comparison before removing this project.",
      );
    }
  }

  assertComparisonTurnAllowed(
    conversationId: string,
    authorizedLaunchId?: string,
  ): void {
    const blocked = this.database.prepare(`
      SELECT 1
      FROM paired_launches
      WHERE comparison_conversation_id = ?
        AND comparison_state IN (
          'waiting', 'dispatching', 'running', 'failed', 'interrupted'
        )
        AND (? IS NULL OR id <> ? OR comparison_state <> 'dispatching')
      LIMIT 1
    `).get(conversationId, authorizedLaunchId ?? null, authorizedLaunchId ?? null);
    if (blocked) {
      throw new Error(
        "This judge chat is reserved for its locked Duo comparison. Retry or cancel the comparison before sending other work.",
      );
    }
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

  beginWorktreeCreation(
    launchId: string,
    ordinal: 0 | 1,
    worktreePath: string,
    branch: string,
    ownershipToken: string,
  ): void {
    const result = this.database.prepare(`
      UPDATE paired_launch_sides
      SET worktree_creation_state = 'creating', cleanup_worktree_token = ?
      WHERE launch_id = ? AND ordinal = ?
        AND owns_worktree = 1
        AND conversation_id IS NULL
        AND planned_worktree_path = ?
        AND planned_branch = ?
        AND worktree_creation_state = 'pending'
        AND cleanup_branch_head IS NULL
        AND cleanup_worktree_token IS NULL
    `).run(ownershipToken, launchId, ordinal, worktreePath, branch);
    if (result.changes !== 1) {
      throw new Error(
        "The Duo worktree creation attempt did not match its durable plan.",
      );
    }
  }

  rejectWorktreeCreation(
    launchId: string,
    ordinal: 0 | 1,
  ): void {
    const result = this.database.prepare(`
      UPDATE paired_launch_sides
      SET worktree_creation_state = 'not-created', cleanup_worktree_token = NULL
      WHERE launch_id = ? AND ordinal = ?
        AND owns_worktree = 1
        AND conversation_id IS NULL
        AND worktree_creation_state = 'creating'
        AND cleanup_branch_head IS NULL
    `).run(launchId, ordinal);
    if (result.changes !== 1) {
      throw new Error(
        "The rejected Duo worktree creation did not match its durable attempt.",
      );
    }
  }

  recordWorktreeCleanupOwnership(
    launchId: string,
    ordinal: 0 | 1,
    plannedWorktreePath: string,
    createdWorktreePath: string,
    branch: string,
    head: string,
    worktreeId: string,
    repositoryIdentity: string,
    ownershipToken: string,
    filesystemReceipt: WorktreeFilesystemReceipt,
  ): void {
    if (
      !/^[0-9a-f]{40,64}$/u.test(head)
      || !/^[0-9a-f]{64}$/u.test(repositoryIdentity)
      || !/^[0-9a-f-]{36}$/u.test(ownershipToken)
      || !worktreeId
      || worktreeId.length > 255
      || worktreeId.includes("\0")
    ) {
      throw new Error("The Duo worktree cleanup commit identity is invalid.");
    }
    const filesystemIdentity = serializeWorktreeFilesystemReceipt(
      filesystemReceipt,
    );
    const result = this.database.prepare(`
      UPDATE paired_launch_sides
      SET planned_worktree_path = ?, planned_branch = ?,
        worktree_creation_state = 'created', cleanup_branch_head = ?,
        cleanup_worktree_id = ?, cleanup_repository_identity = ?,
        cleanup_filesystem_identity_json = ?
      WHERE launch_id = ? AND ordinal = ?
        AND owns_worktree = 1
        AND conversation_id IS NULL
        AND planned_worktree_path = ?
        AND planned_branch = ?
        AND worktree_creation_state = 'creating'
        AND cleanup_worktree_token = ?
        AND worktree_removal_confirmed = 0
        AND cleanup_branch_head IS NULL
    `).run(
      createdWorktreePath,
      branch,
      head,
      worktreeId,
      repositoryIdentity,
      filesystemIdentity,
      launchId,
      ordinal,
      plannedWorktreePath,
      branch,
      ownershipToken,
    );
    if (result.changes !== 1) {
      throw new Error(
        "The Duo worktree cleanup ownership receipt did not match its durable plan.",
      );
    }
  }

  beginWorktreeRemoval(
    launchId: string,
    ordinal: 0 | 1,
  ): void {
    const result = this.database.prepare(`
      UPDATE paired_launch_sides
      SET worktree_removal_started = 1
      WHERE launch_id = ? AND ordinal = ?
        AND owns_worktree = 1
        AND conversation_id IS NULL
        AND worktree_creation_state = 'created'
        AND cleanup_branch_head IS NOT NULL
        AND worktree_removal_started = 0
        AND worktree_removal_confirmed = 0
    `).run(launchId, ordinal);
    if (result.changes !== 1) {
      throw new Error(
        "The Duo worktree removal attempt did not match its durable ownership proof.",
      );
    }
  }

  confirmWorktreeRemoval(
    launchId: string,
    ordinal: 0 | 1,
  ): void {
    const result = this.database.prepare(`
      UPDATE paired_launch_sides
      SET worktree_removal_confirmed = 1
      WHERE launch_id = ? AND ordinal = ?
        AND owns_worktree = 1
        AND conversation_id IS NULL
        AND worktree_creation_state = 'created'
        AND cleanup_branch_head IS NOT NULL
        AND worktree_removal_started = 1
    `).run(launchId, ordinal);
    if (result.changes !== 1) {
      throw new Error(
        "The Duo worktree removal receipt did not match its durable ownership proof.",
      );
    }
  }

  recordBranchCleanupOutcome(
    launchId: string,
    ordinal: 0 | 1,
    outcome: "absent" | "retained",
  ): void {
    const result = this.database.prepare(`
      UPDATE paired_launch_sides
      SET branch_cleanup_outcome = ?
      WHERE launch_id = ? AND ordinal = ?
        AND owns_worktree = 1
        AND conversation_id IS NULL
        AND worktree_creation_state = 'created'
        AND cleanup_branch_head IS NOT NULL
        AND worktree_cleanup_outcome = 'absent'
        AND (
          branch_cleanup_outcome IS NULL
          OR branch_cleanup_outcome = ?
          OR (
            branch_cleanup_outcome = 'retained'
            AND ? = 'absent'
          )
        )
    `).run(outcome, launchId, ordinal, outcome, outcome);
    if (result.changes !== 1) {
      throw new Error(
        "The Duo branch cleanup outcome did not match its durable ownership proof.",
      );
    }
  }

  recordWorktreeCleanupObservation(
    launchId: string,
    ordinal: 0 | 1,
    outcome: "absent" | "retained",
    observation: {
      topology: "owned" | "conflict" | null;
      path: string | null;
      branch: string | null;
      head: string | null;
    },
  ): void {
    if (
      outcome === "retained"
      && observation.topology === null
    ) {
      throw new Error("A retained Duo worktree needs a topology receipt.");
    }
    if (outcome === "absent" && (
      observation.topology !== null
      || observation.path !== null
      || observation.branch !== null
      || observation.head !== null
    )) {
      throw new Error("An absent Duo worktree cannot retain observed topology.");
    }
    const result = this.database.prepare(`
      UPDATE paired_launch_sides
      SET worktree_cleanup_outcome = ?, worktree_cleanup_topology = ?,
        cleanup_observed_path = ?, cleanup_observed_branch = ?,
        cleanup_observed_head = ?
      WHERE launch_id = ? AND ordinal = ?
        AND owns_worktree = 1
        AND conversation_id IS NULL
        AND worktree_creation_state = 'created'
        AND cleanup_branch_head IS NOT NULL
        AND cleanup_worktree_token IS NOT NULL
        AND cleanup_worktree_id IS NOT NULL
        AND cleanup_repository_identity IS NOT NULL
        AND cleanup_filesystem_identity_json IS NOT NULL
        AND (
          worktree_cleanup_outcome IS NULL
          OR worktree_cleanup_outcome = ?
          OR (
            worktree_cleanup_outcome = 'retained'
            AND ? = 'absent'
          )
        )
    `).run(
      outcome,
      observation.topology,
      observation.path,
      observation.branch,
      observation.head,
      launchId,
      ordinal,
      outcome,
      outcome,
    );
    if (result.changes !== 1) {
      throw new Error(
        "The Duo worktree cleanup outcome did not match its durable ownership proof.",
      );
    }
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

  attachComparisonConversation(
    launchId: string,
    conversationId: string,
    now: string,
  ): void {
    const result = this.database.prepare(`
      UPDATE paired_launches
      SET comparison_conversation_id = ?, updated_at = ?
      WHERE id = ?
        AND comparison_state = 'waiting'
        AND comparison_planned_conversation_id = ?
        AND comparison_conversation_id IS NULL
    `).run(conversationId, now, launchId, conversationId);
    if (result.changes !== 1) {
      throw new Error(
        "The Duo comparison conversation did not match its durable plan.",
      );
    }
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

  launchForTurn(turnId: string): PairedLaunchTurnOwner | null {
    const row = this.database.prepare(`
      SELECT launch.id AS launch_id,
        CASE
          WHEN launch.comparison_turn_id = ? THEN 'comparison'
          ELSE 'source'
        END AS role
      FROM paired_launches AS launch
      WHERE launch.comparison_turn_id = ?
        OR EXISTS (
          SELECT 1
          FROM paired_launch_sides AS source_side
          WHERE source_side.launch_id = launch.id
            AND source_side.turn_id = ?
        )
      ORDER BY CASE WHEN launch.comparison_turn_id = ? THEN 0 ELSE 1 END
      LIMIT 1
    `).get(turnId, turnId, turnId, turnId) as {
      launch_id: string;
      role: PairedLaunchTurnOwner["role"];
    } | undefined;
    return row ? { launchId: row.launch_id, role: row.role } : null;
  }

  comparisonLaunchIds(): string[] {
    return (this.database.prepare(`
      SELECT id
      FROM paired_launches
      WHERE comparison_state IN (
        'waiting', 'dispatching', 'running', 'failed', 'interrupted'
      )
      ORDER BY created_at ASC, id ASC
    `).all() as Array<{ id: string }>).map(({ id }) => id);
  }

  claimComparison(
    launchId: string,
    retry: boolean,
    now: string,
  ): boolean {
    return this.database.transaction(() => {
      const launch = this.get(launchId);
      if (
        !launch.comparison
        || !launch.comparison.conversationId
        || launch.cancelRequested
        || (
          retry
            ? launch.comparison.state !== "failed"
              && launch.comparison.state !== "interrupted"
            : launch.comparison.state !== "waiting"
        )
      ) return false;
      const sourceTurnIds = launch.sides.map(({ turnId }) => turnId);
      if (!sourceTurnIds[0] || !sourceTurnIds[1]) return false;
      const terminalCount = this.database.prepare(`
        SELECT COUNT(*) AS count
        FROM agent_turns
        WHERE id IN (?, ?)
          AND status IN ('completed', 'failed', 'cancelled', 'interrupted')
      `).get(sourceTurnIds[0], sourceTurnIds[1]) as { count: number };
      if (terminalCount.count !== 2) return false;
      const states = retry
        ? ["failed", "interrupted"]
        : ["waiting"];
      const placeholders = states.map(() => "?").join(", ");
      const result = this.database.prepare(`
        UPDATE paired_launches
        SET comparison_state = 'dispatching', comparison_turn_id = NULL,
          comparison_attempt = comparison_attempt + 1,
          comparison_failure_message = NULL, updated_at = ?
        WHERE id = ?
          AND cancel_requested = 0
          AND comparison_conversation_id IS NOT NULL
          AND comparison_state IN (${placeholders})
      `).run(now, launchId, ...states);
      return result.changes === 1;
    })();
  }

  attachComparisonTurn(
    launchId: string,
    turnId: string,
    now: string,
  ): void {
    const result = this.database.prepare(`
      UPDATE paired_launches
      SET comparison_turn_id = ?, updated_at = ?
      WHERE id = ?
        AND comparison_state = 'dispatching'
        AND comparison_turn_id IS NULL
    `).run(turnId, now, launchId);
    if (result.changes !== 1) {
      throw new Error("The Duo comparison turn was already adopted.");
    }
  }

  markComparisonRunning(
    launchId: string,
    turnId: string,
    now: string,
  ): StoredPairedLaunch {
    this.database.prepare(`
      UPDATE paired_launches
      SET comparison_state = 'running', updated_at = ?
      WHERE id = ?
        AND comparison_state = 'dispatching'
        AND comparison_turn_id = ?
    `).run(now, launchId, turnId);
    return this.get(launchId);
  }

  settleComparisonTurn(
    launchId: string,
    turnId: string,
    status: AgentTurnTerminalStatus,
    now: string,
  ): StoredPairedLaunch {
    const state: DuoComparisonState = status === "completed"
      ? "completed"
      : status === "cancelled"
        ? "cancelled"
        : status === "interrupted"
          ? "interrupted"
          : "failed";
    const failure = status === "completed" || status === "cancelled"
      ? null
      : status === "interrupted"
        ? "The judge turn was interrupted. It was not retried automatically."
        : "The judge turn failed. Retry explicitly or cancel the locked comparison.";
    this.database.prepare(`
      UPDATE paired_launches
      SET comparison_state = ?, comparison_failure_message = ?, updated_at = ?
      WHERE id = ?
        AND comparison_turn_id = ?
        AND comparison_state IN ('dispatching', 'running')
    `).run(state, failure, now, launchId, turnId);
    return this.get(launchId);
  }

  failComparison(
    launchId: string,
    state: Extract<DuoComparisonState, "failed" | "interrupted">,
    message: string,
    now: string,
  ): StoredPairedLaunch {
    this.database.prepare(`
      UPDATE paired_launches
      SET comparison_state = ?, comparison_failure_message = ?, updated_at = ?
      WHERE id = ?
        AND comparison_state IN ('waiting', 'dispatching', 'running')
    `).run(state, boundedFailure(message), now, launchId);
    return this.get(launchId);
  }

  cancelComparison(
    launchId: string,
    now: string,
  ): StoredPairedLaunch {
    this.database.prepare(`
      UPDATE paired_launches
      SET comparison_state = 'cancelled',
        comparison_failure_message = NULL, updated_at = ?
      WHERE id = ?
        AND comparison_state IN (
          'waiting', 'dispatching', 'running', 'failed', 'interrupted'
        )
    `).run(now, launchId);
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
      const state: DuoLaunchState = started.every(Boolean)
        ? "running"
        : started.some(Boolean)
          ? "interrupted"
          : "failed";
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
      this.database.prepare(`
        UPDATE paired_launches
        SET comparison_state = 'cancelled', comparison_failure_message = NULL
        WHERE id = ?
          AND comparison_state IN (
            'waiting', 'dispatching', 'running', 'failed', 'interrupted'
          )
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

  acknowledgeInterrupted(launchId: string, now: string): StoredPairedLaunch {
    return this.database.transaction(() => {
      const current = this.get(launchId);
      if (
        current.state === "failed"
        && current.error?.startsWith(INTERRUPTED_ACKNOWLEDGEMENT)
      ) {
        return current;
      }
      if (current.state !== "interrupted") {
        throw new Error("Only an interrupted Duo launch can be acknowledged.");
      }
      this.touch(
        launchId,
        "failed",
        `${INTERRUPTED_ACKNOWLEDGEMENT} ${current.error ?? "Provider acceptance remains unknown."}`,
        now,
      );
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
        if (!uncertain) {
          this.database.prepare(`
            UPDATE paired_launches
            SET comparison_state = 'cancelled', comparison_failure_message = NULL
            WHERE id = ? AND comparison_state = 'waiting'
          `).run(id);
        }
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
