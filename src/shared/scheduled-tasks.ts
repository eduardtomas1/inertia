import { z } from "zod";

import { modelSelectionSchema, type ModelSelection } from "./model-routing";

export const MAX_SCHEDULED_TASKS_PER_PROJECT = 100;
export const MAX_SCHEDULED_TASKS_TOTAL = 1_000;
export const MIN_SCHEDULED_INTERVAL_MS = 60_000;
export const MAX_SCHEDULED_INTERVAL_MS = 365 * 24 * 60 * 60 * 1_000;
export const MAX_SCHEDULED_TASK_TITLE_CHARS = 160;
export const MAX_SCHEDULED_TASK_PROMPT_CHARS = 20_000;
export const MAX_SCHEDULED_TASK_ERROR_CHARS = 400;
export const MAX_SCHEDULED_TASK_RUN_HISTORY = 25;
export const SCHEDULED_TASK_FAILURE_TRACKING_WINDOW_MS = 24 * 60 * 60 * 1_000;

const TIME_OF_DAY_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const ISO_TIMESTAMP = z.string().datetime({ offset: true });

export const scheduledTaskWeekdaySchema = z.number().int().min(0).max(6);

export const scheduledTaskIntervalScheduleSchema = z.object({
  type: z.literal("interval"),
  everyMs: z.number().int().min(MIN_SCHEDULED_INTERVAL_MS).max(MAX_SCHEDULED_INTERVAL_MS),
}).strict();

export const scheduledTaskFixedTimeScheduleSchema = z.object({
  type: z.literal("fixed_time"),
  timeOfDay: z.string().regex(TIME_OF_DAY_PATTERN, "Use 24-hour HH:MM time (00:00 to 23:59)."),
  weekdays: z.array(scheduledTaskWeekdaySchema).min(1).max(7).optional().transform((days) => {
    if (!days) return undefined;
    return [...new Set(days)].sort((left, right) => left - right);
  }),
}).strict();

export const scheduledTaskOnceScheduleSchema = z.object({
  type: z.literal("once"),
  runAt: ISO_TIMESTAMP,
}).strict();

export const scheduledTaskScheduleSchema = z.discriminatedUnion("type", [
  scheduledTaskIntervalScheduleSchema,
  scheduledTaskFixedTimeScheduleSchema,
  scheduledTaskOnceScheduleSchema,
]);
export type ScheduledTaskSchedule = z.infer<typeof scheduledTaskScheduleSchema>;

export const scheduledTaskRunStatusSchema = z.enum([
  "claimed",
  "queued",
  "running",
  "completed",
  "failed",
  "skipped",
]);
export type ScheduledTaskRunStatus = z.infer<typeof scheduledTaskRunStatusSchema>;

export const scheduledTaskRunTriggerSchema = z.enum(["schedule", "manual"]);
export type ScheduledTaskRunTrigger = z.infer<typeof scheduledTaskRunTriggerSchema>;

export const scheduledTaskCreatedBySchema = z.enum(["user", "agent"]);
export type ScheduledTaskCreatedBy = z.infer<typeof scheduledTaskCreatedBySchema>;

export const scheduledTaskInteractionModeSchema = z.enum(["build", "plan"]);
export const scheduledTaskAccessModeSchema = z.enum(["supervised", "auto-edit", "full"]);

export const scheduledTaskTitleSchema = z.string().trim().min(1).max(MAX_SCHEDULED_TASK_TITLE_CHARS);
export const scheduledTaskPromptSchema = z.string().trim().min(1).max(MAX_SCHEDULED_TASK_PROMPT_CHARS);

export const scheduledTaskSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().min(1).max(200),
  title: scheduledTaskTitleSchema,
  prompt: scheduledTaskPromptSchema,
  schedule: scheduledTaskScheduleSchema,
  boundConversationId: z.string().uuid().nullable(),
  freshSession: z.boolean(),
  modelSelection: modelSelectionSchema.nullable(),
  interactionMode: scheduledTaskInteractionModeSchema,
  accessMode: scheduledTaskAccessModeSchema,
  enabled: z.boolean(),
  nextRunAt: ISO_TIMESTAMP.nullable(),
  lastRunAt: ISO_TIMESTAMP.nullable(),
  lastRunStatus: scheduledTaskRunStatusSchema.nullable(),
  lastConversationId: z.string().uuid().nullable(),
  lastTurnId: z.string().min(1).max(200).nullable(),
  lastError: z.string().max(MAX_SCHEDULED_TASK_ERROR_CHARS).nullable(),
  consecutiveFailures: z.number().int().min(0),
  createdBy: scheduledTaskCreatedBySchema,
  createdAt: ISO_TIMESTAMP,
  updatedAt: ISO_TIMESTAMP,
}).strict();
export type ScheduledTask = z.infer<typeof scheduledTaskSchema>;

export const scheduledTaskRunSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  claimKey: z.string().min(1).max(240),
  trigger: scheduledTaskRunTriggerSchema,
  scheduledFor: ISO_TIMESTAMP.nullable(),
  state: scheduledTaskRunStatusSchema,
  conversationId: z.string().uuid().nullable(),
  turnId: z.string().min(1).max(200).nullable(),
  queueItemId: z.string().uuid().nullable(),
  error: z.string().max(MAX_SCHEDULED_TASK_ERROR_CHARS).nullable(),
  claimedAt: ISO_TIMESTAMP,
  finishedAt: ISO_TIMESTAMP.nullable(),
}).strict();
export type ScheduledTaskRun = z.infer<typeof scheduledTaskRunSchema>;

