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
import {
  MAX_GOAL_TOKEN_BUDGET,
  parseGoalTokenBudget,
} from "../utils/goalBudget";
import type { GoalExecutionStatus } from "../utils/goalExecution";

interface GoalInput {
  source: AgentGoalSource;
  objective?: string;
  status: AgentGoalStatus;
  tokenBudget?: number | null;
}

export interface ChatGoalControlProps {
  workflow: AgentWorkflowState | null;
  executionStatus?: GoalExecutionStatus;
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

function nextActions(
  goal: AgentGoal,
  executionStatus: GoalExecutionStatus,
): Array<{
  label: string;
  status: AgentGoalStatus;
  icon: React.JSX.Element;
}> {
  if (goal.status === "budgetLimited") return [];
  if (
    goal.status === "active"
    && goal.source === "codex-native"
    && executionStatus === "idle"
  ) {
    return [{
      label: "Resume goal",
      status: "active",
      icon: <Play size={12} aria-hidden="true" />,
    }];
  }
  if (goal.status === "active") {
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
    label: goal.status === "complete" ? "Reopen goal" : "Mark active",
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
  executionStatus = "idle",
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
  const budgetId = useId();
  const headingId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const firstActionRef = useRef<HTMLButtonElement>(null);
  const [objective, setObjective] = useState("");
  const [tokenBudget, setTokenBudget] = useState("");
  const [recoveryBudget, setRecoveryBudget] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const source = workflow?.goalCapability.kind ?? null;
  const goal = workflow ? currentRouteGoal(workflow) : null;
  const recoveryBudgetFloor = goal?.tokensUsed ?? goal?.tokenBudget ?? 0;
  const parsedRecoveryBudget = parseGoalTokenBudget(recoveryBudget);
  const validRecoveryBudget = typeof parsedRecoveryBudget === "number"
    && parsedRecoveryBudget > recoveryBudgetFloor;
  const separateGoalCount = workflow?.goals.filter(({ source: goalSource }) =>
    goalSource !== source).length ?? 0;
  const label = source ? routeLabel(source) : "Goal";
  const stateLabel = goal ? statusLabel(goal.status) : null;
  const controlsBusy = busy || executionStatus === "starting";
  const ownerKey = `${workflow?.conversationId ?? ""}:${source ?? ""}`;
  const ownerKeyRef = useRef(ownerKey);

  useEffect(() => {
    if (ownerKeyRef.current === ownerKey) return;
    ownerKeyRef.current = ownerKey;
    setObjective("");
    setTokenBudget("");
    setRecoveryBudget("");
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
    const nextTokenBudget = parseGoalTokenBudget(tokenBudget);
    if (
      !source
      || !nextObjective
      || nextTokenBudget === undefined
      || submitting
    ) return;
    setSubmitting(true);
    try {
      await onSetGoal({
        source,
        objective: nextObjective,
        status: "active",
        tokenBudget: nextTokenBudget,
      });
      setObjective("");
      setTokenBudget("");
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

  const resumeBudgetLimitedGoal = async (
    nextTokenBudget: number | null,
  ): Promise<void> => {
    if (!source || submitting) return;
    setSubmitting(true);
    try {
      await onSetGoal({
        source,
        status: "active",
        tokenBudget: nextTokenBudget,
      });
      setRecoveryBudget("");
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
      data-goal-execution={executionStatus}
    >
      <div
        className="chat-goal-inline"
        role="region"
        aria-labelledby={headingId}
        aria-busy={controlsBusy || submitting}
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
                disabled={loading || controlsBusy}
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
                    : goal.tokenBudget === null
                      ? "Saved in Inertia only; it is not shared with the provider."
                      : `Local token target: ${goal.tokenBudget.toLocaleString()}. Inertia does not measure or enforce provider usage.`}
                </small>
                {goal.source === "codex-native"
                  && goal.status === "active"
                  && executionStatus === "idle" && (
                    <small role="status">
                      This goal is still active in Codex, but no Inertia run is
                      connected. Resume it to continue.
                    </small>
                  )}
              </section>
              {goal.status === "budgetLimited" && (
                <section
                  className="chat-goal-budget-recovery"
                  aria-label="Resume budget-limited goal"
                >
                  <p>
                    This budget is exhausted. Raise or remove it before
                    resuming the goal.
                  </p>
                  <div className="chat-goal-budget">
                    <label htmlFor={budgetId}>New token budget</label>
                    <input
                      id={budgetId}
                      type="number"
                      inputMode="numeric"
                      min={recoveryBudgetFloor + 1}
                      max={MAX_GOAL_TOKEN_BUDGET}
                      step={1}
                      value={recoveryBudget}
                      placeholder={recoveryBudgetFloor === 0
                        ? "Higher limit"
                        : `More than ${recoveryBudgetFloor.toLocaleString()}`}
                      disabled={controlsBusy || submitting}
                      aria-invalid={parsedRecoveryBudget === undefined
                        || (typeof parsedRecoveryBudget === "number"
                          && !validRecoveryBudget)}
                      onChange={(event) =>
                        setRecoveryBudget(event.currentTarget.value)}
                    />
                  </div>
                  <div className="chat-goal-actions">
                    <button
                      type="button"
                      disabled={controlsBusy
                        || submitting
                        || !validRecoveryBudget}
                      onClick={() => {
                        if (typeof parsedRecoveryBudget === "number") {
                          void resumeBudgetLimitedGoal(parsedRecoveryBudget);
                        }
                      }}
                    >
                      <Play size={12} aria-hidden="true" />
                      Resume with new budget
                    </button>
                    <button
                      ref={firstActionRef}
                      type="button"
                      disabled={controlsBusy || submitting}
                      onClick={() => void resumeBudgetLimitedGoal(null)}
                    >
                      <Play size={12} aria-hidden="true" />
                      Resume without budget
                    </button>
                  </div>
                </section>
              )}
              <footer className="chat-goal-actions">
                {nextActions(goal, executionStatus).map((action, index) => (
                  <button
                    ref={index === 0 ? firstActionRef : undefined}
                    key={action.status}
                    type="button"
                    disabled={controlsBusy || submitting}
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
                  disabled={controlsBusy || submitting}
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
                disabled={controlsBusy || submitting}
                onChange={(event) => setObjective(event.currentTarget.value)}
              />
              <div className="chat-goal-budget">
                <label htmlFor={budgetId}>
                  {source === "codex-native"
                    ? "Token budget (optional)"
                    : "Token target (optional)"}
                </label>
                <input
                  id={budgetId}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MAX_GOAL_TOKEN_BUDGET}
                  step={1}
                  value={tokenBudget}
                  placeholder="No limit"
                  disabled={controlsBusy || submitting}
                  aria-invalid={parseGoalTokenBudget(tokenBudget) === undefined}
                  onChange={(event) =>
                    setTokenBudget(event.currentTarget.value)}
                />
              </div>
              <div className="chat-goal-notes">
                <small>
                  {source === "codex-native"
                    ? "This becomes the native goal for this Codex thread."
                    : "This stays in Inertia and is never injected into provider context. Inertia does not measure or enforce the local token target."}
                </small>
                {workflow.goalCapability.kind === "inertia-local" && (
                  <p>{workflow.goalCapability.reason}</p>
                )}
              </div>
              <button
                type="submit"
                disabled={
                  controlsBusy
                  || submitting
                  || objective.trim().length === 0
                  || parseGoalTokenBudget(tokenBudget) === undefined
                }
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
