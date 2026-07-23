import { useEffect, useMemo, useState } from "react";
import { FilePenLine, ShieldAlert, TerminalSquare } from "lucide-react";
import type { AgentApprovalDecision, AgentApprovalRequest, AgentInputRequest } from "@shared/contracts";
import { buildAgentInputAnswers, inputRequestTitle } from "@/utils/agentInput";

type ApprovalCardProps = {
  request: AgentApprovalRequest;
  onRespond: (request: AgentApprovalRequest, decision: AgentApprovalDecision) => Promise<void>;
};

export function ApprovalCard({ request, onRespond }: ApprovalCardProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const respond = async (decision: AgentApprovalDecision) => {
    if (busy) return;
    setBusy(true);
    try {
      await onRespond(request, decision);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="agent-request-card" role="region" aria-live="polite" aria-labelledby={`approval-${request.id}`}>
      <div className="agent-request-heading">
        <span className="agent-request-icon">{request.kind === "command" ? <TerminalSquare size={16} /> : request.kind === "permissions" ? <ShieldAlert size={16} /> : <FilePenLine size={16} />}</span>
        <span>
          <strong id={`approval-${request.id}`}>{request.title}</strong>
          <small>The agent paused for your review.</small>
        </span>
      </div>
      {request.command && <code className="agent-request-command">{request.command}</code>}
      {!request.command && request.detail && <p>{request.detail}</p>}
      {(request.reason || request.cwd || request.networkScope || request.permissionRoots.length > 0) && (
        <dl className="agent-request-details">
          {request.reason && <><dt>Reason</dt><dd>{request.reason}</dd></>}
          {request.cwd && <><dt>Location</dt><dd>{request.cwd}</dd></>}
          {request.networkScope && <><dt>Network</dt><dd>{request.networkScope.protocol.toUpperCase()} · {request.networkScope.host}</dd></>}
          {request.permissionRoots.length > 0 && (
            <>
              <dt>Requested access</dt>
              <dd>{request.permissionRoots.map(({ access, path }) => `${access}: ${path}`).join(" · ")}</dd>
            </>
          )}
        </dl>
      )}
      <div className="agent-request-actions">
        {request.availableDecisions.includes("cancel") && <button type="button" className="secondary-button" disabled={busy} onClick={() => void respond("cancel")}>Cancel turn</button>}
        {request.availableDecisions.includes("deny") && <button type="button" className="secondary-button" disabled={busy} onClick={() => void respond("deny")}>Deny</button>}
        {request.availableDecisions.includes("approve") && <button type="button" className="primary-button" disabled={busy} onClick={() => void respond("approve")}>Approve once</button>}
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
  const [busy, setBusy] = useState(false);

  useEffect(() => setAnswers({}), [request.id]);
  const complete = useMemo(
    () => request.questions.every(({ id }) => (answers[id] ?? []).some((value) => Boolean(value.trim()))),
    [answers, request.questions],
  );

  const submit = async () => {
    if (!complete || busy) return;
    setBusy(true);
    try {
      await onRespond(
        request,
        buildAgentInputAnswers(request, answers),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="agent-request-card agent-input-card" role="region" aria-live="polite" aria-labelledby={`input-${request.id}`}>
      <div className="agent-request-heading">
        <span className="agent-request-icon"><ShieldAlert size={16} /></span>
        <span>
          <strong id={`input-${request.id}`}>{inputRequestTitle(request.providerId)}</strong>
          <small>The turn will continue after every question is answered.</small>
        </span>
      </div>
      <div className="agent-input-questions">
        {request.questions.map((question) => {
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
            <fieldset className="agent-input-question" key={question.id}>
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
      <div className="agent-request-actions">
        <button type="button" className="primary-button" disabled={!complete || busy} onClick={() => void submit()}>Continue</button>
      </div>
    </section>
  );
}
