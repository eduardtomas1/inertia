import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { CircleAlert, Clock } from "lucide-react";
import type { LimitResetResult } from "@shared/limit-reset";
import type { LimitResetCommand, LimitResetCommandRunner } from "./limitResetClient";
import { INTERFACE_LOCALE } from "../../lib/locale";
import { diagnosticErrorReference } from "../../utils/diagnosticNavigation";
import { useDocumentActivity } from "../../hooks/useDocumentPresence";
import "./LimitResetBanner.css";

const PENDING_POLL_MS = 30_000;
const RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 30_000];
const MAX_TIMER_MS = 2_147_483_647;
const MISSED_MESSAGE = "Inertia was closed or asleep at the reset, so nothing was sent.";
const loads = new WeakMap<LimitResetCommandRunner, Map<string, Promise<LimitResetResult>>>();

function load(run: LimitResetCommandRunner, conversationId: string): Promise<LimitResetResult> {
  let pending = loads.get(run);
  if (!pending) {
    pending = new Map();
    loads.set(run, pending);
  }
  const prior = pending.get(conversationId);
  if (prior) return prior;
  const request = run({ type: "conversation.limit-reset.get", payload: { conversationId } }).finally(() => {
    if (pending.get(conversationId) === request) pending.delete(conversationId);
  });
  pending.set(conversationId, request);
  return request;
}

function pendingPlan(result: LimitResetResult | null) {
  return result?.plan && ["waiting", "dispatching"].includes(result.plan.state) ? result.plan : null;
}

function refreshDelay(result: LimitResetResult, now: number): number | null {
  const plan = pendingPlan(result);
  const resetsAt = Date.parse(plan?.resetsAt ?? result.offer?.resetsAt ?? "");
  if (!Number.isFinite(resetsAt)) return null;
  const remaining = resetsAt - now;
  return remaining > 0 ? Math.min(remaining + 1_000, MAX_TIMER_MS) : PENDING_POLL_MS;
}

