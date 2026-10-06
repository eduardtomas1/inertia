import clsx from "clsx";
import { useId, useState, type ComponentProps } from "react";
import { AlertCircle, Check, ChevronDown, Circle, CircleSlash, Copy, ListChecks, LoaderCircle, Play, RotateCcw } from "lucide-react";

import { useCopiedState } from "../hooks/useCopiedState";
import { planDocument, planDocumentIsLong, planInlineSegments } from "../utils/planDocument";
import { ResponseMarkdown } from "./ResponseMarkdown";

export type PlanStepStatus = "pending" | "in-progress" | "completed" | "blocked" | "cancelled";

export type PlanStep = {
  id: string;
  title: string;
  detail?: string | null;
  status: PlanStepStatus;
};

export type PlanMarkdownContext = Pick<
  ComponentProps<typeof ResponseMarkdown>,
  "projectRoot" | "projectId" | "conversationId" | "defaultCodeWrap" | "onOpenProjectFile"
>;

export type PlanPanelProps = {
  steps: PlanStep[];
  title?: string;
  summary?: string | null;
  document?: string | null;
  markdown?: PlanMarkdownContext;
  activeStepId?: string | null;
  onSelectStep?: (stepId: string) => void;
  onRefine?: () => void;
  onImplement?: () => void;
};

function StepIcon({ status }: { status: PlanStepStatus }): React.JSX.Element {
  if (status === "completed") return <Check size={14} aria-hidden="true" />;
  if (status === "in-progress") return <LoaderCircle size={15} aria-hidden="true" />;
  if (status === "blocked") return <AlertCircle size={15} aria-hidden="true" />;
  if (status === "cancelled") return <CircleSlash size={14} aria-hidden="true" />;
  return <Circle size={14} aria-hidden="true" />;
}

function statusLabel(status: PlanStepStatus): string {
  if (status === "in-progress") return "In progress";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function PlanInlineText({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {planInlineSegments(text).map((segment, index) =>
        segment.kind === "code" ? <code key={index}>{segment.text}</code>
          : segment.kind === "strong" ? <strong key={index}>{segment.text}</strong>
            : <span key={index}>{segment.text}</span>)}
    </>
  );
}

export function PlanPanel({
  steps,
  title = "Implementation plan",
  summary,
  document,
  markdown,
  activeStepId = null,
  onSelectStep,
  onRefine,
  onImplement,
}: PlanPanelProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const documentId = useId();
  const planCopy = useCopiedState();
  const completed = steps.filter((step) => step.status === "completed").length;
  const progress = steps.length > 0 ? Math.round((completed / steps.length) * 100) : 0;
  const parsed = document?.trim() ? planDocument(document) : null;
  const heading = parsed?.title ?? title;
  const body = parsed?.body ?? "";
  const collapsible = planDocumentIsLong(body);
  const collapsed = collapsible && !expanded;

  return (
    <section className="plan-panel" aria-label="Implementation plan">
      <header className="panel-toolbar plan-toolbar">
        <div className="panel-heading">
          <ListChecks size={17} aria-hidden="true" />
          <div className="panel-heading-copy">
            <h2>{heading}</h2>
            <span>{completed} of {steps.length} complete</span>
          </div>
        </div>
        <div className="plan-toolbar-actions">
          {document?.trim() && (
            <button
              type="button"
              className="plan-copy-button"
              aria-label={planCopy.copied ? "Copied plan" : "Copy plan"}
              title={planCopy.error ?? (planCopy.copied ? "Copied plan" : "Copy plan")}
              disabled={planCopy.pending}
              onClick={() => void planCopy.copy(document.trim())}
            >
              {planCopy.copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            </button>
          )}
          <span className="plan-percent" aria-label={`${progress}% complete`}>{progress}%</span>
        </div>
      </header>

      <div className="plan-progress" role="progressbar" aria-label="Plan progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
        <span style={{ width: `${progress}%` }} />
      </div>

      <div className="plan-scroll">
        {body ? (
          <div className="plan-document-shell">
            <div id={documentId} className={clsx("plan-document", collapsed && "is-collapsed")}>
              {markdown
                ? <ResponseMarkdown content={body} {...markdown} />
                : <div className="plan-document-text">{body}</div>}
            </div>
            {collapsible && (
              <button
                type="button"
                className="plan-document-toggle"
                aria-expanded={expanded}
                aria-controls={documentId}
                onClick={() => setExpanded((value) => !value)}
              >
                <span>{expanded ? "Show less" : "Show full plan"}</span>
                <ChevronDown size={13} aria-hidden="true" />
              </button>
            )}
          </div>
        ) : summary && <p className="plan-summary">{summary}</p>}

        {steps.length === 0 ? !body && (
          <div className="panel-empty plan-empty">
            <ListChecks size={22} aria-hidden="true" />
            <h3>No plan yet</h3>
            <p>Switch the agent to Plan mode to build a step-by-step approach.</p>
          </div>
        ) : (
          <>
            {body && (
              <div className="plan-steps-heading">
                <span>Steps</span>
                <span>{completed} of {steps.length}</span>
              </div>
            )}
            <ol className="plan-steps">
              {steps.map((step, index) => {
                const content = (
                  <>
                    <span className={clsx("plan-step-marker", `is-${step.status}`)}>
                      <StepIcon status={step.status} />
                    </span>
                    <span className="plan-step-copy">
                      <span className="plan-step-title"><span className="plan-step-number">{index + 1}.</span> <PlanInlineText text={step.title} /></span>
                      {step.detail && <span className="plan-step-detail">{step.detail}</span>}
                    </span>
                    <span className="plan-step-status">{statusLabel(step.status)}</span>
                  </>
                );
                return (
                  <li
                    className={clsx("plan-step", `is-${step.status}`, activeStepId === step.id && "is-active")}
                    data-plan-step-status={step.status}
                    key={step.id}
                  >
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
          </>
        )}
      </div>

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
