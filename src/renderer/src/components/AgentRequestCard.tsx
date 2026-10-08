import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Eye, EyeOff, Lock, MessageCircleQuestion } from "lucide-react";
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentInputQuestion,
  AgentInputRequest,
} from "@shared/contracts";
import { agentRequestProviderName, buildAgentInputAnswers, inputRequestTitle } from "../utils/agentInput";
import "./AgentRequestCard.css";

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

type QuestionDraft = { selected: string[]; custom: string; customActive: boolean };
type PanelPhase = "idle" | "out" | "in";

const EMPTY_DRAFT: QuestionDraft = { selected: [], custom: "", customActive: false };
const RECOMMENDED_SUFFIX = /\s*\(recommended\)\s*$/iu;
const PANEL_FADE_OUT_MS = 150;
const PANEL_REVEAL_DELAY_MS = 32;
const STAGE_RESIZE_MS = 320;
const PRIMARY_RESIZE_MS = 300;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function isAnswered(question: AgentInputQuestion, draft: QuestionDraft): boolean {
  if (question.options.length === 0) return Boolean(draft.custom.trim());
  return draft.selected.length > 0 || (draft.customActive && Boolean(draft.custom.trim()));
}

function draftValues(question: AgentInputQuestion, draft: QuestionDraft): string[] {
  if (question.options.length === 0) return [draft.custom];
  return draft.customActive ? [...draft.selected, draft.custom] : draft.selected;
}

function questionHint(question: AgentInputQuestion): string {
  if (question.options.length === 0) return question.isSecret ? "Hidden while you type" : "Type your answer";
  if (question.allowMultiple) return question.isOther ? "Choose any that apply, or add your own" : "Choose any that apply";
  return question.isOther ? "Choose one, or type your own" : "Choose one";
}

/** Claude marks its suggestion with a trailing "(Recommended)"; show it as a label instead. */
function optionLabel(label: string): { text: string; recommended: boolean } {
  const text = label.replace(RECOMMENDED_SUFFIX, "");
  return text && text !== label ? { text, recommended: true } : { text: label, recommended: false };
}

function placeStepIndicator(steps: HTMLElement, indicator: HTMLElement, animate: boolean): void {
  const step = steps.querySelector<HTMLElement>('[aria-selected="true"]');
  if (!step) return;
  if (!animate) indicator.style.transition = "none";
  indicator.style.width = `${Math.max(0, step.offsetWidth - 16)}px`;
  indicator.style.transform = `translateX(${step.offsetLeft + 8}px)`;
  if (animate) return;
  void indicator.offsetWidth;
  indicator.style.transition = "";
}

