import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertCircle, CalendarClock, ChevronRight, MessageSquare, Pause, Pencil, Play, Plus, RefreshCw, Trash2, X,
} from "lucide-react";
import type { AppSnapshot, Conversation, Project, ServerEvent } from "@shared/contracts";
import {
  formatScheduledTaskSchedule, MAX_SCHEDULED_INTERVAL_MS, MAX_SCHEDULED_TASK_TITLE_CHARS,
  MIN_SCHEDULED_INTERVAL_MS, type ScheduledTask, type ScheduledTaskCreateInput,
  type ScheduledTaskPatch, type ScheduledTaskRun, type ScheduledTaskSchedule,
  type ScheduledTaskSummary,
} from "@shared/scheduled-tasks";

import type { ConnectionStatus } from "../hooks/useInertiaConnection";
import { projectNameFromPath } from "../lib/format";
import { resultEvent, type CommandWithoutId, type ResultEvent } from "../lib/runtimeCommands";
import { IconButton, LoadingMark } from "./ui";
import "./ScheduledTasksView.css";

export interface ScheduledTasksViewProps {
  snapshot: AppSnapshot | null;
  status: ConnectionStatus;
  projectScopeId: string | null;
  refreshNonce?: number;
  request(command: CommandWithoutId, options?: { passive?: boolean }): Promise<ServerEvent>;
  onOpenConversation(conversation: Conversation): void;
  onError(message: string): void;
}

type ScheduleKind = ScheduledTaskSchedule["type"];
type IntervalUnit = "minutes" | "hours" | "days";
type ThreadTargetMode = "new" | "shared-fresh" | "specific";

interface FormDraft {
  editingTaskId: string | null;
  projectId: string;
  title: string;
  prompt: string;
  scheduleKind: ScheduleKind;
  intervalValue: string;
  intervalUnit: IntervalUnit;
  timeOfDay: string;
  weekdays: number[];
  onceLocal: string;
  threadTarget: ThreadTargetMode;
  boundConversationId: string;
  specificFreshSession: boolean;
  accessMode: ScheduledTask["accessMode"];
  interactionMode: ScheduledTask["interactionMode"];
  scheduleDirty: boolean;
}

const WEEKDAYS = [
  [0, "Sun", "Sunday"], [1, "Mon", "Monday"], [2, "Tue", "Tuesday"],
  [3, "Wed", "Wednesday"], [4, "Thu", "Thursday"], [5, "Fri", "Friday"], [6, "Sat", "Saturday"],
] as const;
const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const WORK_WEEKDAYS = [1, 2, 3, 4, 5];
const UNIT_MS: Record<IntervalUnit, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
const ACCESS_LABELS: Record<ScheduledTask["accessMode"], string> = {
  supervised: "Supervised", "auto-edit": "Auto-edit", full: "Full access",
};
const INTERACTION_LABELS: Record<ScheduledTask["interactionMode"], string> = { build: "Build", plan: "Plan" };
const KIND_OPTIONS = [
  ["interval", "Interval"], ["fixed_time", "Daily"], ["once", "Once"],
] as const;

function extractResult<Kind extends ResultEvent["result"]["kind"]>(
  response: ServerEvent,
  kind: Kind,
): Extract<ResultEvent["result"], { kind: Kind }> {
  if (response.type === "request.error") throw new Error(response.message);
  const { result } = resultEvent(response);
  if (result.kind !== kind) throw new Error("The local service returned an unexpected response.");
  return result as Extract<ResultEvent["result"], { kind: Kind }>;
}

const errorText = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message.trim() ? error.message : fallback;

const toggleSet = (current: ReadonlySet<string>, id: string, force?: boolean): ReadonlySet<string> => {
  const next = new Set(current);
  const add = force ?? !next.has(id);
  if (add) next.add(id); else next.delete(id);
  return next;
};

