import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertCircle, CalendarClock, ChevronDown, ChevronRight, Clock,
  MessageSquare, Pause, Pencil, Play, Plus, RefreshCw, Trash2, X,
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
import { LoadingMark } from "./ui";
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
  ["interval", "Interval"], ["fixed_time", "Daily / Weekdays"], ["once", "One-shot"],
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
    accessMode: "supervised", interactionMode: "build",
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

function statusBadge(task: ScheduledTask): { label: string; tone: "active" | "paused" | "failed" } {
  if (!task.enabled) return { label: "Paused", tone: "paused" };
  if (task.lastRunStatus === "failed" || task.lastError) return { label: "Failed", tone: "failed" };
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
    const built = buildSchedule(draft);
    if ("error" in built) { setFormError(built.error); return; }
    if (draft.threadTarget === "specific" && !draft.boundConversationId) {
      setFormError("Select a chat in this project, or choose another thread target.");
      return;
    }
    const common: ScheduledTaskPatch = {
      title, prompt, schedule: built.schedule,
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
              {scopedProjectName ? `${scopedProjectName} · ` : ""}
              {summaries.length === 0 ? "No schedules configured" : `${activeCount} active of ${summaries.length}`}
            </p>
          </div>
          <div className="scheduled-tasks-header-actions">
            <button type="button" className="scheduled-btn scheduled-btn-secondary" disabled={offline || loading} onClick={() => { void loadTasks(); }}>
              <RefreshCw size={14} aria-hidden="true" /><span>Refresh</span>
            </button>
            <button type="button" className="scheduled-btn scheduled-btn-primary" disabled={offline || projects.length === 0} onClick={openCreateForm}>
              <Plus size={14} aria-hidden="true" /><span>New schedule</span>
            </button>
          </div>
        </header>

        <p className="scheduled-tasks-local-note">
          Schedules run locally while Inertia is open. Missed recurring runs are skipped on startup.
        </p>

        <div className="scheduled-sr-only" role="status" aria-live="polite">{announcement}</div>

        {offline && (
          <div className="scheduled-banner scheduled-banner-muted" role="status">
            <AlertCircle size={15} aria-hidden="true" />
            <span>Offline — reconnect to create, edit, run, or remove scheduled tasks.</span>
          </div>
        )}

        {loadError && (
          <div className="scheduled-banner scheduled-banner-error" role="alert">
            <AlertCircle size={15} aria-hidden="true" />
            <span>{loadError}</span>
            <button type="button" className="scheduled-btn scheduled-btn-secondary scheduled-btn-sm" disabled={offline} onClick={() => { void loadTasks(); }}>
              Retry
            </button>
          </div>
        )}

        {formOpen && (
          <section className="scheduled-form-panel" aria-labelledby={formHeadingId}>
            <div className="scheduled-form-header">
              <h2 id={formHeadingId}>{isEditing ? "Edit schedule" : "New schedule"}</h2>
              <button type="button" className="scheduled-icon-close" aria-label="Close schedule form" onClick={closeForm}>
                <X size={16} aria-hidden="true" />
              </button>
            </div>

            <form className="scheduled-form" noValidate onSubmit={(e) => { void handleSubmit(e); }}>
              {formError && (
                <div className="scheduled-banner scheduled-banner-error" role="alert">
                  <AlertCircle size={15} aria-hidden="true" /><span>{formError}</span>
                </div>
              )}

              <div className="scheduled-field-grid">
                <div className="scheduled-field">
                  <label htmlFor="scheduled-task-project">Project</label>
                  <select id="scheduled-task-project" className="scheduled-control" value={draft.projectId} disabled={isEditing || projects.length <= 1 || formDisabled} onChange={(e) => { patchDraft({ projectId: e.target.value, boundConversationId: "" }); }}>
                    {projects.map((p) => <option key={p.id} value={p.id}>{p.name.trim() || projectNameFromPath(p.path)}</option>)}
                  </select>
                </div>
                <div className="scheduled-field">
                  <label htmlFor="scheduled-task-title">Title</label>
                  <input ref={titleInputRef} id="scheduled-task-title" type="text" className="scheduled-control" maxLength={MAX_SCHEDULED_TASK_TITLE_CHARS} required disabled={formDisabled} placeholder="Daily dependency check" value={draft.title} onChange={(e) => { patchDraft({ title: e.target.value }); }} />
                </div>
              </div>

              <div className="scheduled-field">
                <label htmlFor="scheduled-task-prompt">Prompt</label>
                <textarea id="scheduled-task-prompt" className="scheduled-control scheduled-textarea" rows={3} required disabled={formDisabled} aria-describedby="scheduled-task-prompt-help" placeholder="Review open pull requests and summarize any failing checks." value={draft.prompt} onChange={(e) => { patchDraft({ prompt: e.target.value }); }} />
                <p id="scheduled-task-prompt-help" className="scheduled-field-help">Instructions sent to the agent each time this schedule fires.</p>
              </div>

              <div className="scheduled-field">
                <span id={kindGroupId} className="scheduled-label">Schedule type</span>
                <div className="scheduled-segmented" role="radiogroup" aria-labelledby={kindGroupId}>
                  {KIND_OPTIONS.map(([value, label]) => (
                    <label key={value} className={`scheduled-segment${draft.scheduleKind === value ? " is-active" : ""}`}>
                      <input type="radio" name="scheduled-task-kind" value={value} checked={draft.scheduleKind === value} disabled={formDisabled} onChange={() => { patchDraft({ scheduleKind: value }); }} />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </div>

              {draft.scheduleKind === "interval" && (
                <div className="scheduled-inline-fields">
                  <div className="scheduled-field">
                    <label htmlFor="scheduled-task-interval-value">Every</label>
                    <input id="scheduled-task-interval-value" type="number" min={1} step={1} className="scheduled-control" disabled={formDisabled} value={draft.intervalValue} onChange={(e) => { patchDraft({ intervalValue: e.target.value }); }} />
                  </div>
                  <div className="scheduled-field">
                    <label htmlFor="scheduled-task-interval-unit">Unit</label>
                    <select id="scheduled-task-interval-unit" className="scheduled-control" disabled={formDisabled} value={draft.intervalUnit} onChange={(e) => { patchDraft({ intervalUnit: e.target.value as IntervalUnit }); }}>
                      <option value="minutes">Minutes</option>
                      <option value="hours">Hours</option>
                      <option value="days">Days</option>
                    </select>
                  </div>
                </div>
              )}

              {draft.scheduleKind === "fixed_time" && (
                <div className="scheduled-fixed-group">
                  <div className="scheduled-field scheduled-time-field">
                    <label htmlFor="scheduled-task-time">Time of day</label>
                    <input id="scheduled-task-time" type="time" className="scheduled-control" required disabled={formDisabled} value={draft.timeOfDay} onChange={(e) => { patchDraft({ timeOfDay: e.target.value }); }} />
                  </div>
                  <div className="scheduled-field">
                    <div className="scheduled-weekdays-header">
                      <span className="scheduled-label">Days</span>
                      <div className="scheduled-presets">
                        <button type="button" className="scheduled-preset-btn" disabled={formDisabled} onClick={() => { patchDraft({ weekdays: [...ALL_WEEKDAYS] }); }}>Every day</button>
                        <button type="button" className="scheduled-preset-btn" disabled={formDisabled} onClick={() => { patchDraft({ weekdays: [...WORK_WEEKDAYS] }); }}>Weekdays</button>
                      </div>
                    </div>
                    <div className="scheduled-weekday-row" role="group" aria-label="Weekdays">
                      {WEEKDAYS.map(([value, short, label]) => {
                        const pressed = draft.weekdays.includes(value);
                        return (
                          <button key={value} type="button" aria-pressed={pressed} aria-label={label} className={`scheduled-day-btn${pressed ? " is-selected" : ""}`} disabled={formDisabled} onClick={() => { toggleWeekday(value); }}>{short}</button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              )}

              {draft.scheduleKind === "once" && (
                <div className="scheduled-field">
                  <label htmlFor="scheduled-task-once">Run at (local time)</label>
                  <input id="scheduled-task-once" type="datetime-local" className="scheduled-control" required disabled={formDisabled} value={draft.onceLocal} onChange={(e) => { patchDraft({ onceLocal: e.target.value }); }} />
                </div>
              )}

              <div className="scheduled-field-grid">
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
                {draft.threadTarget === "specific" && (
                  <div className="scheduled-field">
                    <label htmlFor="scheduled-task-conversation">Chat</label>
                    <select id="scheduled-task-conversation" className="scheduled-control" disabled={formDisabled || projectConversations.length === 0} value={draft.boundConversationId} onChange={(e) => { patchDraft({ boundConversationId: e.target.value }); }}>
                      {projectConversations.length === 0
                        ? <option value="">No active chats in this project</option>
                        : projectConversations.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                    </select>
                  </div>
                )}
              </div>

              {draft.threadTarget === "specific" && (
                <label className="scheduled-checkbox-row" htmlFor="scheduled-task-fresh-session">
                  <input id="scheduled-task-fresh-session" type="checkbox" disabled={formDisabled} checked={draft.specificFreshSession} onChange={(e) => { patchDraft({ specificFreshSession: e.target.checked }); }} />
                  <span>Fresh session each run</span>
                </label>
              )}

              <div className="scheduled-field-grid">
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

              <div className="scheduled-form-footer">
                <button type="button" className="scheduled-btn scheduled-btn-secondary" disabled={submitting} onClick={closeForm}>Cancel</button>
                <button type="submit" className="scheduled-btn scheduled-btn-primary" disabled={formDisabled}>
                  {submitting ? "Saving…" : isEditing ? "Save changes" : "Create schedule"}
                </button>
              </div>
            </form>
          </section>
        )}

        {loading && summaries.length === 0 ? (
          <div className="scheduled-state-card" role="status">
            <LoadingMark aria-hidden="true" size={16} /><span>Loading scheduled tasks…</span>
          </div>
        ) : summaries.length === 0 && !loadError ? (
          formOpen ? null : (
            <div className="scheduled-state-card scheduled-empty-card">
              <CalendarClock size={22} aria-hidden="true" className="scheduled-empty-icon" />
              <h2>No scheduled tasks yet</h2>
              <p>Create a recurring interval, daily weekday schedule, or one-shot prompt to automate work in your projects.</p>
              <button type="button" className="scheduled-btn scheduled-btn-primary" disabled={offline || projects.length === 0} onClick={openCreateForm}>
                <Plus size={14} aria-hidden="true" /><span>Create schedule</span>
              </button>
            </div>
          )
        ) : (
          <ul className="scheduled-task-list" aria-label="Scheduled tasks">
            {summaries.map(({ task, recentRuns }) => {
              const badge = statusBadge(task);
              const busy = busyTaskIds.has(task.id);
              const runsOpen = expandedRunIds.has(task.id);
              const runsPanelId = `scheduled-runs-${task.id}`;
              const targetConvId = task.lastConversationId ?? task.boundConversationId;
              const targetConv = targetConvId ? conversationsById.get(targetConvId) ?? null : null;

              return (
                <li key={task.id} className="scheduled-task-item">
                  <article className="scheduled-task-card" aria-label={task.title}>
                    <div className="scheduled-task-top">
                      <div className="scheduled-task-title-row">
                        <h3 className="scheduled-task-title">{task.title}</h3>
                        <span className="scheduled-badge scheduled-badge-project">{projectLabel(task.projectId)}</span>
                        <span className={`scheduled-badge scheduled-badge-${badge.tone}`}>{badge.label}</span>
                        {task.consecutiveFailures > 0 && (
                          <span className="scheduled-badge scheduled-badge-failed">
                            {task.consecutiveFailures} {task.consecutiveFailures === 1 ? "failure" : "failures"}
                          </span>
                        )}
                      </div>

                      <div className="scheduled-task-actions">
                        <button type="button" className="scheduled-btn scheduled-btn-secondary scheduled-btn-sm" disabled={offline || busy} onClick={() => { handleToggleEnabled(task); }}>
                          {task.enabled ? <><Pause size={13} aria-hidden="true" /><span>Pause</span></> : <><Play size={13} aria-hidden="true" /><span>Resume</span></>}
                        </button>
                        <button type="button" className="scheduled-btn scheduled-btn-secondary scheduled-btn-sm" disabled={offline || busy} onClick={() => { handleRunNow(task); }}>
                          <Play size={13} aria-hidden="true" /><span>Run now</span>
                        </button>
                        <button type="button" className="scheduled-btn scheduled-btn-secondary scheduled-btn-sm" disabled={offline || busy} onClick={() => { openEditForm(task); }}>
                          <Pencil size={13} aria-hidden="true" /><span>Edit</span>
                        </button>
                        {targetConv && (
                          <button type="button" className="scheduled-btn scheduled-btn-secondary scheduled-btn-sm" onClick={() => { onOpenConversation(targetConv); }}>
                            <MessageSquare size={13} aria-hidden="true" /><span>Open latest chat</span>
                          </button>
                        )}
                        {confirmDeleteId === task.id ? (
                          <span className="scheduled-delete-confirm">
                            <button type="button" className="scheduled-btn scheduled-btn-danger scheduled-btn-sm" disabled={offline || busy} onClick={() => { handleDelete(task); }}>Confirm delete</button>
                            <button type="button" className="scheduled-btn scheduled-btn-secondary scheduled-btn-sm" disabled={busy} onClick={() => { setConfirmDeleteId(null); }}>Cancel</button>
                          </span>
                        ) : (
                          <button type="button" className="scheduled-btn scheduled-btn-ghost-danger scheduled-btn-sm" disabled={offline || busy} onClick={() => { setConfirmDeleteId(task.id); }}>
                            <Trash2 size={13} aria-hidden="true" /><span>Delete</span>
                          </button>
                        )}
                      </div>
                    </div>

                    <p className="scheduled-task-prompt">{task.prompt}</p>

                    <dl className="scheduled-task-meta">
                      <div>
                        <dt>Schedule</dt>
                        <dd><Clock size={13} aria-hidden="true" /><span>{formatScheduledTaskSchedule(task.schedule)}</span></dd>
                      </div>
                      <div>
                        <dt>Next run</dt>
                        <dd>{task.enabled ? formatLocalTimestamp(task.nextRunAt) : "Paused"}</dd>
                      </div>
                      <div>
                        <dt>Last run</dt>
                        <dd>{task.lastRunStatus ? `${runStateLabel(task.lastRunStatus)}${task.lastRunAt ? ` · ${formatLocalTimestamp(task.lastRunAt)}` : ""}` : "Never run"}</dd>
                      </div>
                      <div>
                        <dt>Execution</dt>
                        <dd>{threadLabel(task, conversationsById)} · {INTERACTION_LABELS[task.interactionMode]} · {ACCESS_LABELS[task.accessMode]}</dd>
                      </div>
                    </dl>

                    {task.lastError && (
                      <div className="scheduled-task-error" role="alert">
                        <AlertCircle size={14} aria-hidden="true" /><span>{task.lastError}</span>
                      </div>
                    )}

                    <div className="scheduled-runs-section">
                      <button
                        type="button" className="scheduled-runs-toggle"
                        aria-expanded={runsOpen} aria-controls={runsPanelId}
                        onClick={() => { toggleRuns(task.id); }}
                      >
                        {runsOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                        <span>Recent runs ({recentRuns.length})</span>
                      </button>

                      {runsOpen && (
                        <div id={runsPanelId} className="scheduled-runs-panel">
                          {recentRuns.length === 0 ? (
                            <p className="scheduled-runs-empty">No runs recorded yet.</p>
                          ) : (
                            <ul className="scheduled-runs-list">
                              {recentRuns.map((run) => (
                                <li key={run.id} className="scheduled-run-row">
                                  <span className={`scheduled-run-state is-${run.state}`}>{runStateLabel(run.state)}</span>
                                  <span className="scheduled-run-trigger">{run.trigger === "manual" ? "Manual" : "Scheduled"}</span>
                                  <span className="scheduled-run-time">{formatLocalTimestamp(run.finishedAt ?? run.claimedAt)}</span>
                                  {run.error && <span className="scheduled-run-error" role="alert">{run.error}</span>}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </div>
                  </article>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

export default ScheduledTasksView;
