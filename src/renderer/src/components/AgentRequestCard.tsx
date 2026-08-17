import { useEffect, useState } from "react";
import type { AgentApprovalDecision, AgentApprovalRequest, AgentInputRequest } from "@shared/contracts";
import { agentRequestProviderName, buildAgentInputAnswers, inputRequestTitle } from "../utils/agentInput";

type ApprovalCardProps = {
  request: AgentApprovalRequest;
  onRespond: (request: AgentApprovalRequest, decision: AgentApprovalDecision) => Promise<void>;
};

const APPROVAL_BUTTONS = [
  ["cancel", "Cancel turn"],
  ["deny", "Deny"],
  ["approve", "Approve once"],
] as const;

async function runResponse(setBusy: (busy: boolean) => void, respond: () => Promise<void>): Promise<void> {
  setBusy(true);
  try { await respond(); } finally { setBusy(false); }
}

export function ApprovalCard({ request, onRespond }: ApprovalCardProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const descriptionId = `approval-${request.id}-description`;
  const detailRows = ([
    ["Reason", request.reason],
    ["Location", request.cwd],
    ["Network", request.networkScope && `${request.networkScope.protocol.toUpperCase()} · ${request.networkScope.host}`],
    ["Requested access", request.permissionRoots.length > 0 && request.permissionRoots.map(({ access, path }) => `${access}: ${path}`).join(" · ")],
  ] as [string, string | null | false | undefined][]).filter(([, value]) => value);
  const respond = (decision: AgentApprovalDecision) => {
    if (busy) return;
    return runResponse(setBusy, () => onRespond(request, decision));
  };

  return (
    <section
      className="agent-request-card is-approval"
      role="region"
      aria-busy={busy}
      aria-labelledby={`approval-${request.id}`}
      aria-describedby={descriptionId}
      data-agent-request-kind={request.kind}
      data-agent-request-state="approval"
    >
      <div className="agent-request-heading">
        <span className="agent-request-icon" aria-hidden="true">?</span>
        <span className="agent-request-heading-copy">
          <span className="agent-request-kicker">Approval required</span>
          <strong id={`approval-${request.id}`}>{request.title}</strong>
          <small id={descriptionId}>{agentRequestProviderName(request.providerId)} paused for your review.</small>
        </span>
      </div>
      {request.command && (
        <code className="agent-request-command" aria-label="Command awaiting approval">
          {request.command}
        </code>
      )}
      {request.detail && <p className="agent-request-detail">{request.detail}</p>}
      {detailRows.length > 0 && (
        <dl className="agent-request-details">
          {detailRows.flatMap(([label, value]) => [<dt key={label}>{label}</dt>, <dd key={`${label}-value`}>{value}</dd>])}
        </dl>
      )}
      <div className="agent-request-actions">
        {APPROVAL_BUTTONS.map(([decision, label]) => request.availableDecisions.includes(decision) && (
          <button type="button" className={decision === "approve" ? "primary-button" : "secondary-button"} data-agent-request-decision={decision} disabled={busy} onClick={() => void respond(decision)} key={decision}>{label}</button>
        ))}
      </div>
    </section>
  );
}

type InputRequestCardProps = {
  request: AgentInputRequest;
  onRespond: (request: AgentInputRequest, answers: Record<string, string[]>) => Promise<void>;
};

