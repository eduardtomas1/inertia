import clsx from "clsx";
import { useId, useState, type ComponentProps } from "react";
import { Check, ChevronDown, Circle, CircleAlert, CircleSlash, Copy, Play, RotateCcw } from "lucide-react";

import { useCopiedState } from "../hooks/useCopiedState";
import { planDocument, planDocumentIsLong, planInlineSegments } from "../utils/planDocument";
import { ResponseMarkdown } from "./ResponseMarkdown";
import { IconButton, LoadingMark } from "./ui";

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
  document?: string | null;
  markdown?: PlanMarkdownContext;
  activeStepId?: string | null;
  onSelectStep?: (stepId: string) => void;
  actionsDisabled?: boolean;
  onRefine?: () => void;
  onImplement?: () => void;
};

function StepIcon({ status }: { status: PlanStepStatus }): React.JSX.Element {
  if (status === "completed") return <Check size={14} aria-hidden="true" />;
  if (status === "in-progress") return <LoadingMark size={14} aria-hidden="true" />;
  if (status === "blocked") return <CircleAlert size={14} aria-hidden="true" />;
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
  document,
  markdown,
  activeStepId = null,
  onSelectStep,
  actionsDisabled = false,
  onRefine,
  onImplement,
}: PlanPanelProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const documentId = useId();
  const planCopy = useCopiedState();
  const completed = steps.filter((step) => step.status === "completed").length;
  const parsed = document?.trim() ? planDocument(document) : null;
  const heading = parsed?.title ?? title;
  const body = parsed?.body ?? "";
  const collapsible = planDocumentIsLong(body);
  const collapsed = collapsible && !expanded;

  return (
    <section className="plan-panel" aria-label="Implementation plan">
      <header className="panel-toolbar plan-toolbar">
        <div className="panel-heading">
          <div className="panel-heading-copy">
            <h2>{heading}</h2>
            {steps.length > 0 && <span>{completed} of {steps.length} complete</span>}
          </div>
        </div>
        <div className="plan-toolbar-actions">
          {document?.trim() && (
            <IconButton
              className="plan-copy-button"
              label={planCopy.error ?? (planCopy.copied ? "Copied plan" : "Copy plan")}
              aria-label={planCopy.copied ? "Copied plan" : "Copy plan"}
              disabled={planCopy.pending}
              onClick={() => void planCopy.copy(document.trim())}
            >
              {planCopy.copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
            </IconButton>
          )}
        </div>
      </header>

      <div className="plan-scroll">
        {body && (
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
                <ChevronDown size={14} aria-hidden="true" />
              </button>
            )}
          </div>
        )}

        {steps.length === 0 ? !body && (
          <div className="panel-empty plan-empty">
            <h3>No plan yet</h3>
          </div>
        ) : (
          <>
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

      {(onRefine || onImplement) && (steps.length > 0 || body) && (
        <footer className="plan-actions">
          {onRefine && (
            <button type="button" className="secondary-button" onClick={onRefine} disabled={actionsDisabled}>
              <RotateCcw size={14} aria-hidden="true" />
              <span>Refine plan</span>
            </button>
          )}
          {onImplement && (
            <button type="button" className="primary-button" onClick={onImplement} disabled={actionsDisabled || steps.length === 0}>
              <Play size={14} aria-hidden="true" />
              <span>Implement</span>
            </button>
          )}
        </footer>
      )}
    </section>
  );
}