export function InputRequestCard({ request, onRespond }: InputRequestCardProps): React.JSX.Element {
  const { questions } = request;
  const count = questions.length;
  const [drafts, setDrafts] = useState<Record<string, QuestionDraft>>({});
  const [activeIndex, setActiveIndex] = useState(0);
  const [shownIndex, setShownIndex] = useState(0);
  const [phase, setPhase] = useState<PanelPhase>("idle");
  const [secretVisible, setSecretVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const stepsRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const primaryWidth = useRef(0);
  const focusPanelOnSwap = useRef(false);
  const timers = useRef(new Set<number>());

  const titleId = `input-${request.id}`;
  const descriptionId = `${titleId}-description`;
  const panelId = `${titleId}-panel`;
  const stepId = (index: number): string => `${titleId}-step-${index}`;
  const draftFor = (question: AgentInputQuestion): QuestionDraft => drafts[question.id] ?? EMPTY_DRAFT;
  const answered = (question: AgentInputQuestion): boolean => isAnswered(question, draftFor(question));
  const activeQuestion = questions[activeIndex];
  const shownQuestion = questions[shownIndex];
  const lastQuestion = activeIndex === count - 1;
  const primaryLabel = lastQuestion ? (count === 1 ? "Send answer" : "Send answers") : "Next";

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) window.clearTimeout(timer);
    };
  }, []);

  // The incoming panel mounts transparent; size the stage to it, then fade it in.
  useLayoutEffect(() => {
    if (phase !== "in") return;
    const stage = stageRef.current;
    const panel = stage?.firstElementChild;
    if (stage && panel instanceof HTMLElement) stage.style.height = `${panel.offsetHeight}px`;
    const pending = timers.current;
    const reveal = window.setTimeout(() => {
      pending.delete(reveal);
      setPhase("idle");
    }, PANEL_REVEAL_DELAY_MS);
    const settle = window.setTimeout(() => {
      pending.delete(settle);
      if (!stage) return;
      stage.style.height = "";
      stage.classList.remove("is-animating");
    }, STAGE_RESIZE_MS);
    pending.add(reveal);
    pending.add(settle);
  }, [phase]);

  useEffect(() => {
    if (!focusPanelOnSwap.current) return;
    focusPanelOnSwap.current = false;
    const panel = stageRef.current?.querySelector("fieldset");
    (panel?.querySelector<HTMLElement>("input:checked") ?? panel?.querySelector<HTMLElement>("input"))
      ?.focus({ preventScroll: true });
  }, [shownIndex]);

  useLayoutEffect(() => {
    const steps = stepsRef.current;
    const indicator = indicatorRef.current;
    if (steps && indicator) placeStepIndicator(steps, indicator, indicator.style.width !== "");
  }, [activeIndex]);

  useEffect(() => {
    const steps = stepsRef.current;
    const indicator = indicatorRef.current;
    if (!steps || !indicator || typeof ResizeObserver === "undefined") return;
    let observed = false;
    const observer = new ResizeObserver(() => {
      if (observed) placeStepIndicator(steps, indicator, false);
      observed = true;
    });
    observer.observe(steps);
    return () => observer.disconnect();
  }, []);

  // Ease the primary button between label widths ("Next" ↔ "Send answers").
  useLayoutEffect(() => {
    const button = primaryRef.current;
    if (!button) return;
    button.style.width = "";
    const next = button.offsetWidth;
    const previous = primaryWidth.current;
    primaryWidth.current = next;
    if (!previous || previous === next || prefersReducedMotion()) return;
    button.style.width = `${previous}px`;
    void button.offsetWidth;
    button.style.width = `${next}px`;
    const timer = window.setTimeout(() => { button.style.width = ""; }, PRIMARY_RESIZE_MS);
    return () => window.clearTimeout(timer);
  }, [primaryLabel]);

  const goTo = (index: number, focusPanel = true): void => {
    if (index === activeIndex || index < 0 || index >= count) return;
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current.clear();
    setActiveIndex(index);
    setSecretVisible(false);
    focusPanelOnSwap.current = focusPanel;
    const stage = stageRef.current;
    if (!stage || prefersReducedMotion()) {
      stage?.style.removeProperty("height");
      stage?.classList.remove("is-animating");
      setShownIndex(index);
      setPhase("idle");
      return;
    }
    stage.style.height = `${stage.offsetHeight}px`;
    stage.classList.add("is-animating");
    setPhase("out");
    const pending = timers.current;
    const swap = window.setTimeout(() => {
      pending.delete(swap);
      setShownIndex(index);
      setPhase("in");
    }, PANEL_FADE_OUT_MS);
    pending.add(swap);
  };

  const updateDraft = (question: AgentInputQuestion, update: (draft: QuestionDraft) => QuestionDraft): void => {
    setDrafts((current) => ({ ...current, [question.id]: update(current[question.id] ?? EMPTY_DRAFT) }));
  };
  const chooseOption = (question: AgentInputQuestion, optionId: string, checked: boolean): void => {
    updateDraft(question, (draft) => {
      if (!question.allowMultiple) return { ...draft, selected: [optionId], customActive: false };
      const others = draft.selected.filter((id) => id !== optionId);
      return { ...draft, selected: checked ? [...others, optionId] : others };
    });
  };
  const typeAnswer = (question: AgentInputQuestion, value: string): void => {
    updateDraft(question, (draft) => {
      if (question.options.length === 0) return { ...draft, custom: value };
      const customActive = Boolean(value.trim());
      return { custom: value, customActive, selected: customActive && !question.allowMultiple ? [] : draft.selected };
    });
  };
  // Returning to a typed single-choice answer selects it again.
  const resumeCustomAnswer = (question: AgentInputQuestion): void => {
    updateDraft(question, (draft) => question.allowMultiple || draft.customActive || !draft.custom.trim()
      ? draft
      : { ...draft, selected: [], customActive: true });
  };

  const submit = (): void => {
    if (busy || !questions.every(answered)) return;
    const values = Object.fromEntries(questions.map((question) => [question.id, draftValues(question, draftFor(question))]));
    void runResponse(setBusy, () => onRespond(request, buildAgentInputAnswers(request, values)));
  };
  const advance = (): void => {
    if (busy || !activeQuestion || !answered(activeQuestion)) return;
    if (!lastQuestion) return goTo(activeIndex + 1);
    const firstOpen = questions.findIndex((question) => !answered(question));
    if (firstOpen === -1) submit();
    else goTo(firstOpen);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (busy || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (event.key === "Enter") {
      if (event.shiftKey || target.closest("button")) return;
      event.preventDefault();
      advance();
      return;
    }
    if (target.matches("input[type='text'], input[type='password']")) return;
    if (target.getAttribute("role") === "tab") {
      const stepKeys: Partial<Record<string, number>> = { ArrowRight: activeIndex + 1, ArrowLeft: activeIndex - 1, Home: 0, End: count - 1 };
      const step = stepKeys[event.key];
      if (step === undefined) return;
      event.preventDefault();
      const index = (step + count) % count;
      goTo(index, false);
      document.getElementById(stepId(index))?.focus();
      return;
    }
    if (!/^[1-9]$/u.test(event.key)) return;
    const control = stageRef.current
      ?.querySelectorAll(".agent-input-option")[Number(event.key) - 1]
      ?.querySelector("input");
    if (!control) return;
    event.preventDefault();
    if (control.type === "radio" || control.type === "checkbox") control.click();
    control.focus();
  };

  const renderPanel = (question: AgentInputQuestion): React.JSX.Element => {
    const draft = draftFor(question);
    const rowClass = `agent-input-option${question.allowMultiple ? " is-multi" : ""}`;
    const typeIn = (event: React.ChangeEvent<HTMLInputElement>): void => typeAnswer(question, event.target.value);
    return (
      <fieldset className={`agent-input-panel${phase === "idle" ? "" : ` is-${phase}`}`} disabled={busy}>
        <legend>{question.question}</legend>
        <p className="agent-input-hint">{questionHint(question)}</p>
        <div className="agent-input-options">
          {question.options.map((option) => {
            const label = optionLabel(option.label);
            return (
              <label className={rowClass} key={option.id}>
                <input
                  type={question.allowMultiple ? "checkbox" : "radio"}
                  name={`${request.id}-${question.id}`}
                  value={option.id}
                  checked={draft.selected.includes(option.id)}
                  onChange={(event) => chooseOption(question, option.id, event.target.checked)}
                />
                <span className="agent-input-indicator" aria-hidden="true" />
                <span className="agent-input-option-copy">
                  <strong>{label.text}{label.recommended && <span className="agent-input-recommended">Recommended</span>}</strong>
                  {option.description && <small>{option.description}</small>}
                </span>
              </label>
            );
          })}
          {question.options.length > 0 && question.isOther && (
            <label className={`${rowClass} is-text${draft.customActive ? " is-selected" : ""}`}>
              <span className="agent-input-indicator" aria-hidden="true" />
              <input
                type={question.isSecret ? "password" : "text"}
                autoComplete="off"
                maxLength={4_000}
                value={draft.custom}
                placeholder={question.allowMultiple ? "Add your own…" : "Something else — type your answer"}
                aria-label="Something else"
                onFocus={() => resumeCustomAnswer(question)}
                onChange={typeIn}
              />
            </label>
          )}
          {question.options.length === 0 && (question.isSecret ? (
            <div className="agent-input-option is-text is-secret">
              <Lock size={13} aria-hidden="true" />
              <input
                type={secretVisible ? "text" : "password"}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={4_000}
                value={draft.custom}
                placeholder="Paste value"
                aria-label={question.question}
                onChange={typeIn}
              />
              <button
                type="button"
                className="agent-input-reveal"
                aria-label={secretVisible ? "Hide value" : "Show value"}
                aria-pressed={secretVisible}
                onClick={() => setSecretVisible((visible) => !visible)}
              >
                {secretVisible ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
              </button>
            </div>
          ) : (
            <label className="agent-input-option is-text">
              <input
                type="text"
                autoComplete="off"
                maxLength={4_000}
                value={draft.custom}
                placeholder="Type your answer"
                aria-label={question.question}
                onChange={typeIn}
              />
            </label>
          ))}
        </div>
        {request.autoResolutionMs !== null && (
          <p className="agent-input-note">This question may resolve automatically if left unanswered.</p>
        )}
      </fieldset>
    );
  };

  return (
    <section
      id={`agent-input-request-${request.id}`}
      className="agent-request-card agent-input-card"
      role="region"
      aria-busy={busy}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-agent-request-kind="input"
      data-agent-request-state="question"
      onKeyDown={handleKeyDown}
    >
      <div className="agent-input-heading">
        <MessageCircleQuestion className="agent-input-glyph" size={16} aria-hidden="true" />
        <span className="agent-input-heading-copy">
          <strong id={titleId}>{inputRequestTitle(request.providerId, count)}</strong>
          <small id={descriptionId}>Paused until you answer</small>
        </span>
        {count > 1 && <span className="agent-input-count" key={activeIndex}>{activeIndex + 1} of {count}</span>}
      </div>
      {count > 1 && (
        <div className="agent-input-steps" role="tablist" aria-label="Questions" ref={stepsRef}>
          {questions.map((question, index) => (
            <button
              type="button"
              role="tab"
              id={stepId(index)}
              aria-selected={index === activeIndex}
              aria-controls={panelId}
              tabIndex={index === activeIndex ? 0 : -1}
              data-answered={answered(question)}
              disabled={busy}
              onClick={() => goTo(index, false)}
              key={question.id}
            >
              <span className="agent-input-step-mark" aria-hidden="true"><Check size={10} strokeWidth={3} /></span>
              {question.header || `Question ${index + 1}`}
            </button>
          ))}
          <span className="agent-input-step-indicator" ref={indicatorRef} aria-hidden="true" />
        </div>
      )}
      <div
        ref={stageRef}
        id={panelId}
        className="agent-input-stage"
        role={count > 1 ? "tabpanel" : undefined}
        aria-labelledby={count > 1 ? stepId(activeIndex) : undefined}
      >
        {shownQuestion && renderPanel(shownQuestion)}
      </div>
      {count > 0 && (
        <div className="agent-input-footer">
          <button
            type="button"
            className={`agent-input-back${activeIndex === 0 ? " is-hidden" : ""}`}
            disabled={busy || activeIndex === 0}
            onClick={() => goTo(activeIndex - 1)}
          >
            <ArrowLeft size={13} aria-hidden="true" />
            Back
          </button>
          <button
            ref={primaryRef}
            type="button"
            className="agent-input-primary"
            disabled={busy || !activeQuestion || !answered(activeQuestion)}
            onClick={advance}
          >
            <span className="agent-input-primary-label" key={primaryLabel}>
              {primaryLabel}
              {!lastQuestion && <ArrowRight size={13} aria-hidden="true" />}
            </span>
          </button>
        </div>
      )}
    </section>
  );
}
