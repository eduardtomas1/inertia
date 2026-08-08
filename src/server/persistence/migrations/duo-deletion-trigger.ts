import type Database from "better-sqlite3";

export function rebuildPairedLaunchProjectDeletionTrigger(
  database: Database.Database,
): void {
  database.exec(`
    DROP TRIGGER IF EXISTS paired_launches_project_delete;
    CREATE TRIGGER paired_launches_project_delete
    BEFORE DELETE ON projects
    BEGIN
      SELECT RAISE(
        ABORT,
        'Cancel the active Duo launch before removing this project.'
      )
      WHERE EXISTS (
        SELECT 1
        FROM paired_launches AS launch
        JOIN paired_launch_sides AS project_side
          ON project_side.launch_id = launch.id
        WHERE project_side.project_id = OLD.id
          AND (
            launch.status IN (
              'preparing', 'prepared', 'dispatching', 'recovery-required'
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
                AND unresolved_worktree.project_id = OLD.id
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
          )
      );
      DELETE FROM paired_launches
      WHERE id IN (
        SELECT launch_id FROM paired_launch_sides
        WHERE project_id = OLD.id
      );
    END;
  `);
}

/**
 * Schema-v45 deletion guards. Kept separate from the released project-trigger
 * migration above so older migration definitions remain immutable.
 */
export function protectInterruptedPairedLaunchDeletion(
  database: Database.Database,
): void {
  database.exec(`
    DROP TRIGGER IF EXISTS paired_launches_conversation_delete;
    CREATE TRIGGER paired_launches_conversation_delete
    BEFORE DELETE ON conversations
    BEGIN
      SELECT RAISE(
        ABORT,
        'Cancel the active Duo launch, or acknowledge an interrupted dispatch, before deleting this thread.'
      )
      WHERE EXISTS (
        SELECT 1
        FROM paired_launches AS launch
        JOIN paired_launch_sides AS conversation_side
          ON conversation_side.launch_id = launch.id
        WHERE conversation_side.conversation_id = OLD.id
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
          )
      );
      DELETE FROM paired_launches
      WHERE id IN (
        SELECT launch_id FROM paired_launch_sides
        WHERE conversation_id = OLD.id
      );
    END;

    DROP TRIGGER IF EXISTS paired_launches_project_delete;
    CREATE TRIGGER paired_launches_project_delete
    BEFORE DELETE ON projects
    BEGIN
      SELECT RAISE(
        ABORT,
        'Cancel the active Duo launch, or acknowledge an interrupted dispatch, before removing this project.'
      )
      WHERE EXISTS (
        SELECT 1
        FROM paired_launches AS launch
        JOIN paired_launch_sides AS project_side
          ON project_side.launch_id = launch.id
        WHERE project_side.project_id = OLD.id
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
                AND unresolved_worktree.project_id = OLD.id
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
          )
      );
      DELETE FROM paired_launches
      WHERE id IN (
        SELECT launch_id FROM paired_launch_sides
        WHERE project_id = OLD.id
      );
    END;
  `);
}

/**
 * Appended comparison-lock guards. The pinned source turns and the reserved
 * judge chat remain undeletable until the comparison completes or is
 * explicitly cancelled.
 */
export function protectDuoComparisonDeletion(
  database: Database.Database,
): void {
  database.exec(`
    DROP TRIGGER IF EXISTS paired_launches_conversation_delete;
    CREATE TRIGGER paired_launches_conversation_delete
    BEFORE DELETE ON conversations
    BEGIN
      SELECT RAISE(
        ABORT,
        'Cancel the active Duo launch, acknowledge an interrupted dispatch, or cancel the locked comparison before deleting this thread.'
      )
      WHERE EXISTS (
        SELECT 1
        FROM paired_launches AS launch
        WHERE (
          launch.comparison_conversation_id = OLD.id
          OR EXISTS (
            SELECT 1
            FROM paired_launch_sides AS conversation_side
            WHERE conversation_side.launch_id = launch.id
              AND conversation_side.conversation_id = OLD.id
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
      );
      DELETE FROM paired_launches
      WHERE comparison_conversation_id = OLD.id
        OR id IN (
          SELECT launch_id FROM paired_launch_sides
          WHERE conversation_id = OLD.id
        );
    END;

    DROP TRIGGER IF EXISTS paired_launches_project_delete;
    CREATE TRIGGER paired_launches_project_delete
    BEFORE DELETE ON projects
    BEGIN
      SELECT RAISE(
        ABORT,
        'Cancel the active Duo launch, acknowledge an interrupted dispatch, or cancel the locked comparison before removing this project.'
      )
      WHERE EXISTS (
        SELECT 1
        FROM paired_launches AS launch
        WHERE (
          EXISTS (
            SELECT 1
            FROM paired_launch_sides AS project_side
            WHERE project_side.launch_id = launch.id
              AND project_side.project_id = OLD.id
          )
          OR EXISTS (
            SELECT 1
            FROM conversations AS comparison_conversation
            WHERE comparison_conversation.id = launch.comparison_conversation_id
              AND comparison_conversation.project_id = OLD.id
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
                AND unresolved_worktree.project_id = OLD.id
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
      );
      DELETE FROM paired_launches
      WHERE id IN (
          SELECT launch_id FROM paired_launch_sides
          WHERE project_id = OLD.id
        )
        OR comparison_conversation_id IN (
          SELECT id FROM conversations WHERE project_id = OLD.id
        );
    END;
  `);
}
