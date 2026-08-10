import {
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  Check,
  CirclePause,
  Flag,
  Play,
  RefreshCw,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type {
  AgentGoal,
  AgentGoalSource,
  AgentGoalStatus,
  AgentWorkflowState,
} from "@shared/contracts";
import { IconButton } from "./ui";

interface GoalInput {
  source: AgentGoalSource;
  objective?: string;
  status: AgentGoalStatus;
  tokenBudget?: number | null;
}

export interface ChatGoalControlProps {
  workflow: AgentWorkflowState | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  onRetry: () => Promise<void>;
  onSetGoal: (input: GoalInput) => Promise<void>;
  onClearGoal: (source: AgentGoalSource) => Promise<void>;
}

export interface ChatGoalInlineProps extends ChatGoalControlProps {
  open: boolean;
  onDismiss: (
    reason: "action" | "escape" | "owner-change",
  ) => void;
}

function statusLabel(status: AgentGoalStatus): string {
  if (status === "usageLimited") return "Usage limited";
  if (status === "budgetLimited") return "Budget limited";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function routeLabel(source: AgentGoalSource): string {
  return source === "codex-native" ? "Codex goal" : "Local objective";
}

function nextActions(status: AgentGoalStatus): Array<{
  label: string;
  status: AgentGoalStatus;
  icon: React.JSX.Element;
}> {
  if (status === "active") {
    return [
      {
        label: "Pause",
        status: "paused",
        icon: <CirclePause size={13} aria-hidden="true" />,
      },
      {
        label: "Block",
        status: "blocked",
        icon: <Square size={11} aria-hidden="true" />,
      },
      {
        label: "Complete",
        status: "complete",
        icon: <Check size={13} aria-hidden="true" />,
      },
    ];
  }
  return [{
    label: status === "complete" ? "Reopen goal" : "Mark active",
    status: "active",
    icon: <Play size={12} aria-hidden="true" />,
  }];
}

function currentRouteGoal(workflow: AgentWorkflowState): AgentGoal | null {
  return workflow.goals.find(({ source }) =>
    source === workflow.goalCapability.kind) ?? null;
}

export function ChatGoalControl({
  workflow,
  loading,
  busy,
  error,
  onRetry,
  onSetGoal,
  onClearGoal,
  open,
  onDismiss,
}: ChatGoalInlineProps): React.JSX.Element | null {
  const inputId = useId();
  const headingId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);
  const [objective, setObjective] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const source = workflow?.goalCapability.kind ?? null;
  const goal = workflow ? currentRouteGoal(workflow) : null;
  const separateGoalCount = workflow?.goals.filter(({ source: goalSource }) =>
    goalSource !== source).length ?? 0;
  const label = source ? routeLabel(source) : "Goal";
  const stateLabel = goal ? statusLabel(goal.status) : null;
  const ownerKey = `${workflow?.conversationId ?? ""}:${source ?? ""}`;
  const ownerKeyRef = useRef(ownerKey);

  useEffect(() => {
    if (ownerKeyRef.current === ownerKey) return;
    ownerKeyRef.current = ownerKey;
    setObjective("");
    if (open) onDismiss("owner-change");
  }, [onDismiss, open, ownerKey]);

  useEffect(() => {
    if (!open) return;
    const dismissOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onDismiss("escape");
    };
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [onDismiss, open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      if (workflow && !goal) inputRef.current?.focus();
      else firstActionRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [goal, open, workflow]);

  const createGoal = async (): Promise<void> => {
    const nextObjective = objective.trim();
    if (!source || !nextObjective || submitting) return;
    setSubmitting(true);
    try {
      await onSetGoal({
        source,
        objective: nextObjective,
        status: "active",
        tokenBudget: null,
      });
      setObjective("");
      onDismiss("action");
    } catch {
      // The workspace error surface owns the public failure message. Keep the
      // disclosure and draft in place so the user can retry.
    } finally {
      setSubmitting(false);
    }
  };

  const updateStatus = async (status: AgentGoalStatus): Promise<void> => {
    if (!source || submitting) return;
    setSubmitting(true);
    try {
      await onSetGoal({ source, status });
    } catch {
      // The workspace error surface owns the public failure message.
    } finally {
      setSubmitting(false);
    }
  };

  const clearGoal = async (): Promise<void> => {
    if (!source || submitting) return;
    setSubmitting(true);
    try {
      await onClearGoal(source);
      onDismiss("action");
    } catch {
      // The workspace error surface owns the public failure message.
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="chat-goal-control is-command-surface"
      data-goal-source={source ?? "unavailable"}
      data-goal-status={goal?.status ?? "empty"}
    >
      <div
        className="chat-goal-inline"
        role="region"
        aria-labelledby={headingId}
        aria-busy={busy || submitting}
      >
          <header>
            <span>
              <Flag size={15} aria-hidden="true" />
              <span>
                <strong id={headingId}>{label}</strong>
                <small>{workflow?.goalCapability.label ?? "Workflow unavailable"}</small>
              </span>
            </span>
            <IconButton
              label="Close goal controls"
              onClick={() => onDismiss("action")}
            >
              <X size={14} />
            </IconButton>
          </header>

          {!workflow ? (
            <div className="chat-goal-unavailable">
              <p role={error ? "alert" : "status"}>
                {error ?? (loading
                  ? "Loading the goal for this chat…"
                  : "The goal for this chat is not available.")}
              </p>
              <button
                ref={firstActionRef}
                type="button"
                disabled={loading || busy}
                onClick={() => void onRetry().catch(() => undefined)}
              >
                <RefreshCw size={13} aria-hidden="true" />
                Retry
              </button>
            </div>
          ) : goal ? (
            <>
              <section className="chat-goal-current" aria-label="Current goal">
                <span>{stateLabel}</span>
                <p>{goal.objective}</p>
                <small>
                  {source === "codex-native"
                    ? "Owned by and shared with this Codex thread."
                    : "Saved in Inertia only; it is not shared with the provider."}
                </small>
              </section>
              <footer className="chat-goal-actions">
                {nextActions(goal.status).map((action, index) => (
                  <button
                    ref={index === 0 ? firstActionRef : undefined}
                    key={action.status}
                    type="button"
                    disabled={busy || submitting}
                    onClick={() => void updateStatus(action.status)}
                  >
                    {action.icon}
                    {action.label}
                  </button>
                ))}
                <button
                  type="button"
                  className="is-danger"
                  aria-label={source === "codex-native"
                    ? "Clear Codex goal"
                    : "Clear local objective"}
                  disabled={busy || submitting}
                  onClick={() => void clearGoal()}
                >
                  <Trash2 size={13} aria-hidden="true" />
                  Clear
                </button>
              </footer>
            </>
          ) : (
            <form
              className="chat-goal-form"
              aria-label={source === "codex-native"
                ? "Create Codex goal"
                : "Create local objective"}
              onSubmit={(event) => {
                event.preventDefault();
                void createGoal();
              }}
            >
              <label htmlFor={inputId}>Objective</label>
              <textarea
                ref={inputRef}
                id={inputId}
                value={objective}
                maxLength={4_000}
                rows={3}
                placeholder="Define the outcome for this chat…"
                disabled={busy || submitting}
                onChange={(event) => setObjective(event.currentTarget.value)}
              />
              <div className="chat-goal-notes">
                <small>
                  {source === "codex-native"
                    ? "This becomes the native goal for this Codex thread."
                    : "This stays in Inertia and is never injected into provider context."}
                </small>
                {workflow.goalCapability.kind === "inertia-local" && (
                  <p>{workflow.goalCapability.reason}</p>
                )}
              </div>
              <button
                type="submit"
                disabled={busy || submitting || objective.trim().length === 0}
              >
                <Flag size={13} aria-hidden="true" />
                {source === "codex-native" ? "Set Codex goal" : "Save local objective"}
              </button>
            </form>
          )}

          {workflow?.goalRefreshWarning && (
            <p className="chat-goal-warning" role="status">
              {workflow.goalRefreshWarning}
            </p>
          )}

          {workflow && separateGoalCount > 0 && (
            <p className="chat-goal-separate-note">
              {separateGoalCount === 1 ? "One separately tracked goal" : `${separateGoalCount} separately tracked goals`} remains visible in the Goal workspace tool; it is not treated as this route&apos;s current {label.toLocaleLowerCase()}.
            </p>
          )}
      </div>
    </div>
  );
}