export const scheduledTaskCreateInputSchema = z.object({
  id: z.string().uuid().optional(),
  projectId: z.string().min(1).max(200),
  title: scheduledTaskTitleSchema,
  prompt: scheduledTaskPromptSchema,
  schedule: scheduledTaskScheduleSchema,
  boundConversationId: z.string().uuid().nullable().optional(),
  freshSession: z.boolean().optional(),
  modelSelection: modelSelectionSchema.nullable().optional(),
  interactionMode: scheduledTaskInteractionModeSchema.optional(),
  accessMode: scheduledTaskAccessModeSchema.optional(),
  enabled: z.boolean().optional(),
  createdBy: scheduledTaskCreatedBySchema.optional(),
}).strict();
export type ScheduledTaskCreateInput = z.infer<typeof scheduledTaskCreateInputSchema>;

export const scheduledTaskPatchSchema = z.object({
  title: scheduledTaskTitleSchema.optional(),
  prompt: scheduledTaskPromptSchema.optional(),
  schedule: scheduledTaskScheduleSchema.optional(),
  boundConversationId: z.string().uuid().nullable().optional(),
  freshSession: z.boolean().optional(),
  modelSelection: modelSelectionSchema.nullable().optional(),
  interactionMode: scheduledTaskInteractionModeSchema.optional(),
  accessMode: scheduledTaskAccessModeSchema.optional(),
  enabled: z.boolean().optional(),
}).strict();
export type ScheduledTaskPatch = z.infer<typeof scheduledTaskPatchSchema>;

export interface ScheduledTaskSummary {
  task: ScheduledTask;
  recentRuns: ScheduledTaskRun[];
}

export type ScheduledTaskModelSelection = ModelSelection | null;

const WEEKDAY_SHORT_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function parseTimeOfDay(timeOfDay: string): { hours: number; minutes: number } {
  if (!TIME_OF_DAY_PATTERN.test(timeOfDay)) {
    throw new Error("Invalid timeOfDay; expected 24-hour HH:MM.");
  }
  const [hourText, minuteText] = timeOfDay.split(":");
  return {
    hours: Number.parseInt(hourText!, 10),
    minutes: Number.parseInt(minuteText!, 10),
  };
}

/**
 * Computes the next scheduled ISO timestamp strictly after `after` (or for a
 * `once` schedule, returns `runAt` when it has not yet elapsed relative to
 * `after`, or `null` if it has already passed).
 */
export function computeNextScheduledRunAt(
  schedule: ScheduledTaskSchedule,
  after: Date = new Date(),
): string | null {
  const afterMs = after.getTime();
  if (!Number.isFinite(afterMs)) {
    throw new Error("Reference time must be a valid Date.");
  }
  if (schedule.type === "interval") {
    return new Date(afterMs + schedule.everyMs).toISOString();
  }
  if (schedule.type === "once") {
    const targetMs = Date.parse(schedule.runAt);
    if (!Number.isFinite(targetMs)) return null;
    return targetMs > afterMs ? new Date(targetMs).toISOString() : null;
  }
  const { hours, minutes } = parseTimeOfDay(schedule.timeOfDay);
  const allowedDays = schedule.weekdays && schedule.weekdays.length > 0
    ? new Set(schedule.weekdays)
    : null;
  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    const candidate = new Date(
      after.getFullYear(),
      after.getMonth(),
      after.getDate() + dayOffset,
      hours,
      minutes,
      0,
      0,
    );
    if (candidate.getTime() <= afterMs) continue;
    if (allowedDays && !allowedDays.has(candidate.getDay())) continue;
    return candidate.toISOString();
  }
  return null;
}

export function formatScheduledTaskSchedule(schedule: ScheduledTaskSchedule): string {
  if (schedule.type === "interval") {
    const minutes = Math.round(schedule.everyMs / 60_000);
    if (minutes < 60) return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
    if (minutes % 1_440 === 0) {
      const days = minutes / 1_440;
      return days === 1 ? "Every day" : `Every ${days} days`;
    }
    if (minutes % 60 === 0) {
      const hours = minutes / 60;
      return hours === 1 ? "Every hour" : `Every ${hours} hours`;
    }
    const hours = Math.floor(minutes / 60);
    const remMinutes = minutes % 60;
    return `Every ${hours}h ${remMinutes}m`;
  }
  if (schedule.type === "once") {
    return `Once at ${schedule.runAt}`;
  }
  if (!schedule.weekdays || schedule.weekdays.length === 0 || schedule.weekdays.length === 7) {
    return `Daily at ${schedule.timeOfDay}`;
  }
  if (schedule.weekdays.length === 5 && schedule.weekdays.every((day, index) => day === index + 1)) {
    return `Weekdays at ${schedule.timeOfDay}`;
  }
  const days = schedule.weekdays.map((day) => WEEKDAY_SHORT_LABELS[day] ?? String(day)).join(", ");
  return `${days} at ${schedule.timeOfDay}`;
}

export function normalizeScheduledTaskError(value: unknown): string {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : "Scheduled run failed.";
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!cleaned) return "Scheduled run failed.";
  return Array.from(cleaned).slice(0, MAX_SCHEDULED_TASK_ERROR_CHARS).join("");
}
