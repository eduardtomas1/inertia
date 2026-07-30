import { useId, useMemo, useState } from "react";
import clsx from "clsx";
import {
  Check,
  CirclePause,
  Flag,
  Network,
  Play,
  RefreshCw,
  Sparkles,
  Square,
  Trash2,
} from "lucide-react";

import type {
  AgentGoal,
  AgentGoalSource,
  AgentGoalStatus,
  AgentPlan,
  AgentSkillSummary,
  AgentTurn,
  AgentWorkflowState,
  SubagentTrace,
} from "@shared/contracts";
import {
  isLiveSubagentTrace,
  subagentElapsedMs,
  subagentDisclosureRows,
  subagentProviderLabel,
  subagentStatusLabel,
  subagentTraceDetail,
  subagentTraceLabel,
} from "../utils/subagentDisclosure";
import { formatElapsed } from "../utils/responseTimeline";
import { MAX_SELECTED_SKILLS } from "./composer/config";

export interface GoalPanelGoalInput {
  source: AgentGoalSource;
  objective?: string;
  status: AgentGoalStatus;
  tokenBudget?: number | null;
}

export interface GoalPanelProps {
  workflow: AgentWorkflowState | null;
  plan: AgentPlan | null;
  subagents: readonly SubagentTrace[];
  turns: readonly AgentTurn[];
  selectedSkillIds?: readonly string[];
  now?: number;
  busy?: boolean;
  error?: string | null;
  onRetry?: () => Promise<void>;
  onSetGoal?: (input: GoalPanelGoalInput) => Promise<void>;
  onClearGoal?: (goal: AgentGoal) => void;
  onToggleSkill?: (skill: AgentSkillSummary, selected: boolean) => void;
  onRefreshSkills?: () => void;
  canFollowUpSubagent?: (trace: SubagentTrace) => boolean;
  onFollowUpSubagent?: (trace: SubagentTrace) => void;
  canStopSubagent?: (trace: SubagentTrace) => boolean;
  onStopSubagent?: (trace: SubagentTrace) => void;
}

function goalStatusLabel(status: AgentGoalStatus): string {
  if (status === "usageLimited") return "Usage limited";
  if (status === "budgetLimited") return "Budget limited";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function sourceLabel(source: AgentGoalSource): string {
  return source === "codex-native" ? "Codex native" : "Inertia local";
}

function goalProgress(goal: AgentGoal): number | null {
  if (
    goal.tokenBudget === null
    || goal.tokensUsed === null
    || goal.tokenBudget <= 0
  ) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.round(
    (goal.tokensUsed / goal.tokenBudget) * 100,
  )));
}

function nextGoalActions(status: AgentGoalStatus): Array<{
  label: string;
  status: AgentGoalStatus;
  icon: React.JSX.Element;
}> {
  if (status === "active") {
    return [
      {
        label: "Pause",
        status: "paused",
        icon: <CirclePause size={12} aria-hidden="true" />,
      },
      {
        label: "Block",
        status: "blocked",
        icon: <Square size={10} aria-hidden="true" />,
      },
      {
        label: "Complete",
        status: "complete",
        icon: <Check size={12} aria-hidden="true" />,
      },
    ];
  }
  return [{
    label: status === "complete" ? "Reopen goal" : "Mark active",
    status: "active",
    icon: <Play size={11} aria-hidden="true" />,
  }];
}