export function InputRequestCard({ request, onRespond }: InputRequestCardProps): React.JSX.Element {
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const descriptionId = `input-${request.id}-description`;

  useEffect(() => { setAnswers({}); setActiveQuestionIndex(0); }, [request.id]);
  const hasAnswer = (id: string) => (answers[id] ?? []).some((value) => Boolean(value.trim()));
  const complete = request.questions.every(({ id }) => hasAnswer(id));
  const lastQuestion = activeQuestionIndex === request.questions.length - 1;
  const activeQuestionComplete = hasAnswer(request.questions[activeQuestionIndex]?.id ?? "");

  const submit = () => {
    if (!complete || busy) return;
    return runResponse(setBusy, () => onRespond(request, buildAgentInputAnswers(request, answers)));
  };

  return (
    <section
      id={`agent-input-request-${request.id}`}
      className="agent-request-card agent-input-card is-question"
      role="region"
      aria-busy={busy}
      aria-labelledby={`input-${request.id}`}
      aria-describedby={descriptionId}
      data-agent-request-kind="input"
      data-agent-request-state="question"
    >
      <div className="agent-request-heading">
        <span className="agent-request-icon" aria-hidden="true">?</span>
        <span className="agent-request-heading-copy">
          <span className="agent-request-kicker">Input required</span>
          <strong id={`input-${request.id}`}>{inputRequestTitle(request.providerId)}</strong>
          <small id={descriptionId}>{agentRequestProviderName(request.providerId)} will continue after every question is answered.</small>
        </span>
      </div>
      <div className="agent-input-questions">
        {request.questions.slice(activeQuestionIndex, activeQuestionIndex + 1).map((question) => {
          const optionIds = new Set(question.options.map(({ id }) => id));
          const selected = answers[question.id] ?? [];
          const otherValue = selected.find((value) => !optionIds.has(value)) ?? "";
          const selectOption = (optionId: string, checked: boolean): void => {
            setAnswers((current) => {
              const values = current[question.id] ?? [];
              const custom = values.filter((value) => !optionIds.has(value));
              if (!question.allowMultiple) return { ...current, [question.id]: [optionId] };
              const selectedIds = values.filter((value) => optionIds.has(value) && value !== optionId);
              return {
                ...current,
                [question.id]: checked ? [...selectedIds, optionId, ...custom] : [...selectedIds, ...custom],
              };
            });
          };
          const enterCustomAnswer = (value: string): void => {
            setAnswers((current) => {
              const selectedIds = (current[question.id] ?? []).filter((answer) => optionIds.has(answer));
              return {
                ...current,
                [question.id]: [
                  ...(question.allowMultiple ? selectedIds : []),
                  ...(value ? [value] : []),
                ],
              };
            });
          };
          return (
            <fieldset className="agent-input-question" key={question.id} disabled={busy}>
              <legend><span>{question.header}</span>{question.question}</legend>
              {question.options.length > 0 && (
                <div className="agent-input-options">
                  {question.options.map((option) => (
                    <label key={option.id}>
                      <input
                        type={question.allowMultiple ? "checkbox" : "radio"}
                        name={`${request.id}-${question.id}`}
                        value={option.id}
                        checked={selected.includes(option.id)}
                        onChange={(event) => selectOption(option.id, event.target.checked)}
                      />
                      <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
                    </label>
                  ))}
                </div>
              )}
              {(question.options.length === 0 || question.isOther) && (
                <input
                  className="agent-input-text"
                  type={question.isSecret ? "password" : "text"}
                  autoComplete="off"
                  autoCapitalize={question.isSecret ? "none" : undefined}
                  spellCheck={question.isSecret ? false : undefined}
                  value={otherValue}
                  maxLength={4_000}
                  placeholder={question.isOther && question.options.length > 0 ? "Or enter another answer" : "Your answer"}
                  aria-label={question.question}
                  onChange={(event) => enterCustomAnswer(event.target.value)}
                />
              )}
            </fieldset>
          );
        })}
      </div>
      {request.autoResolutionMs !== null && <p className="agent-request-note">This question may resolve automatically if left unanswered.</p>}
      {request.questions.length > 0 && (
        <div className="agent-input-footer">
          <div className="agent-input-pager" aria-label="Question navigation">
            <button
              type="button"
              className="agent-input-page-arrow"
              aria-label="Previous question"
              disabled={busy || activeQuestionIndex === 0}
              onClick={() => setActiveQuestionIndex(activeQuestionIndex - 1)}
            >
              ←
            </button>
            <span className="agent-input-page-dots">
              {request.questions.map((question, questionIndex) => (
                <button
                  type="button"
                  aria-label={`Go to question ${questionIndex + 1}`}
                  aria-current={questionIndex === activeQuestionIndex}
                  data-answered={hasAnswer(question.id)}
                  disabled={busy}
                  onClick={() => setActiveQuestionIndex(questionIndex)}
                  key={question.id}
                />
              ))}
            </span>
          </div>
          <div className="agent-request-actions">
            <button
              type="button"
              className="primary-button"
              disabled={busy || (lastQuestion ? !complete : !activeQuestionComplete)}
              onClick={() => lastQuestion ? void submit() : setActiveQuestionIndex(activeQuestionIndex + 1)}
            >
              {lastQuestion ? "Continue" : "Next →"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
