import type Database from "better-sqlite3";

import {
  MAX_SCHEDULED_TASKS_PER_PROJECT,
  MAX_SCHEDULED_TASKS_TOTAL,
  MAX_SCHEDULED_TASK_RUN_HISTORY,
  normalizeScheduledTaskError,
  scheduledTaskCreateInputSchema,
  scheduledTaskPatchSchema,
  scheduledTaskRunSchema,
  scheduledTaskSchema,
  type ScheduledTask,
  type ScheduledTaskCreateInput,
  type ScheduledTaskPatch,
  type ScheduledTaskRun,
  type ScheduledTaskRunStatus,
  type ScheduledTaskRunTrigger,
} from "../../shared/scheduled-tasks";

interface ScheduledTaskRow {
  id: string;
  project_id: string;
  title: string;
  prompt: string;
  schedule_json: string;
  bound_conversation_id: string | null;
  fresh_session: number;
  model_selection_json: string | null;
  interaction_mode: string;
  access_mode: string;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_status: string | null;
  last_conversation_id: string | null;
  last_turn_id: string | null;
  last_error: string | null;
  consecutive_failures: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface ScheduledTaskRunRow {
  id: string;
  task_id: string;
  claim_key: string;
  trigger: string;
  scheduled_for: string | null;
  state: string;
  conversation_id: string | null;
  turn_id: string | null;
  queue_item_id: string | null;
  error: string | null;
  claimed_at: string;
  finished_at: string | null;
}

export type ScheduledTaskRepositoryErrorCode =
  | "invalid"
  | "missing"
  | "limit"
  | "conflict";

export class ScheduledTaskRepositoryError extends Error {
  constructor(
    readonly code: ScheduledTaskRepositoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ScheduledTaskRepositoryError";
  }
}

const TASK_COLUMNS = `
  id, project_id, title, prompt, schedule_json, bound_conversation_id,
  fresh_session, model_selection_json, interaction_mode, access_mode,
  enabled, next_run_at, last_run_at, last_run_status, last_conversation_id,
  last_turn_id, last_error, consecutive_failures, created_by, created_at,
  updated_at
`;

const RUN_COLUMNS = `
  id, task_id, claim_key, trigger, scheduled_for, state, conversation_id,
  turn_id, queue_item_id, error, claimed_at, finished_at
`;

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function sqliteErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function taskFromRow(row: ScheduledTaskRow): ScheduledTask | null {
  const parsed = scheduledTaskSchema.safeParse({
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    prompt: row.prompt,
    schedule: parseJson(row.schedule_json),
    boundConversationId: row.bound_conversation_id,
    freshSession: row.fresh_session === 1,
    modelSelection: row.model_selection_json === null ? null : parseJson(row.model_selection_json),
    interactionMode: row.interaction_mode,
    accessMode: row.access_mode,
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastRunStatus: row.last_run_status,
    lastConversationId: row.last_conversation_id,
    lastTurnId: row.last_turn_id,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  return parsed.success ? parsed.data : null;
}

function runFromRow(row: ScheduledTaskRunRow): ScheduledTaskRun | null {
  const parsed = scheduledTaskRunSchema.safeParse({
    id: row.id,
    taskId: row.task_id,
    claimKey: row.claim_key,
    trigger: row.trigger,
    scheduledFor: row.scheduled_for,
    state: row.state,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    queueItemId: row.queue_item_id,
    error: row.error,
    claimedAt: row.claimed_at,
    finishedAt: row.finished_at,
  });
  return parsed.success ? parsed.data : null;
}

function parseTaskOrThrow(candidate: unknown): ScheduledTask {
  const parsed = scheduledTaskSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ScheduledTaskRepositoryError(
      "invalid",
      parsed.error.issues[0]?.message ?? "The scheduled task is invalid.",
    );
  }
  return parsed.data;
}

function parseRunOrThrow(candidate: unknown): ScheduledTaskRun {
  const parsed = scheduledTaskRunSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new ScheduledTaskRepositoryError(
      "invalid",
      parsed.error.issues[0]?.message ?? "The scheduled task run is invalid.",
    );
  }
  return parsed.data;
}

function normalizeOptionalError(value: string | null): string | null {
  return value === null ? null : normalizeScheduledTaskError(value);
}

export class ScheduledTaskRepository {
  constructor(private readonly database: Database.Database) {}