function GoalCard({
  goal,
  editable,
  busy,
  onSetGoal,
  onClearGoal,
}: {
  goal: AgentGoal;
  editable: boolean;
  busy: boolean;
  onSetGoal?: GoalPanelProps["onSetGoal"];
  onClearGoal?: GoalPanelProps["onClearGoal"];
}): React.JSX.Element {
  const progress = goalProgress(goal);
  return (
    <article
      className={clsx(
        "goal-panel-card",
        `is-${goal.status}`,
        goal.source === "codex-native" ? "is-native" : "is-local",
      )}
    >
      <header>
        <span className="goal-panel-source">{sourceLabel(goal.source)}</span>
        <span className="goal-panel-status">{goalStatusLabel(goal.status)}</span>
      </header>
      <p className="goal-panel-objective">{goal.objective}</p>

      {(progress !== null || goal.timeUsedSeconds !== null) && (
        <div className="goal-panel-metrics">
          {progress !== null && (
            <div
              className="goal-panel-progress"
              role="progressbar"
              aria-label="Goal token budget used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
            >
              <span style={{ width: `${progress}%` }} />
            </div>
          )}
          <span>
            {progress !== null && `${progress}% of token budget`}
            {progress !== null && goal.timeUsedSeconds !== null && " · "}
            {goal.timeUsedSeconds !== null
              && `${formatElapsed(goal.timeUsedSeconds * 1_000)} used`}
          </span>
        </div>
      )}

      {editable && (onSetGoal || onClearGoal) && (
        <footer className="goal-panel-card-actions">
          {onSetGoal && nextGoalActions(goal.status).map((action) => (
            <button
              key={action.status}
              type="button"
              className="goal-panel-text-button"
              disabled={busy}
              onClick={() => {
                void onSetGoal({
                  source: goal.source,
                  status: action.status,
                }).catch(() => undefined);
              }}
            >
              {action.icon}
              {action.label}
            </button>
          ))}
          {onClearGoal && (
            <button
              type="button"
              className="goal-panel-icon-button"
              aria-label={`Clear ${sourceLabel(goal.source).toLowerCase()} goal`}
              disabled={busy}
              onClick={() => onClearGoal(goal)}
            >
              <Trash2 size={12} aria-hidden="true" />
            </button>
          )}
        </footer>
      )}
    </article>
  );
}

