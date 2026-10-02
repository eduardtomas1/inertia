import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, Clock3 } from "lucide-react";
import type { LimitResetResult } from "@shared/limit-reset";
import type { LimitResetCommand, LimitResetCommandRunner } from "./limitResetClient";
import { INTERFACE_LOCALE } from "../../lib/locale";
import { diagnosticErrorReference } from "../../utils/diagnosticNavigation";
import { useDocumentActivity } from "../../hooks/useDocumentPresence";
import "./LimitResetBanner.css";

const PENDING_POLL_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;
const loads = new WeakMap<LimitResetCommandRunner, Map<string, Promise<LimitResetResult>>>();
function load(run: LimitResetCommandRunner, conversationId: string): Promise<LimitResetResult> {
  let pending = loads.get(run);
  if (!pending) { pending = new Map(); loads.set(run, pending); }
  const prior = pending.get(conversationId);
  if (prior) return prior;
  const request = run({ type: "conversation.limit-reset.get", payload: { conversationId } })
    .finally(() => { if (pending.get(conversationId) === request) pending.delete(conversationId); });
  pending.set(conversationId, request);
  return request;
}
const pendingPlan = (result: LimitResetResult | null) => result?.plan && ["waiting", "dispatching"].includes(result.plan.state) ? result.plan : null;
export function LimitResetBanner({ conversationId, latestTurnId, snoozedUntil, disabled, onCommand }: {
  conversationId: string; latestTurnId: string | null; snoozedUntil: string | null;
  disabled: boolean; onCommand: LimitResetCommandRunner;
}): React.JSX.Element | null {
  const [result, setResult] = useState<LimitResetResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useDocumentActivity();
  const generation = useRef(0);
  const revision = useRef(0);
  const loaded = useRef(false);
  const checked = useRef(false);
  useEffect(() => {
    generation.current += 1;
    loaded.current = false; checked.current = false;
    setResult(null); setBusy(false); setError(null);
  }, [conversationId, latestTurnId, onCommand]);
  const refresh = useCallback((): void => {
    const owner = generation.current;
    const requested = revision.current;
    void load(onCommand, conversationId).then((next) => {
      if (generation.current !== owner || revision.current !== requested) return;
      loaded.current = true;
      if (checked.current && next.needsCheck && !next.offer && !next.plan) return;
      setResult(next);
    }, () => undefined);
  }, [conversationId, onCommand]);
  useEffect(() => {
    if (active && !disabled && !loaded.current) refresh();
  }, [active, disabled, refresh, latestTurnId]);
  useEffect(() => {
    if (disabled || result?.conversationId !== conversationId) return;
    const plan = pendingPlan(result);
    const resetsAt = Date.parse(plan?.resetsAt ?? result.offer?.resetsAt ?? "");
    if (!Number.isFinite(resetsAt)) return;
    const remaining = resetsAt - Date.now();
    if (remaining <= 0 && !plan) return;
    const timer = window.setTimeout(refresh, Math.min(remaining > 0 ? remaining + 1_000 : PENDING_POLL_MS, MAX_TIMER_MS));
    return () => window.clearTimeout(timer);
  }, [result, conversationId, disabled, refresh]);
  const mutate = async (command: LimitResetCommand): Promise<void> => {
    if (busy || disabled) return;
    const owner = generation.current;
    revision.current += 1;
    setBusy(true); setError(null);
    let reload = false;
    try {
      const next = await onCommand(command);
      if (generation.current !== owner) return;
      if (command.type === "conversation.limit-reset.get") checked.current = true;
      setResult((current) => command.type === "conversation.limit-reset.cancel"
        ? { ...next, offer: next.offer ?? current?.offer ?? null } : next);
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
  const plan = result.plan && !["cancelled", "completed"].includes(result.plan.state) ? result.plan : null;
  const offer = result.offer;
  const unavailable = disabled || busy;
  const action = "secondary-button limit-reset-action";
  const missed = plan?.state === "missed";
  const message = error ? diagnosticErrorReference(error).message
    : missed ? "Inertia was closed or asleep at the reset, so nothing was sent." : plan?.error ?? null;
  if (!plan && !offer) {
    if (!result.needsCheck) return null;
    return <div className="limit-reset" role="group" aria-label="Usage limit" data-state="check">
      <Clock3 className="limit-reset-icon" size={14} aria-hidden="true" />
      <span className="limit-reset-copy">
        <strong>Reset time not checked</strong>
        <span className="limit-reset-detail">Checking can ask for macOS Keychain access.</span>
      </span>
      <span className="limit-reset-actions">
        <button type="button" className={action} aria-disabled={unavailable || undefined}
          onClick={() => void mutate({ type: "conversation.limit-reset.get", payload: { conversationId, refresh: true } })}>Check reset time</button>
      </span>
      {message && <p className="limit-reset-message" role="alert">{message}</p>}
    </div>;
  }
  const pending = plan?.state === "waiting" || plan?.state === "dispatching";
  const blocked = plan?.state === "blocked";
  const resetsAt = plan?.resetsAt ?? offer!.resetsAt;
  const snoozed = snoozedUntil !== null && Date.parse(snoozedUntil) >= Date.parse(resetsAt);
  const when = new Date(resetsAt).toLocaleString(INTERFACE_LOCALE, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const Icon = blocked || missed ? CircleAlert : Clock3;
  return <div className="limit-reset" role="group" aria-label="Usage limit" data-state={pending ? "scheduled" : blocked ? "blocked" : missed ? "missed" : "offer"}>
    <Icon className="limit-reset-icon" size={14} aria-hidden="true" />
    <span className="limit-reset-copy">
      <strong>{pending ? "Resume scheduled" : blocked ? "Resume needs attention" : missed ? "Resume missed" : "Usage limit reached"}</strong>
      <time dateTime={resetsAt} title={new Date(resetsAt).toLocaleString(INTERFACE_LOCALE)}>{pending ? "Resumes" : missed ? "Reset" : "Resets"} {when}</time>
    </span>
    <span className="limit-reset-actions">
      {missed && <button type="button" className={action} aria-disabled={unavailable || undefined}
        onClick={() => void mutate({ type: "conversation.limit-reset.resume", payload: { conversationId, id: plan.id } })}>Resume now</button>}
      {pending || blocked || missed ? <button type="button" className={action} aria-disabled={unavailable || undefined}
        onClick={() => void mutate({ type: "conversation.limit-reset.cancel", payload: { conversationId, id: plan.id } })}>Cancel resume</button>
        : offer && <button type="button" className={action} aria-disabled={unavailable || !offer.canResume || undefined}
          title={offer.canResume ? "Continue this chat when quota is available and Inertia is running" : "Automatic resume is unavailable for this account"}
          onClick={() => { if (offer.canResume) void mutate({ type: "conversation.limit-reset.schedule", payload: { conversationId, id: crypto.randomUUID(), failedTurnId: offer.failedTurnId, resetsAt: offer.resetsAt } }); }}>Resume at reset</button>}
      {offer && <button type="button" className={action} aria-disabled={unavailable || snoozed || undefined}
        onClick={() => { if (!snoozed) void mutate({ type: "conversation.limit-reset.snooze", payload: { conversationId, failedTurnId: offer.failedTurnId, resetsAt: offer.resetsAt } }); }}>{snoozed ? "Snoozed until reset" : "Snooze until reset"}</button>}
    </span>
    {message && <p className="limit-reset-message" role={error ? "alert" : "status"}>{message}</p>}
  </div>;
}
