// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { CURRENT_DATABASE_SCHEMA_VERSION } from "../../src/server/persistence/migrations/catalog";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import {
  SCHEDULED_TASKS_SCHEMA_VERSION,
  scheduledTasksMigration,
} from "../../src/server/persistence/migrations/scheduled-tasks";
import { ScheduledTaskRepositoryError } from "../../src/server/persistence/scheduled-task-repository";
import { modelSelectionSchema, providerNativeModelSelection } from "../../src/shared/model-routing";
import {
  MAX_SCHEDULED_TASKS_PER_PROJECT,
  MAX_SCHEDULED_TASK_RUN_HISTORY,
} from "../../src/shared/scheduled-tasks";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

describe("Migration 132 (PersistScheduledTasks) and ScheduledTaskRepository", () => {
  it("upgrades schema 131 to 132 idempotently and enforces schema constraints, cascades, and project limit trigger", () => {
    const directory = createTempDir("inertia-m132-");
    const dbPath = join(directory, "inertia.sqlite");
    const db = new Database(dbPath);
    try {
      db.pragma("foreign_keys = ON");
      migrateRuntimeDatabase(db, SCHEDULED_TASKS_SCHEMA_VERSION - 1);
      expect(
        (db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v,
      ).toBe(131);

      const now = "2026-11-27T10:00:00.000Z";
      const projectA = randomUUID();
      const projectB = randomUUID();
      const convA = randomUUID();
      const selection = modelSelectionSchema.parse(
        providerNativeModelSelection({ providerId: "codex", modelId: "gpt-5.4" }),
      );

      const insertProject = db.prepare(`
        INSERT INTO projects (
          id, name, path, normalized_path, repository_relative_path,
          git_repository_limit, color, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, '.', 16, '#6f76d9', 'ready', ?, ?)
      `);
      insertProject.run(projectA, "Project A", join(directory, "a"), join(directory, "a"), now, now);
      insertProject.run(projectB, "Project B", join(directory, "b"), join(directory, "b"), now, now);
      db.prepare(`
        INSERT INTO conversations (
          id, project_id, title, provider_id, model_selection_json, model,
          reasoning_effort, interaction_mode, access_mode, status,
          last_viewed_at, created_at, updated_at
        ) VALUES (?, ?, 'Bound chat', 'codex', ?, 'gpt-5.4', '', 'build', 'supervised', 'idle', ?, ?, ?)
      `).run(convA, projectA, JSON.stringify(selection), now, now, now);

      migrateRuntimeDatabase(db);
      expect(
        (db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }).v,
      ).toBe(CURRENT_DATABASE_SCHEMA_VERSION);

      const objects = db.prepare(`
        SELECT type, name
        FROM sqlite_master
        WHERE name IN (
          'scheduled_tasks',
          'scheduled_task_runs',
          'scheduled_tasks_project_idx',
          'scheduled_tasks_due_idx',
          'scheduled_task_runs_task_idx',
          'scheduled_task_runs_turn_idx',
          'scheduled_tasks_project_limit'
        )
        ORDER BY name
      `).all();
      expect(objects).toEqual([
        { type: "table", name: "scheduled_task_runs" },
        { type: "index", name: "scheduled_task_runs_task_idx" },
        { type: "index", name: "scheduled_task_runs_turn_idx" },
        { type: "table", name: "scheduled_tasks" },
        { type: "index", name: "scheduled_tasks_due_idx" },
        { type: "index", name: "scheduled_tasks_project_idx" },
        { type: "trigger", name: "scheduled_tasks_project_limit" },
      ]);

      const insertTask = db.prepare(`
        INSERT INTO scheduled_tasks (
          id, project_id, title, prompt, schedule_json, bound_conversation_id,
          fresh_session, interaction_mode, access_mode, enabled,
          last_run_status, consecutive_failures, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const taskId = randomUUID();
      const scheduleJson = JSON.stringify({ type: "interval", everyMs: 60_000 });
      insertTask.run(
        taskId, projectA, "Hourly check", "Run checks", scheduleJson, convA,
        0, "build", "supervised", 1, null, 0, "user", now, now,
      );

      // CHECK constraints on scheduled_tasks
      expect(() => insertTask.run(
        randomUUID(), projectA, "Bad fresh", "P", scheduleJson, null,
        2, "build", "supervised", 1, null, 0, "user", now, now,
      )).toThrow(/CHECK/u);
      expect(() => insertTask.run(
        randomUUID(), projectA, "Bad mode", "P", scheduleJson, null,
        0, "invalid", "supervised", 1, null, 0, "user", now, now,
      )).toThrow(/CHECK/u);
      expect(() => insertTask.run(
        randomUUID(), projectA, "Bad access", "P", scheduleJson, null,
        0, "build", "root", 1, null, 0, "user", now, now,
      )).toThrow(/CHECK/u);
      expect(() => insertTask.run(
        randomUUID(), projectA, "Bad enabled", "P", scheduleJson, null,
        0, "build", "supervised", 2, null, 0, "user", now, now,
      )).toThrow(/CHECK/u);
      expect(() => insertTask.run(
        randomUUID(), projectA, "Bad status", "P", scheduleJson, null,
        0, "build", "supervised", 1, "unknown", 0, "user", now, now,
      )).toThrow(/CHECK/u);
      expect(() => insertTask.run(
        randomUUID(), projectA, "Bad failures", "P", scheduleJson, null,
        0, "build", "supervised", 1, null, -1, "user", now, now,
      )).toThrow(/CHECK/u);
      expect(() => insertTask.run(
        randomUUID(), projectA, "Bad creator", "P", scheduleJson, null,
        0, "build", "supervised", 1, null, 0, "system", now, now,
      )).toThrow(/CHECK/u);

      // CHECK & UNIQUE constraints on scheduled_task_runs
      const insertRun = db.prepare(`
        INSERT INTO scheduled_task_runs (
          id, task_id, claim_key, trigger, state, claimed_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      insertRun.run(randomUUID(), taskId, "claim-1", "schedule", "claimed", now);
      expect(() => insertRun.run(randomUUID(), taskId, "claim-1", "schedule", "claimed", now))
        .toThrow(/UNIQUE/u);
      expect(() => insertRun.run(randomUUID(), taskId, "claim-2", "webhook", "claimed", now))
        .toThrow(/CHECK/u);
      expect(() => insertRun.run(randomUUID(), taskId, "claim-3", "manual", "pending", now))
        .toThrow(/CHECK/u);

      // ON DELETE SET NULL on bound_conversation_id
      db.prepare("DELETE FROM conversations WHERE id = ?").run(convA);
      expect(
        (db.prepare("SELECT bound_conversation_id FROM scheduled_tasks WHERE id = ?").get(taskId) as {
          bound_conversation_id: string | null;
        }).bound_conversation_id,
      ).toBeNull();

      // Trigger enforces max 100 scheduled tasks per project
      for (let index = 1; index < MAX_SCHEDULED_TASKS_PER_PROJECT; index += 1) {
        insertTask.run(
          randomUUID(), projectA, `Task ${index}`, "Prompt", scheduleJson, null,
          0, "build", "supervised", 1, null, 0, "user", now, now,
        );
      }
      expect(() => insertTask.run(
        randomUUID(), projectA, "Task 101", "Prompt", scheduleJson, null,
        0, "build", "supervised", 1, null, 0, "user", now, now,
      )).toThrow(/at most 100 scheduled tasks/u);

      // Other project is unaffected by project A's limit
      const taskBId = randomUUID();
      insertTask.run(
        taskBId, projectB, "Project B task", "Prompt", scheduleJson, null,
        0, "build", "supervised", 1, null, 0, "agent", now, now,
      );
      insertRun.run(randomUUID(), taskBId, "claim-b-1", "manual", "completed", now);

      // ON DELETE CASCADE from projects removes tasks and their runs
      db.prepare("DELETE FROM projects WHERE id = ?").run(projectB);
      expect(
        (db.prepare("SELECT COUNT(*) AS c FROM scheduled_tasks WHERE project_id = ?").get(projectB) as { c: number }).c,
      ).toBe(0);
      expect(
        (db.prepare("SELECT COUNT(*) AS c FROM scheduled_task_runs WHERE task_id = ?").get(taskBId) as { c: number }).c,
      ).toBe(0);

      // Idempotent re-run of migration 132
      expect(() => db.exec(scheduledTasksMigration.up as string)).not.toThrow();
      expect(db.pragma("foreign_key_check")).toEqual([]);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      db.close();
    }
  });

  it("supports full CRUD, due queries, atomic claim/dedupe/pruning, run updates, recovery, and archived-target disabling", () => {
    const directory = createTempDir("inertia-scheduled-repo-");
    const dbPath = join(directory, "inertia.sqlite");
    const store = new RuntimeStore(dbPath, directory, { recoverInterruptedRuns: false });
    try {
      const alphaDir = join(directory, "alpha");
      const betaDir = join(directory, "beta");
      mkdirSync(alphaDir);
      mkdirSync(betaDir);
      const projectA = store.createProject("Alpha", alphaDir);
      const projectB = store.createProject("Beta", betaDir);
      const convA = store.createConversation(projectA.id, "Alpha chat");
      const convB = store.createConversation(projectB.id, "Beta chat");
      const selection = modelSelectionSchema.parse(
        providerNativeModelSelection({ providerId: "codex", modelId: "gpt-5.4" }),
      );

      const t1 = "2026-11-27T10:00:00.000Z";
      const t2 = "2026-11-27T10:05:00.000Z";
      const t3 = "2026-11-27T10:10:00.000Z";

      const task1 = store.scheduledTasks.create({
        id: randomUUID(),
        projectId: projectA.id,
        title: "Daily summary",
        prompt: "Summarize git log",
        schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [5, 1, 3] },
        boundConversationId: convA.id,
        freshSession: true,
        modelSelection: selection,
        interactionMode: "plan",
        accessMode: "auto-edit",
        enabled: true,
        createdBy: "agent",
        nextRunAt: t2,
        now: t1,
      });

      expect(task1).toMatchObject({
        projectId: projectA.id,
        title: "Daily summary",
        schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 3, 5] },
        boundConversationId: convA.id,
        freshSession: true,
        modelSelection: selection,
        interactionMode: "plan",
        accessMode: "auto-edit",
        enabled: true,
        nextRunAt: t2,
        consecutiveFailures: 0,
        createdBy: "agent",
      });

      const task2 = store.scheduledTasks.create({
        id: randomUUID(),
        projectId: projectA.id,
        title: "Frequent health check",
        prompt: "Check build status",
        schedule: { type: "interval", everyMs: 60_000 },
        nextRunAt: t1,
        now: t2,
      });

      const task3 = store.scheduledTasks.create({
        id: randomUUID(),
        projectId: projectB.id,
        title: "One-off migration",
        prompt: "Run one-off script",
        schedule: { type: "once", runAt: t3 },
        boundConversationId: convB.id,
        nextRunAt: t3,
        now: t3,
      });

      // Reject cross-project bound chat
      expect(() => store.scheduledTasks.create({
        id: randomUUID(),
        projectId: projectA.id,
        title: "Cross project",
        prompt: "Should fail",
        schedule: { type: "interval", everyMs: 60_000 },
        boundConversationId: convB.id,
        nextRunAt: t2,
        now: t1,
      })).toThrow(ScheduledTaskRepositoryError);

      // list() and list(projectId) ordered by updated_at DESC, id ASC
      expect(store.scheduledTasks.list().map((task) => task.id)).toEqual([
        task3.id,
        task2.id,
        task1.id,
      ]);
      expect(store.scheduledTasks.list(projectA.id).map((task) => task.id)).toEqual([
        task2.id,
        task1.id,
      ]);
      expect(store.scheduledTasks.get(task1.id)).toEqual(task1);
      expect(store.scheduledTasks.get(randomUUID())).toBeNull();

      // listDue returns enabled tasks with next_run_at <= nowIso ordered by next_run_at ASC
      expect(store.scheduledTasks.listDue(t2).map((task) => task.id)).toEqual([
        task2.id,
        task1.id,
      ]);
      expect(store.scheduledTasks.listDue(t2, 1).map((task) => task.id)).toEqual([task2.id]);

      // update modifies fields and clears nullable fields properly
      const updatedTask1 = store.scheduledTasks.update(task1.id, {
        title: "Updated summary",
        modelSelection: null,
        lastError: "Transient\nerror",
        consecutiveFailures: 2,
        now: t3,
      });
      expect(updatedTask1).toMatchObject({
        title: "Updated summary",
        modelSelection: null,
        lastError: "Transient error",
        consecutiveFailures: 2,
        updatedAt: t3,
      });

      // claimRun atomically inserts run and updates task; duplicate claimKey is a no-op
      const run1Id = randomUUID();
      const claimed = store.scheduledTasks.claimRun({
        runId: run1Id,
        taskId: task3.id,
        claimKey: `schedule:${task3.id}:${t3}`,
        trigger: "schedule",
        scheduledFor: t3,
        claimedAt: t3,
        nextRunAtAfterClaim: null,
        disableTaskAfterClaim: true,
      });
      expect(claimed).toMatchObject({
        id: run1Id,
        taskId: task3.id,
        state: "claimed",
        trigger: "schedule",
      });
      expect(store.scheduledTasks.get(task3.id)).toMatchObject({
        enabled: false,
        nextRunAt: null,
        lastRunAt: t3,
        lastRunStatus: "claimed",
      });
      expect(store.scheduledTasks.hasActiveQueuedOrRunningOccurrence(task3.id)).toBe(true);

      // Duplicate claimKey returns null and does not mutate task
      const duplicate = store.scheduledTasks.claimRun({
        runId: randomUUID(),
        taskId: task3.id,
        claimKey: `schedule:${task3.id}:${t3}`,
        trigger: "schedule",
        scheduledFor: t3,
        claimedAt: "2026-11-27T10:15:00.000Z",
        nextRunAtAfterClaim: "2026-11-27T11:00:00.000Z",
        disableTaskAfterClaim: false,
      });
      expect(duplicate).toBeNull();
      expect(store.scheduledTasks.get(task3.id)?.nextRunAt).toBeNull();
      expect(store.scheduledTasks.get(task3.id)?.updatedAt).toBe(t3);

      // updateRun + findRunByTurnId + recordTaskOutcome
      const turnId = `turn-${randomUUID()}`;
      const queueItemId = randomUUID();
      const running = store.scheduledTasks.updateRun(run1Id, {
        state: "running",
        conversationId: convB.id,
        turnId,
        queueItemId,
        updatedAt: "2026-11-27T10:11:00.000Z",
      });
      expect(running).toMatchObject({
        state: "running",
        conversationId: convB.id,
        turnId,
        queueItemId,
      });
      expect(store.scheduledTasks.findRunByTurnId(turnId)).toEqual(running);
      expect(store.scheduledTasks.hasActiveQueuedOrRunningOccurrence(task3.id)).toBe(true);

      const finishedAt = "2026-11-27T10:12:00.000Z";
      const completedRun = store.scheduledTasks.updateRun(run1Id, {
        state: "completed",
        finishedAt,
        updatedAt: finishedAt,
      });
      expect(completedRun?.state).toBe("completed");
      expect(store.scheduledTasks.hasActiveQueuedOrRunningOccurrence(task3.id)).toBe(false);

      const recorded = store.scheduledTasks.recordTaskOutcome(task3.id, {
        lastRunAt: finishedAt,
        lastRunStatus: "completed",
        lastConversationId: convB.id,
        lastTurnId: turnId,
        lastError: null,
        consecutiveFailures: 0,
        updatedAt: finishedAt,
      });
      expect(recorded).toMatchObject({
        lastRunStatus: "completed",
        lastConversationId: convB.id,
        lastTurnId: turnId,
        lastError: null,
        consecutiveFailures: 0,
      });

      // Run history pruning beyond MAX_SCHEDULED_TASK_RUN_HISTORY (25)
      const totalClaims = MAX_SCHEDULED_TASK_RUN_HISTORY + 5;
      const baseMs = Date.parse("2026-11-27T11:00:00.000Z");
      const claimedIds: string[] = [];
      for (let index = 0; index < totalClaims; index += 1) {
        const claimedAt = new Date(baseMs + index * 1_000).toISOString();
        const runId = randomUUID();
        claimedIds.push(runId);
        const run = store.scheduledTasks.claimRun({
          runId,
          taskId: task2.id,
          claimKey: `manual:${task2.id}:${index}`,
          trigger: "manual",
          scheduledFor: null,
          claimedAt,
          nextRunAtAfterClaim: new Date(baseMs + (index + 60) * 1_000).toISOString(),
        });
        expect(run).not.toBeNull();
        if (index < totalClaims - 1) {
          store.scheduledTasks.updateRun(runId, {
            state: "completed",
            finishedAt: claimedAt,
            updatedAt: claimedAt,
          });
        }
      }
      const runs = store.scheduledTasks.listRuns(task2.id, 50);
      expect(runs).toHaveLength(MAX_SCHEDULED_TASK_RUN_HISTORY);
      expect(runs[0]?.id).toBe(claimedIds[totalClaims - 1]);
      expect(runs[MAX_SCHEDULED_TASK_RUN_HISTORY - 1]?.id).toBe(claimedIds[5]);

      // reconcileStrandedRuns marks only 'claimed' runs as failed
      const bootIso = "2026-11-27T12:00:00.000Z";
      const stranded = store.scheduledTasks.reconcileStrandedRuns(bootIso, "Server restarted mid-claim.");
      expect(stranded).toHaveLength(1);
      expect(stranded[0]).toMatchObject({
        id: claimedIds[totalClaims - 1],
        state: "failed",
        error: "Server restarted mid-claim.",
        finishedAt: bootIso,
      });
      expect(store.scheduledTasks.getRun(claimedIds[totalClaims - 1]!)?.state).toBe("failed");
      expect(store.scheduledTasks.reconcileStrandedRuns(bootIso, "Again")).toEqual([]);

      // disableTasksForMissingOrArchivedTarget disables enabled tasks bound to archived chats
      store.archiveConversation(convA.id, true);
      const disabledIds = store.scheduledTasks.disableTasksForMissingOrArchivedTarget("2026-11-27T12:05:00.000Z");
      expect(disabledIds).toEqual([task1.id]);
      expect(store.scheduledTasks.get(task1.id)).toMatchObject({
        enabled: false,
        nextRunAt: null,
        lastError: "The bound chat was archived.",
        updatedAt: "2026-11-27T12:05:00.000Z",
      });
      expect(store.scheduledTasks.get(task2.id)?.enabled).toBe(true);

      // delete returns true once and cascades runs
      expect(store.scheduledTasks.delete(task2.id)).toBe(true);
      expect(store.scheduledTasks.delete(task2.id)).toBe(false);
      expect(store.scheduledTasks.listRuns(task2.id)).toEqual([]);

      // Repository enforces 100-task per-project limit with ScheduledTaskRepositoryError("limit")
      const gammaDir = join(directory, "gamma");
      mkdirSync(gammaDir);
      const projectC = store.createProject("Gamma", gammaDir);
      for (let index = 0; index < MAX_SCHEDULED_TASKS_PER_PROJECT; index += 1) {
        store.scheduledTasks.create({
          id: randomUUID(),
          projectId: projectC.id,
          title: `Limit task ${index}`,
          prompt: "Check",
          schedule: { type: "interval", everyMs: 60_000 },
          nextRunAt: t2,
          now: t1,
        });
      }
      expect(() => store.scheduledTasks.create({
        id: randomUUID(),
        projectId: projectC.id,
        title: "Overflow task",
        prompt: "Check",
        schedule: { type: "interval", everyMs: 60_000 },
        nextRunAt: t2,
        now: t1,
      })).toThrow(ScheduledTaskRepositoryError);
    } finally {
      store.close();
    }
  });
});
