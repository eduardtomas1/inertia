import { useState } from "react";
import type { PrivateConnectScheduledTask } from "../../../../shared/private-connect/runtime-contract";

export interface ScheduledTasksSectionProps {
  tasks: readonly PrivateConnectScheduledTask[];
  canPrompt: boolean;
  offline: boolean;
  loading?: boolean;
  onRefresh?: () => Promise<void> | void;
  onToggle?: (taskId: string, enabled: boolean) => Promise<void> | void;
  onRunNow?: (taskId: string) => Promise<void> | void;
  onDelete?: (taskId: string) => Promise<void> | void;
}

type InFlightAction = {
  taskId: string;
  kind: "toggle" | "run-now" | "delete";
};

function formatTimestamp(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatRunStatus(
  status: NonNullable<PrivateConnectScheduledTask["lastRunStatus"]>,
): string {
  switch (status) {
    case "claimed": return "Starting";
    case "queued": return "Queued";
    case "running": return "Running";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "skipped": return "Skipped";
  }
}

export function ScheduledTasksSection({
  tasks,
  canPrompt,
  offline,
  loading = false,
  onRefresh,
  onToggle,
  onRunNow,
  onDelete,
}: ScheduledTasksSectionProps): React.JSX.Element {
  const [inFlight, setInFlight] = useState<InFlightAction | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ taskId: string; message: string } | null>(null);

  const showControls = canPrompt && !offline;
  const activeCount = tasks.filter((task) => task.enabled).length;
  const liveSummary = loading && tasks.length === 0
    ? "Loading scheduled tasks"
    : tasks.length === 0
      ? "No scheduled tasks"
      : `${tasks.length} scheduled ${tasks.length === 1 ? "task" : "tasks"}, ${activeCount} active`;

  const runAction = async (
    taskId: string,
    kind: InFlightAction["kind"],
    operation: (() => Promise<void> | void) | undefined,
  ): Promise<void> => {
    if (!showControls || !operation || inFlight !== null) return;
    setInFlight({ taskId, kind });
    setActionError(null);
    try {
      await operation();
      if (kind === "delete") {
        setConfirmDeleteId((current) => (current === taskId ? null : current));
      }
    } catch (error) {
      setActionError({
        taskId,
        message: error instanceof Error && error.message
          ? error.message
          : "Could not complete that scheduled task action.",
      });
    } finally {
      setInFlight(null);
    }
  };

  return (
    <section className="queue-section scheduled-tasks-section" aria-label="Scheduled tasks">
      <div className="queue-section-status" aria-live="polite">
        {liveSummary}
      </div>
      <div className="queue-item scheduled-tasks-header">
        <div className="queue-item-header">
          <div className="queue-chips">
            <h3>Scheduled tasks</h3>
            <span className="queue-chip">{tasks.length}</span>
          </div>
          {onRefresh && (
            <div className="queue-item-actions">
              <button
                type="button"
                className="queue-action-button"
                disabled={offline || loading || inFlight !== null}
                onClick={() => void onRefresh()}
              >
                {loading ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          )}
        </div>
      </div>
      {loading && tasks.length === 0 ? (
        <div className="queue-item">
          <p className="muted">Loading scheduled tasks…</p>
        </div>
      ) : tasks.length === 0 ? (
        <div className="queue-item">
          <p className="muted">No scheduled tasks.</p>
        </div>
      ) : (
        <div className="queue-list" role="list" aria-label="Scheduled tasks">
          {tasks.map((task) => {
            const busy = loading || inFlight !== null;
            const isToggling = inFlight?.taskId === task.id && inFlight.kind === "toggle";
            const isRunningNow = inFlight?.taskId === task.id && inFlight.kind === "run-now";
            const isDeleting = inFlight?.taskId === task.id && inFlight.kind === "delete";
            const confirmingDelete = showControls && confirmDeleteId === task.id;
            const statusText = task.enabled ? "Active" : "Paused";
            const itemLabel = `${task.title}, ${task.projectName}, ${statusText}`;

            return (
              <div
                key={task.id}
                className="queue-item"
                role="listitem"
                aria-label={itemLabel}
                data-enabled={task.enabled ? "true" : "false"}
              >
                <div className="queue-item-header">
                  <div className="queue-chips">
                    <span className="queue-chip queue-state">{statusText}</span>
                    <span className="queue-chip">{task.projectName}</span>
                    <span className="queue-chip">{task.scheduleLabel}</span>
                    {task.lastRunStatus && (
                      <span className="queue-chip">
                        Last: {formatRunStatus(task.lastRunStatus)}
                      </span>
                    )}
                  </div>
                  {showControls && (
                    <div className="queue-item-actions">
                      {confirmingDelete ? (
                        <>
                          <button
                            type="button"
                            className="queue-action-button"
                            disabled={busy || !onDelete}
                            aria-label={`Confirm delete ${task.title}`}
                            onClick={() => void runAction(
                              task.id,
                              "delete",
                              onDelete ? () => onDelete(task.id) : undefined,
                            )}
                          >
                            {isDeleting ? "Deleting…" : "Confirm delete"}
                          </button>
                          <button
                            type="button"
                            className="queue-action-button"
                            disabled={isDeleting}
                            onClick={() => setConfirmDeleteId(null)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="queue-action-button"
                            disabled={busy || !onToggle}
                            aria-label={`${task.enabled ? "Pause" : "Resume"} ${task.title}`}
                            onClick={() => void runAction(
                              task.id,
                              "toggle",
                              onToggle ? () => onToggle(task.id, !task.enabled) : undefined,
                            )}
                          >
                            {isToggling
                              ? (task.enabled ? "Pausing…" : "Resuming…")
                              : (task.enabled ? "Pause" : "Resume")}
                          </button>
                          <button
                            type="button"
                            className="queue-action-button"
                            disabled={busy || !onRunNow}
                            aria-label={`Run ${task.title} now`}
                            onClick={() => void runAction(
                              task.id,
                              "run-now",
                              onRunNow ? () => onRunNow(task.id) : undefined,
                            )}
                          >
                            {isRunningNow ? "Running…" : "Run now"}
                          </button>
                          <button
                            type="button"
                            className="queue-action-button"
                            disabled={busy || !onDelete}
                            aria-label={`Delete ${task.title}`}
                            onClick={() => {
                              setActionError(null);
                              setConfirmDeleteId(task.id);
                            }}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
                <p className="queue-item-content">{task.title}</p>
                <small className="muted">
                  {task.enabled && task.nextRunAt ? (
                    <>
                      Next run: <time dateTime={task.nextRunAt}>{formatTimestamp(task.nextRunAt)}</time>
                    </>
                  ) : !task.enabled ? (
                    "Paused"
                  ) : (
                    "No upcoming run"
                  )}
                </small>
                {task.lastError && (
                  <p className="queue-item-error" role="alert">{task.lastError}</p>
                )}
                {actionError?.taskId === task.id && (
                  <p className="queue-item-error" role="alert">{actionError.message}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
