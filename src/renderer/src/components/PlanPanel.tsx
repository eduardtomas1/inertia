import clsx from "clsx";
import { AlertCircle, Check, Circle, CircleDot, ListChecks, Play, RotateCcw } from "lucide-react";

export type PlanStepStatus = "pending" | "in-progress" | "completed" | "blocked";

export type PlanStep = {
  id: string;
  title: string;
  detail?: string | null;
  status: PlanStepStatus;
};

export type PlanPanelProps = {
  steps: PlanStep[];
  title?: string;
  summary?: string | null;
  activeStepId?: string | null;
  onSelectStep?: (stepId: string) => void;
  onRefine?: () => void;
  onImplement?: () => void;
};

function StepIcon({ status }: { status: PlanStepStatus }): React.JSX.Element {
  if (status === "completed") return <Check size={14} aria-hidden="true" />;
  if (status === "in-progress") return <CircleDot size={15} aria-hidden="true" />;
  if (status === "blocked") return <AlertCircle size={15} aria-hidden="true" />;
  return <Circle size={14} aria-hidden="true" />;
}

function statusLabel(status: PlanStepStatus): string {
  if (status === "in-progress") return "In progress";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function PlanPanel({
  steps,
  title = "Implementation plan",
  summary,
  activeStepId = null,
  onSelectStep,
  onRefine,
  onImplement,
}: PlanPanelProps): React.JSX.Element {
  const completed = steps.filter((step) => step.status === "completed").length;
  const progress = steps.length > 0 ? Math.round((completed / steps.length) * 100) : 0;

  return (
    <section className="plan-panel" aria-label="Implementation plan">
      <header className="panel-toolbar plan-toolbar">
        <div className="panel-heading">
          <ListChecks size={17} aria-hidden="true" />
          <div className="panel-heading-copy">
            <h2>{title}</h2>
            <span>{completed} of {steps.length} complete</span>
          </div>
        </div>
        <span className="plan-percent" aria-label={`${progress}% complete`}>{progress}%</span>
      </header>

      <div className="plan-progress" role="progressbar" aria-label="Plan progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
        <span style={{ width: `${progress}%` }} />
      </div>

      {summary && <p className="plan-summary">{summary}</p>}

      {steps.length === 0 ? (
        <div className="panel-empty plan-empty">
          <ListChecks size={22} aria-hidden="true" />
          <h3>No plan yet</h3>
          <p>Switch the agent to Plan mode to build a step-by-step approach.</p>
        </div>
      ) : (
        <ol className="plan-steps">
          {steps.map((step, index) => {
            const content = (
              <>
                <span className={clsx("plan-step-marker", `is-${step.status}`)}>
                  <StepIcon status={step.status} />
                </span>
                <span className="plan-step-copy">
                  <span className="plan-step-title"><span className="plan-step-number">{index + 1}.</span> {step.title}</span>
                  {step.detail && <span className="plan-step-detail">{step.detail}</span>}
                </span>
                <span className="plan-step-status">{statusLabel(step.status)}</span>
              </>
            );
            return (
              <li className={clsx("plan-step", `is-${step.status}`, activeStepId === step.id && "is-active")} key={step.id}>
                {onSelectStep ? (
                  <button
                    type="button"
                    className="plan-step-button"
                    aria-current={activeStepId === step.id ? "step" : undefined}
                    onClick={() => onSelectStep(step.id)}
                  >
                    {content}
                  </button>
                ) : (
                  <div className="plan-step-content" aria-current={activeStepId === step.id ? "step" : undefined}>{content}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {(onRefine || onImplement) && (
        <footer className="plan-actions">
          {onRefine && (
            <button type="button" className="secondary-button" onClick={onRefine}>
              <RotateCcw size={15} aria-hidden="true" />
              <span>Refine plan</span>
            </button>
          )}
          {onImplement && (
            <button type="button" className="primary-button" onClick={onImplement} disabled={steps.length === 0}>
              <Play size={15} aria-hidden="true" />
              <span>Implement</span>
            </button>
          )}
        </footer>
      )}
    </section>
  );
}