  list(projectId?: string): ScheduledTask[] {
    const rows = projectId === undefined
      ? (this.database.prepare(`
          SELECT ${TASK_COLUMNS}
          FROM scheduled_tasks
          ORDER BY updated_at DESC, id ASC
        `).all() as ScheduledTaskRow[])
      : (this.database.prepare(`
          SELECT ${TASK_COLUMNS}
          FROM scheduled_tasks
          WHERE project_id = ?
          ORDER BY updated_at DESC, id ASC
        `).all(projectId) as ScheduledTaskRow[]);
    return rows.flatMap((row) => {
      const task = taskFromRow(row);
      return task ? [task] : [];
    });
  }

  get(taskId: string): ScheduledTask | null {
    const row = this.database.prepare(
      `SELECT ${TASK_COLUMNS} FROM scheduled_tasks WHERE id = ?`,
    ).get(taskId) as ScheduledTaskRow | undefined;
    return row ? taskFromRow(row) : null;
  }

  create(
    input: ScheduledTaskCreateInput & {
      id: string;
      nextRunAt: string | null;
      now: string;
    },
  ): ScheduledTask {
    const { nextRunAt, now, ...createInput } = input;
    const parsedInput = scheduledTaskCreateInputSchema.safeParse(createInput);
    if (!parsedInput.success) {
      throw new ScheduledTaskRepositoryError(
        "invalid",
        parsedInput.error.issues[0]?.message ?? "The scheduled task input is invalid.",
      );
    }
    const data = parsedInput.data;
    const task = parseTaskOrThrow({
      id: input.id,
      projectId: data.projectId,
      title: data.title,
      prompt: data.prompt,
      schedule: data.schedule,
      boundConversationId: data.boundConversationId ?? null,
      freshSession: data.freshSession ?? false,
      modelSelection: data.modelSelection ?? null,
      interactionMode: data.interactionMode ?? "build",
      accessMode: data.accessMode ?? "supervised",
      enabled: data.enabled ?? true,
      nextRunAt,
      lastRunAt: null,
      lastRunStatus: null,
      lastConversationId: null,
      lastTurnId: null,
      lastError: null,
      consecutiveFailures: 0,
      createdBy: data.createdBy ?? "user",
      createdAt: now,
      updatedAt: now,
    });

    return this.database.transaction(() => {
      const project = this.database.prepare(
        "SELECT 1 FROM projects WHERE id = ?",
      ).get(task.projectId);
      if (!project) {
        throw new ScheduledTaskRepositoryError("missing", "Project not found.");
      }
      if (task.boundConversationId !== null) {
        this.assertBoundConversation(task.boundConversationId, task.projectId);
      }
      const totalCount = (this.database.prepare(
        "SELECT COUNT(*) AS count FROM scheduled_tasks",
      ).get() as { count: number }).count;
      if (totalCount >= MAX_SCHEDULED_TASKS_TOTAL) {
        throw new ScheduledTaskRepositoryError(
          "limit",
          `Scheduled tasks are limited to ${MAX_SCHEDULED_TASKS_TOTAL} across all projects.`,
        );
      }
      const projectCount = (this.database.prepare(
        "SELECT COUNT(*) AS count FROM scheduled_tasks WHERE project_id = ?",
      ).get(task.projectId) as { count: number }).count;
      if (projectCount >= MAX_SCHEDULED_TASKS_PER_PROJECT) {
        throw new ScheduledTaskRepositoryError(
          "limit",
          `A project can have at most ${MAX_SCHEDULED_TASKS_PER_PROJECT} scheduled tasks.`,
        );
      }
      try {
        this.database.prepare(`
          INSERT INTO scheduled_tasks (
            ${TASK_COLUMNS}
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          task.id,
          task.projectId,
          task.title,
          task.prompt,
          JSON.stringify(task.schedule),
          task.boundConversationId,
          task.freshSession ? 1 : 0,
          task.modelSelection === null ? null : JSON.stringify(task.modelSelection),
          task.interactionMode,
          task.accessMode,
          task.enabled ? 1 : 0,
          task.nextRunAt,
          task.lastRunAt,
          task.lastRunStatus,
          task.lastConversationId,
          task.lastTurnId,
          task.lastError,
          task.consecutiveFailures,
          task.createdBy,
          task.createdAt,
          task.updatedAt,
        );
      } catch (error) {
        const code = sqliteErrorCode(error);
        if (code === "SQLITE_CONSTRAINT_TRIGGER") {
          throw new ScheduledTaskRepositoryError(
            "limit",
            `A project can have at most ${MAX_SCHEDULED_TASKS_PER_PROJECT} scheduled tasks.`,
          );
        }
        if (code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_UNIQUE") {
          throw new ScheduledTaskRepositoryError(
            "conflict",
            "A scheduled task with that identifier already exists.",
          );
        }
        if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
          throw new ScheduledTaskRepositoryError(
            "missing",
            "The target project or bound chat no longer exists.",
          );
        }
        throw error;
      }
      return task;
    })();
  }

  update(
    taskId: string,
    patch: ScheduledTaskPatch & {
      nextRunAt?: string | null;
      now: string;
      lastError?: string | null;
      consecutiveFailures?: number;
      lastRunAt?: string | null;
      lastRunStatus?: ScheduledTaskRunStatus | null;
      lastConversationId?: string | null;
      lastTurnId?: string | null;
    },
  ): ScheduledTask {
    const {
      nextRunAt,
      now,
      lastError,
      consecutiveFailures,
      lastRunAt,
      lastRunStatus,
      lastConversationId,
      lastTurnId,
      ...basePatch
    } = patch;
    const parsedPatch = scheduledTaskPatchSchema.safeParse(basePatch);
    if (!parsedPatch.success) {
      throw new ScheduledTaskRepositoryError(
        "invalid",
        parsedPatch.error.issues[0]?.message ?? "The scheduled task update is invalid.",
      );
    }
    const validPatch = parsedPatch.data;

    return this.database.transaction(() => {
      const existing = this.get(taskId);
      if (!existing) {
        throw new ScheduledTaskRepositoryError("missing", "Scheduled task not found.");
      }
      const nextBoundConversationId = validPatch.boundConversationId !== undefined
        ? validPatch.boundConversationId
        : existing.boundConversationId;
      if (
        validPatch.boundConversationId !== undefined
        && nextBoundConversationId !== null
      ) {
        this.assertBoundConversation(nextBoundConversationId, existing.projectId);
      }
      const updated = parseTaskOrThrow({
        ...existing,
        title: validPatch.title ?? existing.title,
        prompt: validPatch.prompt ?? existing.prompt,
        schedule: validPatch.schedule ?? existing.schedule,
        boundConversationId: nextBoundConversationId,
        freshSession: validPatch.freshSession ?? existing.freshSession,
        modelSelection: validPatch.modelSelection !== undefined
          ? validPatch.modelSelection
          : existing.modelSelection,
        interactionMode: validPatch.interactionMode ?? existing.interactionMode,
        accessMode: validPatch.accessMode ?? existing.accessMode,
        enabled: validPatch.enabled ?? existing.enabled,
        nextRunAt: nextRunAt !== undefined ? nextRunAt : existing.nextRunAt,
        lastRunAt: lastRunAt !== undefined ? lastRunAt : existing.lastRunAt,
        lastRunStatus: lastRunStatus !== undefined ? lastRunStatus : existing.lastRunStatus,
        lastConversationId: lastConversationId !== undefined
          ? lastConversationId
          : existing.lastConversationId,
        lastTurnId: lastTurnId !== undefined ? lastTurnId : existing.lastTurnId,
        lastError: lastError !== undefined
          ? normalizeOptionalError(lastError)
          : existing.lastError,
        consecutiveFailures: consecutiveFailures !== undefined
          ? consecutiveFailures
          : existing.consecutiveFailures,
        updatedAt: now,
      });

      this.database.prepare(`
        UPDATE scheduled_tasks
        SET title = ?,
            prompt = ?,
            schedule_json = ?,
            bound_conversation_id = ?,
            fresh_session = ?,
            model_selection_json = ?,
            interaction_mode = ?,
            access_mode = ?,
            enabled = ?,
            next_run_at = ?,
            last_run_at = ?,
            last_run_status = ?,
            last_conversation_id = ?,
            last_turn_id = ?,
            last_error = ?,
            consecutive_failures = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        updated.title,
        updated.prompt,
        JSON.stringify(updated.schedule),
        updated.boundConversationId,
        updated.freshSession ? 1 : 0,
        updated.modelSelection === null ? null : JSON.stringify(updated.modelSelection),
        updated.interactionMode,
        updated.accessMode,
        updated.enabled ? 1 : 0,
        updated.nextRunAt,
        updated.lastRunAt,
        updated.lastRunStatus,
        updated.lastConversationId,
        updated.lastTurnId,
        updated.lastError,
        updated.consecutiveFailures,
        updated.updatedAt,
        taskId,
      );
      return updated;
    })();
  }

  runInTransaction<T>(work: () => T): T {
    return this.database.transaction(work).immediate();
  }

  delete(taskId: string): boolean {
    const result = this.database.prepare(
      "DELETE FROM scheduled_tasks WHERE id = ?",
    ).run(taskId);
    return result.changes > 0;
  }

  listDue(nowIso: string, limit?: number): ScheduledTask[] {
    let rows: ScheduledTaskRow[];
    if (limit === undefined) {
      rows = this.database.prepare(`
        SELECT ${TASK_COLUMNS}
        FROM scheduled_tasks
        WHERE enabled = 1
          AND next_run_at IS NOT NULL
          AND next_run_at <= ?
        ORDER BY next_run_at ASC, id ASC
      `).all(nowIso) as ScheduledTaskRow[];
    } else {
      const effectiveLimit = Math.max(0, Math.trunc(limit));
      if (effectiveLimit === 0) return [];
      rows = this.database.prepare(`
        SELECT ${TASK_COLUMNS}
        FROM scheduled_tasks
        WHERE enabled = 1
          AND next_run_at IS NOT NULL
          AND next_run_at <= ?
        ORDER BY next_run_at ASC, id ASC
        LIMIT ?
      `).all(nowIso, effectiveLimit) as ScheduledTaskRow[];
    }
    return rows.flatMap((row) => {
      const task = taskFromRow(row);
      return task ? [task] : [];
    });
  }

  listRuns(taskId: string, limit?: number): ScheduledTaskRun[] {
    const effectiveLimit = Math.max(
      0,
      Math.min(
        MAX_SCHEDULED_TASK_RUN_HISTORY,
        limit === undefined ? MAX_SCHEDULED_TASK_RUN_HISTORY : Math.trunc(limit),
      ),
    );
    if (effectiveLimit === 0) return [];
    const rows = this.database.prepare(`
      SELECT ${RUN_COLUMNS}
      FROM scheduled_task_runs
      WHERE task_id = ?
      ORDER BY rowid DESC
      LIMIT ?
    `).all(taskId, effectiveLimit) as ScheduledTaskRunRow[];
    return rows.flatMap((row) => {
      const run = runFromRow(row);
      return run ? [run] : [];
    });
  }

  getRun(runId: string): ScheduledTaskRun | null {
    const row = this.database.prepare(
      `SELECT ${RUN_COLUMNS} FROM scheduled_task_runs WHERE id = ?`,
    ).get(runId) as ScheduledTaskRunRow | undefined;
    return row ? runFromRow(row) : null;
  }

  findRunByTurnId(turnId: string): ScheduledTaskRun | null {
    const row = this.database.prepare(`
      SELECT ${RUN_COLUMNS}
      FROM scheduled_task_runs
      WHERE turn_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `).get(turnId) as ScheduledTaskRunRow | undefined;
    return row ? runFromRow(row) : null;
  }

  listActiveRuns(): ScheduledTaskRun[] {
    const rows = this.database.prepare(`
      SELECT ${RUN_COLUMNS}
      FROM scheduled_task_runs
      WHERE state IN ('claimed', 'queued', 'running')
      ORDER BY rowid ASC
    `).all() as ScheduledTaskRunRow[];
    return rows.flatMap((row) => {
      const run = runFromRow(row);
      return run ? [run] : [];
    });
  }

  hasActiveQueuedOrRunningOccurrence(taskId: string): boolean {
    const row = this.database.prepare(`
      SELECT 1
      FROM scheduled_task_runs
      WHERE task_id = ?
        AND state IN ('claimed', 'queued', 'running')
      LIMIT 1
    `).get(taskId);
    return row !== undefined;
  }

  claimRun(input: {
    runId: string;
    taskId: string;
    claimKey: string;
    trigger: ScheduledTaskRunTrigger;
    scheduledFor: string | null;
    claimedAt: string;
    nextRunAtAfterClaim: string | null;
    disableTaskAfterClaim?: boolean;
  }): ScheduledTaskRun | null {
    const run = parseRunOrThrow({
      id: input.runId,
      taskId: input.taskId,
      claimKey: input.claimKey,
      trigger: input.trigger,
      scheduledFor: input.scheduledFor,
      state: "claimed",
      conversationId: null,
      turnId: null,
      queueItemId: null,
      error: null,
      claimedAt: input.claimedAt,
      finishedAt: null,
    });

    return this.database.transaction(() => {
      const exists = this.database.prepare(
        "SELECT 1 FROM scheduled_tasks WHERE id = ?",
      ).get(run.taskId);
      if (!exists) return null;

      const inserted = this.database.prepare(`
        INSERT OR IGNORE INTO scheduled_task_runs (
          ${RUN_COLUMNS}
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        run.id,
        run.taskId,
        run.claimKey,
        run.trigger,
        run.scheduledFor,
        run.state,
        run.conversationId,
        run.turnId,
        run.queueItemId,
        run.error,
        run.claimedAt,
        run.finishedAt,
      );
      if (inserted.changes === 0) return null;

      if (input.disableTaskAfterClaim) {
        this.database.prepare(`
          UPDATE scheduled_tasks
          SET next_run_at = ?,
              enabled = 0,
              last_run_at = ?,
              last_run_status = 'claimed',
              last_turn_id = NULL,
              last_error = NULL,
              updated_at = ?
          WHERE id = ?
        `).run(input.nextRunAtAfterClaim, run.claimedAt, run.claimedAt, run.taskId);
      } else {
        this.database.prepare(`
          UPDATE scheduled_tasks
          SET next_run_at = ?,
              last_run_at = ?,
              last_run_status = 'claimed',
              last_turn_id = NULL,
              last_error = NULL,
              updated_at = ?
          WHERE id = ?
        `).run(input.nextRunAtAfterClaim, run.claimedAt, run.claimedAt, run.taskId);
      }

      this.database.prepare(`
        DELETE FROM scheduled_task_runs
        WHERE task_id = ?
          AND id NOT IN (
            SELECT id
            FROM scheduled_task_runs
            WHERE task_id = ?
            ORDER BY rowid DESC
            LIMIT ?
          )
      `).run(run.taskId, run.taskId, MAX_SCHEDULED_TASK_RUN_HISTORY);

      return run;
    })();
  }

  updateRun(
    runId: string,
    patch: {
      state?: ScheduledTaskRunStatus;
      conversationId?: string | null;
      turnId?: string | null;
      queueItemId?: string | null;
      error?: string | null;
      finishedAt?: string | null;
      updatedAt: string;
    },
  ): ScheduledTaskRun | null {
    void patch.updatedAt;
    return this.database.transaction(() => {
      const existing = this.getRun(runId);
      if (!existing) return null;

      const updated = parseRunOrThrow({
        ...existing,
        state: patch.state ?? existing.state,
        conversationId: patch.conversationId !== undefined
          ? patch.conversationId
          : existing.conversationId,
        turnId: patch.turnId !== undefined ? patch.turnId : existing.turnId,
        queueItemId: patch.queueItemId !== undefined
          ? patch.queueItemId
          : existing.queueItemId,
        error: patch.error !== undefined
          ? normalizeOptionalError(patch.error)
          : existing.error,
        finishedAt: patch.finishedAt !== undefined
          ? patch.finishedAt
          : existing.finishedAt,
      });

      this.database.prepare(`
        UPDATE scheduled_task_runs
        SET state = ?,
            conversation_id = ?,
            turn_id = ?,
            queue_item_id = ?,
            error = ?,
            finished_at = ?
        WHERE id = ?
      `).run(
        updated.state,
        updated.conversationId,
        updated.turnId,
        updated.queueItemId,
        updated.error,
        updated.finishedAt,
        runId,
      );
      return updated;
    })();
  }

  recordTaskOutcome(
    taskId: string,
    outcome: {
      lastRunAt: string;
      lastRunStatus: ScheduledTaskRunStatus;
      lastConversationId?: string | null;
      lastTurnId?: string | null;
      lastError: string | null;
      consecutiveFailures: number;
      updatedAt: string;
    },
  ): ScheduledTask | null {
    return this.database.transaction(() => {
      const existing = this.get(taskId);
      if (!existing) return null;

      const updated = parseTaskOrThrow({
        ...existing,
        lastRunAt: outcome.lastRunAt,
        lastRunStatus: outcome.lastRunStatus,
        lastConversationId: outcome.lastConversationId !== undefined
          ? outcome.lastConversationId
          : existing.lastConversationId,
        lastTurnId: outcome.lastTurnId !== undefined
          ? outcome.lastTurnId
          : existing.lastTurnId,
        lastError: normalizeOptionalError(outcome.lastError),
        consecutiveFailures: Math.max(0, Math.trunc(outcome.consecutiveFailures)),
        updatedAt: outcome.updatedAt,
      });

      this.database.prepare(`
        UPDATE scheduled_tasks
        SET last_run_at = ?,
            last_run_status = ?,
            last_conversation_id = ?,
            last_turn_id = ?,
            last_error = ?,
            consecutive_failures = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        updated.lastRunAt,
        updated.lastRunStatus,
        updated.lastConversationId,
        updated.lastTurnId,
        updated.lastError,
        updated.consecutiveFailures,
        updated.updatedAt,
        taskId,
      );
      return updated;
    })();
  }

  reconcileStrandedRuns(nowIso: string, errorMessage: string): ScheduledTaskRun[] {
    const normalizedError = normalizeScheduledTaskError(errorMessage);
    return this.database.transaction(() => {
      const stranded = this.database.prepare(`
        SELECT ${RUN_COLUMNS}
        FROM scheduled_task_runs
        WHERE state = 'claimed'
        ORDER BY claimed_at ASC, id ASC
      `).all() as ScheduledTaskRunRow[];
      if (stranded.length === 0) return [];

      this.database.prepare(`
        UPDATE scheduled_task_runs
        SET state = 'failed',
            error = ?,
            finished_at = ?
        WHERE state = 'claimed'
      `).run(normalizedError, nowIso);

      return stranded.flatMap((row) => {
        const run = runFromRow({
          ...row,
          state: "failed",
          error: normalizedError,
          finished_at: nowIso,
        });
        return run ? [run] : [];
      });
    })();
  }

  disableTasksForMissingOrArchivedTarget(nowIso: string): string[] {
    return this.database.transaction(() => {
      const targets = this.database.prepare(`
        SELECT scheduled_tasks.id AS id, conversations.id AS conversation_id
        FROM scheduled_tasks
        LEFT JOIN conversations ON conversations.id = scheduled_tasks.bound_conversation_id
        WHERE scheduled_tasks.enabled = 1
          AND scheduled_tasks.bound_conversation_id IS NOT NULL
          AND (conversations.id IS NULL OR conversations.archived_at IS NOT NULL)
        ORDER BY scheduled_tasks.id ASC
      `).all() as Array<{ id: string; conversation_id: string | null }>;
      if (targets.length === 0) return [];

      const disableStatement = this.database.prepare(`
        UPDATE scheduled_tasks
        SET enabled = 0,
            next_run_at = NULL,
            last_error = ?,
            updated_at = ?
        WHERE id = ?
      `);
      for (const target of targets) {
        disableStatement.run(
          target.conversation_id === null
            ? "The bound chat no longer exists."
            : "The bound chat was archived.",
          nowIso,
          target.id,
        );
      }
      return targets.map(({ id }) => id);
    })();
  }

  private assertBoundConversation(conversationId: string, projectId: string): void {
    const conversation = this.database.prepare(
      "SELECT project_id FROM conversations WHERE id = ?",
    ).get(conversationId) as { project_id: string } | undefined;
    if (!conversation) {
      throw new ScheduledTaskRepositoryError("missing", "Bound chat not found.");
    }
    if (conversation.project_id !== projectId) {
      throw new ScheduledTaskRepositoryError(
        "invalid",
        "Bound chat must belong to the same project.",
      );
    }
  }
}