function toDateTimeLocal(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`;
}

function formatLocalTimestamp(iso: string | null): string {
  if (!iso) return "Not scheduled";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

function resolveDefaultProjectId(projects: readonly Project[], scopeId: string | null, activeId: string | null): string {
  if (scopeId && projects.some((p) => p.id === scopeId)) return scopeId;
  if (activeId && projects.some((p) => p.id === activeId)) return activeId;
  return projects[0]?.id ?? "";
}

function createBlankDraft(projectId: string): FormDraft {
  return {
    editingTaskId: null, projectId, title: "", prompt: "", scheduleKind: "interval",
    intervalValue: "30", intervalUnit: "minutes", timeOfDay: "09:00", weekdays: [...WORK_WEEKDAYS],
    onceLocal: toDateTimeLocal(new Date(Date.now() + 3_600_000)),
    threadTarget: "new", boundConversationId: "", specificFreshSession: false,
    accessMode: "supervised", interactionMode: "build", scheduleDirty: true,
  };
}

function draftFromTask(task: ScheduledTask): FormDraft {
  const base = createBlankDraft(task.projectId);
  if (task.schedule.type === "interval") {
    const ms = task.schedule.everyMs;
    base.scheduleKind = "interval";
    if (ms % UNIT_MS.days === 0) { base.intervalValue = String(ms / UNIT_MS.days); base.intervalUnit = "days"; }
    else if (ms % UNIT_MS.hours === 0) { base.intervalValue = String(ms / UNIT_MS.hours); base.intervalUnit = "hours"; }
    else { base.intervalValue = String(Math.max(1, Math.round(ms / UNIT_MS.minutes))); base.intervalUnit = "minutes"; }
  } else if (task.schedule.type === "fixed_time") {
    base.scheduleKind = "fixed_time";
    base.timeOfDay = task.schedule.timeOfDay;
    base.weekdays = task.schedule.weekdays?.length ? [...task.schedule.weekdays] : [...ALL_WEEKDAYS];
  } else {
    base.scheduleKind = "once";
    const parsed = Date.parse(task.schedule.runAt);
    if (Number.isFinite(parsed)) base.onceLocal = toDateTimeLocal(new Date(parsed));
  }
  return {
    ...base,
    editingTaskId: task.id,
    title: task.title,
    prompt: task.prompt,
    threadTarget: task.boundConversationId ? "specific" : task.freshSession ? "shared-fresh" : "new",
    boundConversationId: task.boundConversationId ?? "",
    specificFreshSession: Boolean(task.boundConversationId && task.freshSession),
    accessMode: task.accessMode,
    interactionMode: task.interactionMode,
    scheduleDirty: false,
  };
}

function buildSchedule(draft: FormDraft): { schedule: ScheduledTaskSchedule } | { error: string } {
  if (draft.scheduleKind === "interval") {
    const parsed = Number(draft.intervalValue);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return { error: "Interval must be a whole number of at least 1 minute." };
    }
    const everyMs = parsed * UNIT_MS[draft.intervalUnit];
    if (everyMs < MIN_SCHEDULED_INTERVAL_MS || everyMs > MAX_SCHEDULED_INTERVAL_MS) {
      return { error: "Interval must be between 1 minute and 365 days." };
    }
    return { schedule: { type: "interval", everyMs } };
  }
  if (draft.scheduleKind === "fixed_time") {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(draft.timeOfDay)) {
      return { error: "Choose a valid 24-hour time (HH:MM)." };
    }
    if (draft.weekdays.length === 0) return { error: "Select at least one weekday." };
    const sorted = [...new Set(draft.weekdays)].sort((a, b) => a - b);
    return {
      schedule: { type: "fixed_time", timeOfDay: draft.timeOfDay, weekdays: sorted.length === 7 ? undefined : sorted },
    };
  }
  if (!draft.onceLocal) return { error: "Choose a date and time for this one-shot schedule." };
  const parsed = new Date(draft.onceLocal);
  if (!Number.isFinite(parsed.getTime())) return { error: "Choose a valid date and time." };
  return { schedule: { type: "once", runAt: parsed.toISOString() } };
}

function statusBadge(task: ScheduledTask): { label: string; tone: "active" | "running" | "paused" | "failed" } {
  if (!task.enabled) return { label: "Paused", tone: "paused" };
  if (task.lastRunStatus === "running" || task.lastRunStatus === "queued" || task.lastRunStatus === "claimed") {
    return { label: task.lastRunStatus === "running" ? "Running" : "Queued", tone: "running" };
  }
  if (task.lastRunStatus === "failed") return { label: "Failed", tone: "failed" };
  return { label: "Active", tone: "active" };
}

const runStateLabel = (state: ScheduledTaskRun["state"]): string => state.charAt(0).toUpperCase() + state.slice(1);

function threadLabel(task: ScheduledTask, byId: ReadonlyMap<string, Conversation>): string {
  if (task.boundConversationId) {
    const title = byId.get(task.boundConversationId)?.title ?? "Specific chat";
    return task.freshSession ? `${title} (fresh session)` : title;
  }
  return task.freshSession ? "Shared thread, fresh session" : "New chat each run";
}

function upsertSummary(
  current: readonly ScheduledTaskSummary[],
  task: ScheduledTask,
  recentRuns?: ScheduledTaskRun[],
  prependedRun?: ScheduledTaskRun | null,
): ScheduledTaskSummary[] {
  const idx = current.findIndex((entry) => entry.task.id === task.id);
  if (idx === -1) return [{ task, recentRuns: recentRuns ?? (prependedRun ? [prependedRun] : []) }, ...current];
  return current.map((entry, i) => {
    if (i !== idx) return entry;
    let runs = recentRuns ?? entry.recentRuns;
    if (prependedRun && !runs.some((item) => item.id === prependedRun.id)) runs = [prependedRun, ...runs];
    return { task, recentRuns: runs };
  });
}

export function ScheduledTasksView({
  snapshot, status, projectScopeId, refreshNonce = 0, request, onOpenConversation, onError,
}: ScheduledTasksViewProps): React.JSX.Element {
  const headingId = useId();
  const formHeadingId = useId();
  const kindGroupId = useId();
  const titleInputRef = useRef<HTMLInputElement>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const restoreDeleteFocusIdRef = useRef<string | null>(null);
  const loadSeqRef = useRef(0);

  const [summaries, setSummaries] = useState<ScheduledTaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState<FormDraft>(() => createBlankDraft(""));
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [busyTaskIds, setBusyTaskIds] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [expandedRunIds, setExpandedRunIds] = useState<ReadonlySet<string>>(() => new Set());
  const [announcement, setAnnouncement] = useState("");

  const offline = status !== "online";
  const projects = useMemo(() => snapshot?.projects ?? [], [snapshot?.projects]);
  const conversations = useMemo(() => snapshot?.conversations ?? [], [snapshot?.conversations]);
  const projectsById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const conversationsById = useMemo(() => new Map(conversations.map((c) => [c.id, c])), [conversations]);

  const projectLabel = useCallback((projectId: string): string => {
    const project = projectsById.get(projectId);
    return project ? (project.name.trim() || projectNameFromPath(project.path)) : projectId;
  }, [projectsById]);

  const projectConversations = useMemo(
    () => draft.projectId ? conversations.filter((c) => c.projectId === draft.projectId && c.archivedAt === null) : [],
    [conversations, draft.projectId],
  );

  const patchDraft = useCallback((patch: Partial<FormDraft>): void => {
    setDraft((cur) => ({ ...cur, ...patch }));
  }, []);

  const loadTasks = useCallback(async (): Promise<void> => {
    if (offline) { setLoading(false); return; }
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const response = await request(
        { type: "scheduled-task.list", payload: projectScopeId ? { projectId: projectScopeId } : {} },
        { passive: true },
      );
      if (seq !== loadSeqRef.current) return;
      setSummaries(extractResult(response, "scheduled-tasks.list").tasks);
    } catch (error) {
      if (seq !== loadSeqRef.current) return;
      const msg = errorText(error, "Could not load scheduled tasks.");
      setLoadError(msg);
      onError(msg);
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [offline, onError, projectScopeId, request]);

  useEffect(() => {
    if (offline) { setLoading(false); return; }
    void loadTasks();
  }, [loadTasks, offline, refreshNonce]);

  useEffect(() => {
    if (confirmDeleteId !== null) {
      cancelDeleteRef.current?.focus();
    } else if (restoreDeleteFocusIdRef.current !== null) {
      const targetId = restoreDeleteFocusIdRef.current;
      restoreDeleteFocusIdRef.current = null;
      deleteButtonRefs.current.get(targetId)?.focus();
    }
  }, [confirmDeleteId]);

  const openForm = useCallback((nextDraft: FormDraft): void => {
    setDraft(nextDraft);
    setFormError(null);
    setFormOpen(true);
    queueMicrotask(() => titleInputRef.current?.focus());
  }, []);

  const openCreateForm = useCallback((): void => {
    openForm(createBlankDraft(resolveDefaultProjectId(projects, projectScopeId, snapshot?.activeProjectId ?? null)));
  }, [openForm, projectScopeId, projects, snapshot?.activeProjectId]);

  const openEditForm = useCallback((task: ScheduledTask): void => { openForm(draftFromTask(task)); }, [openForm]);
  const closeForm = useCallback((): void => { setFormOpen(false); setFormError(null); }, []);

  const toggleWeekday = useCallback((day: number): void => {
    setDraft((cur) => ({
      ...cur,
      weekdays: cur.weekdays.includes(day) ? cur.weekdays.filter((v) => v !== day) : [...cur.weekdays, day].sort((a, b) => a - b),
      scheduleDirty: true,
    }));
  }, []);

  const handleSubmit = useCallback(async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (offline || submitting) return;
    const title = draft.title.trim();
    const prompt = draft.prompt.trim();
    if (!draft.projectId) { setFormError("Select a project before saving a schedule."); return; }
    if (!title) { setFormError("Enter a title for this schedule."); return; }
    if (!prompt) { setFormError("Enter the prompt instructions to run."); return; }
    let schedule: ScheduledTaskSchedule | undefined;
    if (!draft.editingTaskId || draft.scheduleDirty) {
      const built = buildSchedule(draft);
      if ("error" in built) { setFormError(built.error); return; }
      schedule = built.schedule;
    }
    if (draft.threadTarget === "specific" && !draft.boundConversationId) {
      setFormError("Select a chat in this project, or choose another thread target.");
      return;
    }
    const common: ScheduledTaskPatch = {
      title, prompt,
      ...(schedule ? { schedule } : {}),
      boundConversationId: draft.threadTarget === "specific" ? draft.boundConversationId : null,
      freshSession: draft.threadTarget === "shared-fresh" ? true : draft.threadTarget === "specific" ? draft.specificFreshSession : false,
      accessMode: draft.accessMode, interactionMode: draft.interactionMode,
    };

    setSubmitting(true);
    setFormError(null);
    try {
      const res = draft.editingTaskId
        ? await request({ type: "scheduled-task.update", payload: { taskId: draft.editingTaskId, patch: common } })
        : await request({ type: "scheduled-task.create", payload: { projectId: draft.projectId, ...common } as ScheduledTaskCreateInput });
      const saved = extractResult(res, "scheduled-task");
      setSummaries((cur) => upsertSummary(cur, saved.task, saved.recentRuns));
      setAnnouncement(`${draft.editingTaskId ? "Updated" : "Created"} schedule ${saved.task.title}.`);
      setFormOpen(false);
    } catch (error) {
      const msg = errorText(error, "Could not save scheduled task.");
      setFormError(msg);
      onError(msg);
    } finally {
      setSubmitting(false);
    }
  }, [draft, offline, onError, request, submitting]);

  const runTaskAction = useCallback(async (
    taskId: string,
    fallbackError: string,
    action: () => Promise<void>,
  ): Promise<void> => {
    if (offline || busyTaskIds.has(taskId)) return;
    setBusyTaskIds((cur) => toggleSet(cur, taskId, true));
    try {
      await action();
    } catch (error) {
      onError(errorText(error, fallbackError));
    } finally {
      setBusyTaskIds((cur) => toggleSet(cur, taskId, false));
    }
  }, [busyTaskIds, offline, onError]);

  const handleToggleEnabled = useCallback((task: ScheduledTask): void => {
    void runTaskAction(task.id, "Could not update schedule state.", async () => {
      const res = await request({ type: "scheduled-task.update", payload: { taskId: task.id, patch: { enabled: !task.enabled } } });
      const updated = extractResult(res, "scheduled-task");
      setSummaries((cur) => upsertSummary(cur, updated.task, updated.recentRuns));
      setAnnouncement(updated.task.enabled ? `Resumed ${updated.task.title}.` : `Paused ${updated.task.title}.`);
    });
  }, [request, runTaskAction]);

  const handleRunNow = useCallback((task: ScheduledTask): void => {
    void runTaskAction(task.id, "Could not run scheduled task.", async () => {
      const res = await request({ type: "scheduled-task.run-now", payload: { taskId: task.id } });
      const ran = extractResult(res, "scheduled-task.ran");
      setSummaries((cur) => upsertSummary(cur, ran.task, undefined, ran.run));
      setAnnouncement(`Triggered ${ran.task.title}.`);
      const target = ran.conversationId ? conversationsById.get(ran.conversationId) : undefined;
      if (target) onOpenConversation(target);
    });
  }, [conversationsById, onOpenConversation, request, runTaskAction]);

  const handleDelete = useCallback((task: ScheduledTask): void => {
    void runTaskAction(task.id, "Could not delete scheduled task.", async () => {
      const res = await request({ type: "scheduled-task.delete", payload: { taskId: task.id } });
      if (res.type === "request.error") throw new Error(res.message);
      setSummaries((cur) => cur.filter((entry) => entry.task.id !== task.id));
      setConfirmDeleteId((cur) => (cur === task.id ? null : cur));
      setAnnouncement(`Deleted schedule ${task.title}.`);
    });
  }, [request, runTaskAction]);

  const toggleRuns = useCallback((taskId: string): void => {
    setExpandedRunIds((cur) => toggleSet(cur, taskId));
  }, []);

  const scopedProjectName = projectScopeId ? projectLabel(projectScopeId) : null;
  const activeCount = summaries.filter((entry) => entry.task.enabled).length;
  const isEditing = draft.editingTaskId !== null;
  const formDisabled = offline || submitting;

  return (
    <section className="scheduled-tasks-view" aria-labelledby={headingId}>
      <div className="scheduled-tasks-container">
        <header className="scheduled-tasks-header">
          <div className="scheduled-tasks-heading">
            <h1 id={headingId}>Scheduled tasks</h1>
            <p className="scheduled-tasks-subtitle">
              {scopedProjectName && <span>{scopedProjectName}</span>}
              <span>{summaries.length === 0 ? "No schedules" : `${activeCount} active of ${summaries.length}`}</span>
            </p>
          </div>
          <IconButton label="Refresh" disabled={offline || loading} onClick={() => { void loadTasks(); }}>
            <RefreshCw size={15} aria-hidden="true" />
          </IconButton>
          <button type="button" className="secondary-button" disabled={offline || projects.length === 0} onClick={openCreateForm}>
            <Plus size={15} aria-hidden="true" />New schedule
          </button>
        </header>

        <div className="visually-hidden" role="status" aria-live="polite">{announcement}</div>

        {offline && (
          <p className="scheduled-banner" role="status">
            <AlertCircle size={14} aria-hidden="true" />
            Offline — reconnect to create, edit, run, or remove scheduled tasks.
          </p>
        )}

        {loadError && (
          <p className="scheduled-banner is-error" role="alert">
            <AlertCircle size={14} aria-hidden="true" />
            <span>{loadError}</span>
            <button type="button" className="text-button" disabled={offline} onClick={() => { void loadTasks(); }}>Retry</button>
          </p>
        )}

        {formOpen && (
          <section className="scheduled-form-panel" aria-labelledby={formHeadingId}>
            <div className="scheduled-form-header">
              <h2 id={formHeadingId}>{isEditing ? "Edit schedule" : "New schedule"}</h2>
              <IconButton label="Close schedule form" onClick={closeForm}>
                <X size={15} aria-hidden="true" />
              </IconButton>
            </div>

            <form className="scheduled-form" noValidate onSubmit={(e) => { void handleSubmit(e); }}>
              {formError && (
                <p className="scheduled-banner is-error" role="alert">
                  <AlertCircle size={14} aria-hidden="true" /><span>{formError}</span>
                </p>
              )}

              <div className="scheduled-field-grid">
                <div className="scheduled-field">
                  <label htmlFor="scheduled-task-title">Title</label>
                  <input ref={titleInputRef} id="scheduled-task-title" type="text" className="scheduled-control" maxLength={MAX_SCHEDULED_TASK_TITLE_CHARS} required disabled={formDisabled} placeholder="Daily dependency check" value={draft.title} onChange={(e) => { patchDraft({ title: e.target.value }); }} />
                </div>
                <div className="scheduled-field">
                  <label htmlFor="scheduled-task-project">Project</label>
                  <select id="scheduled-task-project" className="scheduled-control" value={draft.projectId} disabled={isEditing || projects.length <= 1 || formDisabled} onChange={(e) => { patchDraft({ projectId: e.target.value, boundConversationId: "" }); }}>
                    {projects.map((p) => <option key={p.id} value={p.id}>{p.name.trim() || projectNameFromPath(p.path)}</option>)}
                  </select>
                </div>
              </div>

              <div className="scheduled-field">
                <label htmlFor="scheduled-task-prompt">Prompt</label>
                <textarea id="scheduled-task-prompt" className="scheduled-control" rows={3} required disabled={formDisabled} placeholder="Review open pull requests and summarize any failing checks." value={draft.prompt} onChange={(e) => { patchDraft({ prompt: e.target.value }); }} />
              </div>

              <div className="scheduled-field">
                <span id={kindGroupId} className="scheduled-label">Repeat</span>
                <div className="scheduled-segmented" role="radiogroup" aria-labelledby={kindGroupId}>
                  {KIND_OPTIONS.map(([value, label]) => (
                    <label key={value} className={`scheduled-segment${draft.scheduleKind === value ? " is-active" : ""}`}>
                      <input type="radio" name="scheduled-task-kind" value={value} checked={draft.scheduleKind === value} disabled={formDisabled} onChange={() => { patchDraft({ scheduleKind: value, scheduleDirty: true }); }} />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </div>

              {draft.scheduleKind === "interval" && (
                <div className="scheduled-field-grid">
                  <div className="scheduled-field">
                    <label htmlFor="scheduled-task-interval-value">Every</label>
                    <input id="scheduled-task-interval-value" type="number" min={1} step={1} className="scheduled-control" disabled={formDisabled} value={draft.intervalValue} onChange={(e) => { patchDraft({ intervalValue: e.target.value, scheduleDirty: true }); }} />
                  </div>
                  <div className="scheduled-field">
                    <label htmlFor="scheduled-task-interval-unit">Unit</label>
                    <select id="scheduled-task-interval-unit" className="scheduled-control" disabled={formDisabled} value={draft.intervalUnit} onChange={(e) => { patchDraft({ intervalUnit: e.target.value as IntervalUnit, scheduleDirty: true }); }}>
                      <option value="minutes">Minutes</option>
                      <option value="hours">Hours</option>
                      <option value="days">Days</option>
                    </select>
                  </div>
                </div>
              )}

              {draft.scheduleKind === "fixed_time" && (
                <div className="scheduled-field-grid">
                  <div className="scheduled-field">
                    <label htmlFor="scheduled-task-time">Time of day</label>
                    <input id="scheduled-task-time" type="time" className="scheduled-control" required disabled={formDisabled} value={draft.timeOfDay} onChange={(e) => { patchDraft({ timeOfDay: e.target.value, scheduleDirty: true }); }} />
                  </div>
                  <div className="scheduled-field">
                    <div className="scheduled-weekdays-header">
                      <span className="scheduled-label">Days</span>
                      <button type="button" className="scheduled-preset-btn" disabled={formDisabled} onClick={() => { patchDraft({ weekdays: [...ALL_WEEKDAYS], scheduleDirty: true }); }}>Every day</button>
                      <button type="button" className="scheduled-preset-btn" disabled={formDisabled} onClick={() => { patchDraft({ weekdays: [...WORK_WEEKDAYS], scheduleDirty: true }); }}>Weekdays</button>
                    </div>
                    <div className="scheduled-weekday-row" role="group" aria-label="Weekdays">
                      {WEEKDAYS.map(([value, short, label]) => (
                        <button key={value} type="button" aria-pressed={draft.weekdays.includes(value)} aria-label={label} className="scheduled-day-btn" disabled={formDisabled} onClick={() => { toggleWeekday(value); }}>{short}</button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {draft.scheduleKind === "once" && (
                <div className="scheduled-field scheduled-once-field">
                  <label htmlFor="scheduled-task-once">Run at (local time)</label>
                  <input id="scheduled-task-once" type="datetime-local" className="scheduled-control" required disabled={formDisabled} value={draft.onceLocal} onChange={(e) => { patchDraft({ onceLocal: e.target.value, scheduleDirty: true }); }} />
                </div>
              )}

              <div className="scheduled-field-grid scheduled-run-grid">
                <div className="scheduled-field">
                  <label htmlFor="scheduled-task-thread-target">Thread target</label>
                  <select id="scheduled-task-thread-target" className="scheduled-control" disabled={formDisabled} value={draft.threadTarget} onChange={(e) => {
                    const nextMode = e.target.value as ThreadTargetMode;
                    patchDraft({ threadTarget: nextMode, boundConversationId: nextMode === "specific" ? (draft.boundConversationId || projectConversations[0]?.id || "") : "" });
                  }}>
                    <option value="new">New chat each run</option>
                    <option value="shared-fresh">Shared thread, fresh session each run</option>
                    <option value="specific">Specific chat in project</option>
                  </select>
                </div>
                <div className="scheduled-field">
                  <label htmlFor="scheduled-task-access-mode">Access mode</label>
                  <select id="scheduled-task-access-mode" className="scheduled-control" disabled={formDisabled} value={draft.accessMode} onChange={(e) => { patchDraft({ accessMode: e.target.value as ScheduledTask["accessMode"] }); }}>
                    <option value="supervised">Supervised</option>
                    <option value="auto-edit">Auto-edit</option>
                    <option value="full">Full access</option>
                  </select>
                </div>
                <div className="scheduled-field">
                  <label htmlFor="scheduled-task-interaction-mode">Interaction mode</label>
                  <select id="scheduled-task-interaction-mode" className="scheduled-control" disabled={formDisabled} value={draft.interactionMode} onChange={(e) => { patchDraft({ interactionMode: e.target.value as ScheduledTask["interactionMode"] }); }}>
                    <option value="build">Build</option>
                    <option value="plan">Plan</option>
                  </select>
                </div>
              </div>

              {draft.threadTarget === "specific" && (
                <div className="scheduled-field-grid">
                  <div className="scheduled-field">
                    <label htmlFor="scheduled-task-conversation">Chat</label>
                    <select id="scheduled-task-conversation" className="scheduled-control" disabled={formDisabled || projectConversations.length === 0} value={draft.boundConversationId} onChange={(e) => { patchDraft({ boundConversationId: e.target.value }); }}>
                      {projectConversations.length === 0
                        ? <option value="">No active chats in this project</option>
                        : projectConversations.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                    </select>
                  </div>
                  <label className="scheduled-checkbox-row" htmlFor="scheduled-task-fresh-session">
                    <input id="scheduled-task-fresh-session" type="checkbox" disabled={formDisabled} checked={draft.specificFreshSession} onChange={(e) => { patchDraft({ specificFreshSession: e.target.checked }); }} />
                    Fresh session each run
                  </label>
                </div>
              )}

              <div className="scheduled-form-footer">
                <button type="button" className="text-button" disabled={submitting} onClick={closeForm}>Cancel</button>
                <button type="submit" className="primary-button" disabled={formDisabled}>
                  {submitting ? "Saving…" : isEditing ? "Save changes" : "Create schedule"}
                </button>
              </div>
            </form>
          </section>
        )}

        {loading && summaries.length === 0 ? (
          <p className="scheduled-state" role="status">
            <LoadingMark aria-hidden="true" size={14} />Loading scheduled tasks…
          </p>
        ) : summaries.length === 0 && !loadError ? (
          formOpen ? null : (
            <div className="scheduled-state scheduled-empty">
              <CalendarClock size={20} strokeWidth={1.5} aria-hidden="true" />
              <h2>No scheduled tasks yet</h2>
              <p>Run a prompt on an interval, at a set time each day, or once.</p>
            </div>
          )
        ) : (
          <ul className="scheduled-task-list" aria-label="Scheduled tasks">
            {summaries.map(({ task, recentRuns }) => {
              const badge = statusBadge(task);
              const busy = busyTaskIds.has(task.id);
              const locked = offline || busy;
              const runsOpen = expandedRunIds.has(task.id);
              const runsPanelId = `scheduled-runs-${task.id}`;
              const targetConvId = task.lastConversationId ?? task.boundConversationId;
              const targetConv = targetConvId ? conversationsById.get(targetConvId) ?? null : null;

              return (
                <li key={task.id}>
                  <article className="scheduled-task-card" data-tone={badge.tone} aria-label={task.title}>
                    <div className="scheduled-task-top">
                      <h3 className="scheduled-task-title">{task.title}</h3>
                      {confirmDeleteId === task.id ? (
                        <span className="scheduled-task-actions" role="group" aria-label={`Delete ${task.title}`}>
                          <button
                            ref={cancelDeleteRef}
                            type="button"
                            className="text-button"
                            disabled={busy}
                            onClick={() => {
                              restoreDeleteFocusIdRef.current = task.id;
                              setConfirmDeleteId(null);
                            }}
                          >
                            Cancel
                          </button>
                          <button type="button" className="text-button is-danger" disabled={locked} onClick={() => { handleDelete(task); }}>Confirm delete</button>
                        </span>
                      ) : (
                        <span className="scheduled-task-actions">
                          <button type="button" className="text-button" disabled={locked} onClick={() => { handleRunNow(task); }}>Run now</button>
                          <IconButton label={task.enabled ? "Pause" : "Resume"} disabled={locked} onClick={() => { handleToggleEnabled(task); }}>
                            {task.enabled ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
                          </IconButton>
                          <IconButton label="Edit" disabled={locked} onClick={() => { openEditForm(task); }}>
                            <Pencil size={15} aria-hidden="true" />
                          </IconButton>
                          {targetConv && (
                            <IconButton label="Open latest chat" onClick={() => { onOpenConversation(targetConv); }}>
                              <MessageSquare size={15} aria-hidden="true" />
                            </IconButton>
                          )}
                          <IconButton
                            ref={(el) => {
                              if (el) deleteButtonRefs.current.set(task.id, el);
                              else deleteButtonRefs.current.delete(task.id);
                            }}
                            label="Delete"
                            className="scheduled-delete"
                            disabled={locked}
                            onClick={() => { setConfirmDeleteId(task.id); }}
                          >
                            <Trash2 size={15} aria-hidden="true" />
                          </IconButton>
                        </span>
                      )}
                    </div>

                    <p className="scheduled-task-prompt">{task.prompt}</p>

                    <p className="scheduled-task-meta">
                      <span className="scheduled-status">{badge.label}</span>
                      {task.consecutiveFailures > 0 && (
                        <span className="scheduled-failures">
                          {task.consecutiveFailures} {task.consecutiveFailures === 1 ? "failure" : "failures"}
                        </span>
                      )}
                      <span>{task.schedule.type === "once" ? `Once ${formatLocalTimestamp(task.schedule.runAt)}` : formatScheduledTaskSchedule(task.schedule)}</span>
                      {task.enabled && <span>Next {formatLocalTimestamp(task.nextRunAt)}</span>}
                      <span>{task.lastRunStatus ? `Last run ${runStateLabel(task.lastRunStatus)}${task.lastRunAt ? ` · ${formatLocalTimestamp(task.lastRunAt)}` : ""}` : "Never run"}</span>
                    </p>
                    <p className="scheduled-task-meta">
                      {!projectScopeId && <span>{projectLabel(task.projectId)}</span>}
                      <span>{threadLabel(task, conversationsById)}</span>
                      <span>{INTERACTION_LABELS[task.interactionMode]}</span>
                      <span>{ACCESS_LABELS[task.accessMode]}</span>
                    </p>

                    {task.lastError && (
                      <p className="scheduled-task-error">
                        <AlertCircle size={13} aria-hidden="true" /><span>{task.lastError}</span>
                      </p>
                    )}

                    {recentRuns.length > 0 && (
                      <button
                        type="button" className="scheduled-runs-toggle"
                        aria-expanded={runsOpen} aria-controls={runsPanelId}
                        onClick={() => { toggleRuns(task.id); }}
                      >
                        <ChevronRight size={13} aria-hidden="true" />Recent runs ({recentRuns.length})
                      </button>
                    )}

                    {runsOpen && recentRuns.length > 0 && (
                      <ul id={runsPanelId} className="scheduled-runs-panel">
                        {recentRuns.map((run) => {
                          const runConv = run.conversationId ? conversationsById.get(run.conversationId) ?? null : null;
                          return (
                            <li key={run.id} className="scheduled-run-row">
                              <span className={`scheduled-run-state is-${run.state}`}>{runStateLabel(run.state)}</span>
                              <span>{run.trigger === "manual" ? "Manual" : "Scheduled"}</span>
                              <span>{formatLocalTimestamp(run.finishedAt ?? run.claimedAt)}</span>
                              {runConv && (
                                <button type="button" className="text-button" onClick={() => { onOpenConversation(runConv); }}>Open chat</button>
                              )}
                              {run.error && <span className="scheduled-run-error">{run.error}</span>}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </article>
                </li>
              );
            })}
          </ul>
        )}

        <p className="scheduled-tasks-note">
          Schedules run locally while Inertia is open. Missed recurring runs are skipped on startup.
        </p>
      </div>
    </section>
  );
}

export default ScheduledTasksView;
