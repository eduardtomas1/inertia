import { useEffect, useRef, useState } from "react";
import { CircleAlert, Clock3 } from "lucide-react";
import type { LimitResetResult } from "@shared/limit-reset";
import type { LimitResetCommand, LimitResetCommandRunner } from "./limitResetClient";
import { INTERFACE_LOCALE } from "../../lib/locale";
import { diagnosticErrorReference } from "../../utils/diagnosticNavigation";
import "./LimitResetBanner.css";

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
export function LimitResetBanner({ conversationId, latestTurnId, snoozedUntil, disabled, onCommand }: {
  conversationId: string; latestTurnId: string | null; snoozedUntil: string | null;
  disabled: boolean; onCommand: LimitResetCommandRunner;
}): React.JSX.Element | null {
  const [result, setResult] = useState<LimitResetResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const revision = useRef(0);
  useEffect(() => {
    const owner = ++generation.current;
    setResult(null); setBusy(false); setError(null);
    const refresh = (): void => {
      if (document.visibilityState === "hidden" || disabled) return;
      const requested = revision.current;
      void load(onCommand, conversationId).then((next) => {
        if (generation.current === owner && revision.current === requested) setResult(next);
      }, () => undefined);
    };
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { generation.current += 1; window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [conversationId, latestTurnId, onCommand, disabled]);
  const mutate = async (command: LimitResetCommand): Promise<void> => {
    if (busy || disabled) return;
    const owner = generation.current;
    revision.current += 1;
    setBusy(true); setError(null);
    try {
      const next = await onCommand(command);
      if (generation.current === owner) setResult((current) => command.type === "conversation.limit-reset.cancel"
        ? { ...next, offer: next.offer ?? current?.offer ?? null } : next);
    } catch (failure) {
      if (generation.current === owner) setError(failure instanceof Error ? failure.message : "The reset action could not be updated.");
    } finally {
      revision.current += 1;
      loads.get(onCommand)?.delete(conversationId);
      if (generation.current === owner) setBusy(false);
    }
  };
  if (result?.conversationId !== conversationId) return null;
  const plan = result.plan && !["cancelled", "completed"].includes(result.plan.state) ? result.plan : null;
  const offer = result.offer;
  if (!plan && !offer) return null;
  const pending = plan?.state === "waiting" || plan?.state === "dispatching";
  const blocked = plan?.state === "blocked";
  const resetsAt = plan?.resetsAt ?? offer!.resetsAt;
  const snoozed = snoozedUntil !== null && Date.parse(snoozedUntil) >= Date.parse(resetsAt);
  const when = new Date(resetsAt).toLocaleString(INTERFACE_LOCALE, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const unavailable = disabled || busy;
  const action = "secondary-button limit-reset-action";
  const message = error ? diagnosticErrorReference(error).message : plan?.error ?? null;
  const Icon = blocked ? CircleAlert : Clock3;
  return <div className="limit-reset" role="group" aria-label="Usage limit" data-state={pending ? "scheduled" : blocked ? "blocked" : "offer"}>
    <Icon className="limit-reset-icon" size={14} aria-hidden="true" />
    <span className="limit-reset-copy">
      <strong>{pending ? "Resume scheduled" : blocked ? "Resume needs attention" : "Usage limit reached"}</strong>
      <time dateTime={resetsAt} title={new Date(resetsAt).toLocaleString(INTERFACE_LOCALE)}>{pending ? "Resumes" : "Resets"} {when}</time>
    </span>
    <span className="limit-reset-actions">
      {pending || blocked ? <button type="button" className={action} aria-disabled={unavailable || undefined}
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