function GoalComposer({
  source,
  sourceName,
  busy,
  onSetGoal,
}: {
  source: AgentGoalSource;
  sourceName: string;
  busy: boolean;
  onSetGoal: NonNullable<GoalPanelProps["onSetGoal"]>;
}): React.JSX.Element {
  const objectiveId = useId();
  const [objective, setObjective] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submit = async (): Promise<void> => {
    const next = objective.trim();
    if (!next || submitting) return;
    setSubmitting(true);
    try {
      await onSetGoal({
        source,
        objective: next,
        status: "active",
        tokenBudget: null,
      });
      setObjective("");
    } catch {
      // The scene owns the public error surface. Preserve the draft for retry.
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <form
      className="goal-panel-composer"
      aria-label={`Create ${sourceName.toLowerCase()}`}
      aria-busy={submitting}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={objectiveId}>Objective</label>
      <div>
        <input
          id={objectiveId}
          value={objective}
          maxLength={4_000}
          placeholder="Define the current objective…"
          disabled={busy || submitting}
          onChange={(event) => setObjective(event.currentTarget.value)}
        />
        <button
          type="submit"
          className="goal-panel-icon-button"
          aria-label={`Create ${sourceName.toLowerCase()}`}
          disabled={busy || submitting || objective.trim().length === 0}
        >
          <Flag size={13} aria-hidden="true" />
        </button>
      </div>
      <small>
        {source === "codex-native"
          ? "Shared with this Codex thread."
          : "Tracked by Inertia only; it is not injected into the provider."}
      </small>
    </form>
  );
}

function PlanRelationship({
  plan,
}: {
  plan: AgentPlan | null;
}): React.JSX.Element {
  if (!plan) {
    return (
      <div className="goal-panel-empty-row">
        <span>No conversation plan has been reported.</span>
      </div>
    );
  }
  const completed = plan.steps.filter(({ status }) => status === "completed").length;
  const active = plan.steps.find(({ status }) => status === "inProgress");
  return (
    <div className="goal-panel-plan">
      <div>
        <strong>{completed} of {plan.steps.length} plan steps complete</strong>
        <span>{active?.step ?? plan.explanation ?? "No active plan step"}</span>
        <small>
          Latest conversation plan · not linked to this goal
        </small>
      </div>
      <span aria-label={`${completed} of ${plan.steps.length} plan steps complete`}>
        {completed}/{plan.steps.length}
      </span>
    </div>
  );
}

function SkillsSection({
  workflow,
  selectedSkillIds,
  onToggleSkill,
  onRefreshSkills,
  headingId,
}: {
  workflow: AgentWorkflowState;
  selectedSkillIds: readonly string[];
  onToggleSkill?: GoalPanelProps["onToggleSkill"];
  onRefreshSkills?: GoalPanelProps["onRefreshSkills"];
  headingId: string;
}): React.JSX.Element {
  const selected = useMemo(() => new Set(selectedSkillIds), [selectedSkillIds]);
  const limitReached = selected.size >= MAX_SELECTED_SKILLS;
  return (
    <section className="goal-panel-section" aria-labelledby={headingId}>
      <header className="goal-panel-section-heading">
        <div>
          <Sparkles size={14} aria-hidden="true" />
          <h3 id={headingId}>Skills</h3>
        </div>
        {workflow.skillsCapability.available && onRefreshSkills && (
          <button
            type="button"
            className="goal-panel-icon-button"
            aria-label="Refresh skills"
            onClick={onRefreshSkills}
          >
            <RefreshCw size={12} aria-hidden="true" />
          </button>
        )}
      </header>

      {!workflow.skillsCapability.available ? (
        <p className="goal-panel-capability-note">
          <strong>{workflow.skillsCapability.label}.</strong>{" "}
          {workflow.skillsCapability.reason}
        </p>
      ) : workflow.skills.length === 0 ? (
        <div className="goal-panel-empty-row">
          <span>
            No enabled skills were reported by this provider for this project.
          </span>
        </div>
      ) : (
        <ul className="goal-panel-skills">
          {workflow.skills.map((skill) => {
            const isSelected = selected.has(skill.id);
            const disabledByLimit = limitReached && !isSelected;
            return (
              <li key={skill.id}>
                <button
                  type="button"
                  aria-pressed={isSelected}
                  disabled={!skill.enabled || !onToggleSkill || disabledByLimit}
                  title={disabledByLimit
                    ? `Select at most ${MAX_SELECTED_SKILLS} skills for one turn.`
                    : skill.description}
                  onClick={() => onToggleSkill?.(skill, !isSelected)}
                >
                  <span className="goal-panel-skill-copy">
                    <strong>{skill.name}</strong>
                    <small>{skill.shortDescription ?? skill.description}</small>
                  </span>
                  <span className="goal-panel-skill-meta">
                    {skill.scope}
                    {isSelected && <Check size={11} aria-label="Selected" />}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {limitReached && (
        <p className="goal-panel-capability-note" role="status">
          Maximum {MAX_SELECTED_SKILLS} skills selected for one turn. Clear or
          deselect a skill before adding another.
        </p>
      )}
      {workflow.skillDiscovery.truncated && (
        <p className="goal-panel-capability-note" role="status">
          Showing the first 128 provider-reported skills.
        </p>
      )}
      {workflow.skillDiscovery.warningCount > 0 && (
        <p className="goal-panel-capability-note" role="status">
          Skill discovery reported {workflow.skillDiscovery.warningCount}{" "}
          {workflow.skillDiscovery.warningCount === 1
            ? "discovery warning"
            : "discovery warnings"}.
        </p>
      )}
    </section>
  );
}

function SubagentsSection({
  subagents,
  turns,
  now,
  canFollowUpSubagent,
  onFollowUpSubagent,
  canStopSubagent,
  onStopSubagent,
  headingId,
  listId,
}: Pick<
  GoalPanelProps,
  | "subagents"
  | "turns"
  | "canFollowUpSubagent"
  | "onFollowUpSubagent"
  | "canStopSubagent"
  | "onStopSubagent"
> & {
  now: number;
  headingId: string;
  listId: string;
}): React.JSX.Element {
  const rows = subagentDisclosureRows(subagents, turns);
  const [showAll, setShowAll] = useState(false);
  const compactRows = useMemo(() => compactSubagentRows(rows), [rows]);
  const visibleRows = showAll
    ? rows.map((row) => ({ ...row, omittedAncestors: 0 }))
    : compactRows;
  const hiddenCount = rows.length - compactRows.length;
  return (
    <section className="goal-panel-section" aria-labelledby={headingId}>
      <header className="goal-panel-section-heading">
        <div>
          <Network size={14} aria-hidden="true" />
          <h3 id={headingId}>Delegated work</h3>
        </div>
        <span>{subagents.length}</span>
      </header>
      {rows.length === 0 ? (
        <div className="goal-panel-empty-row">
          <span>No provider-reported subagents in this conversation.</span>
        </div>
      ) : (
        <ol
          id={listId}
          className="goal-panel-subagents"
          aria-label="Delegated agent tree"
        >
          {visibleRows.map(({
            trace,
            depth,
            canStop,
            omittedAncestors,
          }) => {
            const detail = subagentTraceDetail(trace);
            const duration = subagentElapsedMs(trace, now);
            const mayFollowUp = Boolean(
              onFollowUpSubagent && canFollowUpSubagent?.(trace),
            );
            const mayStop = Boolean(
              onStopSubagent
              && canStop
              && (canStopSubagent?.(trace) ?? true),
            );
            const followUp = onFollowUpSubagent;
            const stop = onStopSubagent;
            return (
              <li
                key={trace.id}
                data-status={trace.status}
                style={{ "--goal-subagent-depth": depth } as React.CSSProperties}
              >
                <span className="goal-panel-subagent-dot" aria-hidden="true" />
                <span className="goal-panel-subagent-copy">
                  <span>
                    <strong>{subagentTraceLabel(trace)}</strong>
                    <small
                      title={trace.providerStatus
                        ? `Exact provider state: ${trace.providerStatus}`
                        : undefined}
                    >
                      {subagentProviderLabel(trace)} ·{" "}
                      {subagentStatusLabel(trace)} · {formatElapsed(duration)}
                    </small>
                  </span>
                  {omittedAncestors > 0 && (
                    <small>
                      {omittedAncestors} earlier{" "}
                      {omittedAncestors === 1 ? "ancestor" : "ancestors"}{" "}
                      compacted
                    </small>
                  )}
                  {detail && <small title={detail}>{detail}</small>}
                </span>
                {(mayFollowUp || mayStop) && (
                  <span className="goal-panel-subagent-actions">
                    {mayFollowUp && (
                      <button
                        type="button"
                        aria-label={`Guide parent about ${subagentTraceLabel(trace)}`}
                        onClick={() => followUp?.(trace)}
                      >
                        Guide parent
                      </button>
                    )}
                    {mayStop && (
                      <button
                        type="button"
                        aria-label={`Stop ${subagentTraceLabel(trace)}`}
                        onClick={() => stop?.(trace)}
                      >
                        <Square size={9} fill="currentColor" aria-hidden="true" />
                        Stop
                      </button>
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {hiddenCount > 0 && (
        <button
          type="button"
          className="goal-panel-history-toggle"
          aria-controls={listId}
          aria-expanded={showAll}
          onClick={() => setShowAll((current) => !current)}
        >
          {showAll
            ? "Show recent delegated work"
            : `Show ${hiddenCount} earlier delegated ${
                hiddenCount === 1 ? "task" : "tasks"
              }`}
        </button>
      )}
    </section>
  );
}

const MAX_COMPACT_SUBAGENTS = 6;
const RECENT_COMPACT_SUBAGENTS = 6;

type SubagentDisclosureRow = ReturnType<
  typeof subagentDisclosureRows
>[number];

interface CompactSubagentDisclosureRow extends SubagentDisclosureRow {
  omittedAncestors: number;
}

function compactSubagentRows(
  rows: readonly SubagentDisclosureRow[],
): CompactSubagentDisclosureRow[] {
  if (rows.length <= MAX_COMPACT_SUBAGENTS) {
    return rows.map((row) => ({ ...row, omittedAncestors: 0 }));
  }
  const byId = new Map(rows.map((row) => [row.trace.id, row]));
  const included = new Set<string>();
  const parentRow = (
    row: SubagentDisclosureRow,
  ): SubagentDisclosureRow | undefined => row.trace.parentTraceId
    ? byId.get(row.trace.parentTraceId)
    : undefined;

  const includeWithAncestors = (candidate: SubagentDisclosureRow): void => {
    const chain: SubagentDisclosureRow[] = [];
    const seen = new Set<string>();
    let current: SubagentDisclosureRow | undefined = candidate;
    while (current && !seen.has(current.trace.id)) {
      seen.add(current.trace.id);
      chain.unshift(current);
      current = parentRow(current);
    }
    const missing = chain.filter(({ trace }) => !included.has(trace.id));
    if (included.size + missing.length > MAX_COMPACT_SUBAGENTS) return;
    for (const { trace } of missing) included.add(trace.id);
  };

  const newestFirst = rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) =>
      right.row.trace.sequence - left.row.trace.sequence
      || right.index - left.index)
    .map(({ row }) => row);
  const important = newestFirst.filter(({ trace }) =>
    isLiveSubagentTrace(trace)
    || trace.status === "failed"
    || trace.status === "lost");
  const importantIds = new Set(important.map(({ trace }) => trace.id));
  const importantParents = new Set(important.flatMap(({ trace }) =>
    trace.parentTraceId && importantIds.has(trace.parentTraceId)
      ? [trace.parentTraceId]
      : []));
  const criticalLeaves = important.filter(({ trace }) =>
    !importantParents.has(trace.id));
  const reserved = (criticalLeaves.length > 0 ? criticalLeaves : important)
    .slice(0, MAX_COMPACT_SUBAGENTS);

  // Reserve the newest critical branch endpoints before adding context. This
  // prevents one deep live branch from hiding every competing live branch.
  for (const { trace } of reserved) included.add(trace.id);
  const frontiers = reserved.map((row) => parentRow(row));
  const frontierSeen = reserved.map(() => new Set<string>());
  while (included.size < MAX_COMPACT_SUBAGENTS) {
    let advanced = false;
    for (let index = 0; index < frontiers.length; index += 1) {
      let frontier = frontiers[index];
      while (frontier && included.has(frontier.trace.id)) {
        if (frontierSeen[index]?.has(frontier.trace.id)) {
          frontier = undefined;
          break;
        }
        frontierSeen[index]?.add(frontier.trace.id);
        frontier = parentRow(frontier);
      }
      if (frontier && frontierSeen[index]?.has(frontier.trace.id)) {
        frontier = undefined;
      }
      if (frontier) frontierSeen[index]?.add(frontier.trace.id);
      frontiers[index] = frontier ? parentRow(frontier) : undefined;
      if (!frontier) continue;
      included.add(frontier.trace.id);
      advanced = true;
      if (included.size >= MAX_COMPACT_SUBAGENTS) break;
    }
    if (!advanced) break;
  }

  for (const row of newestFirst.slice(0, RECENT_COMPACT_SUBAGENTS)) {
    includeWithAncestors(row);
  }
  for (const row of newestFirst) includeWithAncestors(row);

  const omittedAncestorCount = (row: SubagentDisclosureRow): number => {
    let count = 0;
    let current = parentRow(row);
    const seen = new Set<string>();
    while (
      current
      && !included.has(current.trace.id)
      && !seen.has(current.trace.id)
    ) {
      seen.add(current.trace.id);
      count += 1;
      current = parentRow(current);
    }
    return count;
  };
  return rows
    .filter(({ trace }) => included.has(trace.id))
    .map((row) => ({
      ...row,
      omittedAncestors: omittedAncestorCount(row),
    }));
}

export function GoalPanel({
  workflow,
  plan,
  subagents,
  turns,
  selectedSkillIds = [],
  now = Date.now(),
  busy = false,
  error = null,
  onRetry,
  onSetGoal,
  onClearGoal,
  onToggleSkill,
  onRefreshSkills,
  canFollowUpSubagent,
  onFollowUpSubagent,
  canStopSubagent,
  onStopSubagent,
}: GoalPanelProps): React.JSX.Element {
  const panelId = useId();
  const currentHeadingId = `${panelId}-current`;
  const localHeadingId = `${panelId}-local-tracking`;
  const planHeadingId = `${panelId}-plan`;
  const skillsHeadingId = `${panelId}-skills`;
  const subagentsHeadingId = `${panelId}-subagents`;
  const subagentsListId = `${panelId}-subagent-list`;
  const capabilitySource = workflow?.goalCapability.kind ?? null;
  const primaryGoals = workflow?.goals.filter(
    ({ source }) => source === capabilitySource,
  ) ?? [];
  const localTrackingGoals = workflow?.goals.filter(
    ({ source }) => source !== capabilitySource,
  ) ?? [];
  const hasEditableGoal = workflow?.goals.some(
    ({ source }) => source === capabilitySource,
  ) ?? false;
  return (
    <section
      className="goal-panel"
      aria-label="Goals and agent workflows"
      data-goal-source={capabilitySource ?? "unavailable"}
    >
      <header className="panel-toolbar goal-panel-toolbar">
        <div className="panel-heading">
          <Flag size={17} aria-hidden="true" />
          <div className="panel-heading-copy">
            <h2>Goal</h2>
            <span>{workflow?.goalCapability.label ?? "Workflow unavailable"}</span>
          </div>
        </div>
        {busy && <span className="goal-panel-sync" role="status">Syncing…</span>}
      </header>

      <div className="goal-panel-scroll">
        {error && (
          <div className="goal-panel-error" role="alert">
            <span>{error}</span>
            {onRetry && (
              <button
                type="button"
                className="goal-panel-text-button"
                disabled={busy}
                onClick={() => void onRetry().catch(() => undefined)}
              >
                Retry
              </button>
            )}
          </div>
        )}
        {workflow?.goalRefreshWarning && (
          <p className="goal-panel-capability-note" role="status">
            {workflow.goalRefreshWarning}
          </p>
        )}
        <section className="goal-panel-section" aria-labelledby={currentHeadingId}>
          <header className="goal-panel-section-heading">
            <div>
              <Flag size={14} aria-hidden="true" />
              <h3 id={currentHeadingId}>Current objective</h3>
            </div>
          </header>

          {!workflow ? (
            <div className="goal-panel-empty-row">
              <span>
                {error
                  ? "Agent workflow could not be loaded."
                  : busy
                    ? "Loading agent workflow…"
                    : "Open a conversation to inspect its goal."}
              </span>
            </div>
          ) : (
            <>
              {primaryGoals.length === 0 ? (
                <div className="goal-panel-empty-row">
                  <span>No current goal. Inertia does not infer one from chat text.</span>
                </div>
              ) : primaryGoals.map((goal) => (
                <GoalCard
                  key={goal.source}
                  goal={goal}
                  editable={goal.source === capabilitySource}
                  busy={busy}
                  onSetGoal={onSetGoal}
                  onClearGoal={onClearGoal}
                />
              ))}
              {!hasEditableGoal && onSetGoal && (
                <GoalComposer
                  source={workflow.goalCapability.kind}
                  sourceName={workflow.goalCapability.label}
                  busy={busy}
                  onSetGoal={onSetGoal}
                />
              )}
            </>
          )}
        </section>

        {localTrackingGoals.length > 0 && (
          <section
            className="goal-panel-section"
            aria-labelledby={localHeadingId}
          >
            <header className="goal-panel-section-heading">
              <div>
                <Flag size={14} aria-hidden="true" />
                <h3 id={localHeadingId}>Local tracking</h3>
              </div>
            </header>
            <p className="goal-panel-capability-note">
              These notes remain in Inertia and are not shared with the
              current provider thread.
            </p>
            {localTrackingGoals.map((goal) => (
              <GoalCard
                key={goal.source}
                goal={goal}
                editable
                busy={busy}
                onSetGoal={onSetGoal}
                onClearGoal={onClearGoal}
              />
            ))}
          </section>
        )}

        <section className="goal-panel-section" aria-labelledby={planHeadingId}>
          <header className="goal-panel-section-heading">
            <div>
              <Check size={14} aria-hidden="true" />
              <h3 id={planHeadingId}>Latest conversation plan</h3>
            </div>
          </header>
          <PlanRelationship plan={plan} />
        </section>

        {workflow && (
          <SkillsSection
            workflow={workflow}
            selectedSkillIds={selectedSkillIds}
            onToggleSkill={onToggleSkill}
            onRefreshSkills={onRefreshSkills}
            headingId={skillsHeadingId}
          />
        )}

        <SubagentsSection
          key={workflow?.conversationId
            ?? subagents[0]?.conversationId
            ?? turns[0]?.conversationId
            ?? "empty"}
          subagents={subagents}
          turns={turns}
          now={now}
          canFollowUpSubagent={canFollowUpSubagent}
          onFollowUpSubagent={onFollowUpSubagent}
          canStopSubagent={canStopSubagent}
          onStopSubagent={onStopSubagent}
          headingId={subagentsHeadingId}
          listId={subagentsListId}
        />
      </div>
    </section>
  );
}