export function LimitResetBanner({ conversationId, latestTurnId, snoozedUntil, disabled, providerState, onCommand, onContinueElsewhere }: {
  conversationId: string;
  latestTurnId: string | null;
  snoozedUntil: string | null;
  disabled: boolean;
  providerState: string;
  onCommand: LimitResetCommandRunner;
  onContinueElsewhere?: () => void;
}): React.JSX.Element | null {
  const [result, setResult] = useState<LimitResetResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [misses, setMisses] = useState(0);
  const active = useDocumentActivity();
  const reasonId = useId();
  const generation = useRef(0);
  const revision = useRef(0);
  const loaded = useRef(false);
  useEffect(() => {
    generation.current += 1;
    loaded.current = false;
    setResult(null);
    setBusy(false);
    setError(null);
    setMisses(0);
  }, [conversationId, latestTurnId, onCommand]);
  const refresh = useCallback((): void => {
    const owner = generation.current;
    const requested = revision.current;
    void load(onCommand, conversationId).then((next) => {
      if (generation.current !== owner || revision.current !== requested) return;
      const empty = next.usageLimited && !next.offer && !next.plan;
      loaded.current = !empty;
      setResult(next);
      setMisses((current) => empty ? current + 1 : 0);
    }, () => {
      if (generation.current === owner) setMisses((current) => current + 1);
    });
  }, [conversationId, onCommand]);
  useEffect(() => {
    if (active && !disabled && !loaded.current) refresh();
  }, [active, disabled, refresh, latestTurnId, providerState]);
  useEffect(() => {
    if (!active || disabled || misses === 0 || misses > RETRY_DELAYS_MS.length) return;
    const timer = window.setTimeout(refresh, RETRY_DELAYS_MS[misses - 1]);
    return () => window.clearTimeout(timer);
  }, [active, disabled, misses, refresh]);
  useEffect(() => {
    if (!active || disabled || result?.conversationId !== conversationId) return;
    const delay = refreshDelay(result, Date.now());
    if (delay === null) return;
    const timer = window.setTimeout(refresh, delay);
    return () => window.clearTimeout(timer);
  }, [active, result, conversationId, disabled, refresh]);
  const rowRef = useRef<HTMLDivElement>(null);
  const keepFocus = useRef(false);
  useLayoutEffect(() => {
    if (busy || !keepFocus.current) return;
    keepFocus.current = false;
    if (document.activeElement === document.body) rowRef.current?.querySelector("button")?.focus();
  });
  const mutate = async (command: LimitResetCommand): Promise<void> => {
    if (busy || disabled) return;
    keepFocus.current = rowRef.current?.contains(document.activeElement) ?? false;
    const owner = generation.current;
    revision.current += 1;
    setBusy(true);
    setError(null);
    let reload = false;
    try {
      const next = await onCommand(command);
      if (generation.current !== owner) return;
      setResult((current) => command.type === "conversation.limit-reset.cancel"
        ? { ...next, offer: next.offer ?? current?.offer ?? null }
        : next);
    } catch (failure) {
      if (generation.current !== owner) return;
      setError(failure instanceof Error ? failure.message : "The reset action could not be updated.");
      reload = command.type !== "conversation.limit-reset.cancel";
    } finally {
      revision.current += 1;
      loads.get(onCommand)?.delete(conversationId);
      if (generation.current === owner) setBusy(false);
    }
    if (reload) refresh();
  };
  if (result?.conversationId !== conversationId) return null;
  const unavailable = disabled || busy;
  const action = "secondary-button limit-reset-action";
  const continueElsewhere = onContinueElsewhere && <button type="button" className={action} aria-disabled={unavailable || undefined}
    onClick={() => { if (!unavailable) onContinueElsewhere(); }}>Continue with another model</button>;
  const plan = result.plan && !["cancelled", "completed"].includes(result.plan.state)
    && (latestTurnId === null || result.plan.failedTurnId === latestTurnId) ? result.plan : null;
  const offer = result.offer;
  if (!plan && !offer) {
    return result.usageLimited
      ? <div className="limit-reset" role="group" aria-label="Usage limit" data-state="limited">
        <Clock className="limit-reset-icon" size={14} aria-hidden="true" />
        <span className="limit-reset-copy"><strong>Usage limit reached</strong></span>
        {continueElsewhere && <span className="limit-reset-actions">{continueElsewhere}</span>}
      </div>
      : null;
  }
  const pending = plan?.state === "waiting" || plan?.state === "dispatching";
  const blocked = plan?.state === "blocked";
  const missed = plan?.state === "missed";
  const message = error ? diagnosticErrorReference(error).message : missed ? plan.error ?? MISSED_MESSAGE : plan?.error ?? null;
  const reason = !plan && offer && !offer.canResume ? offer.unavailableReason : null;
  const resetsAt = plan?.resetsAt ?? offer!.resetsAt;
  const snoozed = snoozedUntil !== null && Date.parse(snoozedUntil) >= Date.parse(resetsAt);
  const when = new Date(resetsAt).toLocaleString(INTERFACE_LOCALE, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const Icon = blocked || missed ? CircleAlert : Clock;
  const state = pending ? "scheduled" : blocked ? "blocked" : missed ? "missed" : "offer";
  const title = pending ? "Resume scheduled" : blocked ? "Resume needs attention" : missed ? "Resume missed" : "Usage limit reached";
  const schedule = (): void => {
    if (!offer?.canResume) return;
    void mutate({ type: "conversation.limit-reset.schedule",
      payload: { conversationId, id: crypto.randomUUID(), failedTurnId: offer.failedTurnId, resetsAt: offer.resetsAt } });
  };
  const snooze = (): void => {
    if (!offer || snoozed) return;
    void mutate({ type: "conversation.limit-reset.snooze", payload: { conversationId, failedTurnId: offer.failedTurnId, resetsAt: offer.resetsAt } });
  };
  return <div ref={rowRef} className="limit-reset" role="group" aria-label="Usage limit" data-state={state}>
    <Icon className="limit-reset-icon" size={14} aria-hidden="true" />
    <span className="limit-reset-copy">
      <strong>{title}</strong>
      <time dateTime={resetsAt} title={new Date(resetsAt).toLocaleString(INTERFACE_LOCALE)}>
        {pending ? "Resumes" : missed ? "Reset" : "Resets"} {when}
      </time>
    </span>
    <span className="limit-reset-actions">
      {missed && <button type="button" className={action} aria-disabled={unavailable || undefined}
        onClick={() => void mutate({ type: "conversation.limit-reset.resume", payload: { conversationId, id: plan.id } })}>Resume now</button>}
      {plan
        ? <button type="button" className={action} aria-disabled={unavailable || undefined}
          onClick={() => void mutate({ type: "conversation.limit-reset.cancel", payload: { conversationId, id: plan.id } })}>Cancel resume</button>
        : offer && <button type="button" className={action} aria-disabled={unavailable || !offer.canResume || undefined}
          aria-describedby={reason ? reasonId : undefined} onClick={schedule}>Resume at reset</button>}
      {offer && <button type="button" className={action} aria-disabled={unavailable || snoozed || undefined}
        onClick={snooze}>{snoozed ? "Snoozed until reset" : "Snooze until reset"}</button>}
      {!pending && continueElsewhere}
    </span>
    {message && <p className="limit-reset-message" role={error ? "alert" : "status"}>{message}</p>}
    {reason && !error && <p className="limit-reset-message" id={reasonId}>{reason}</p>}
  </div>;
}
