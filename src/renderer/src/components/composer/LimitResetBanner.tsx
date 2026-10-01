import { useEffect, useRef, useState } from "react";
import { Clock3 } from "lucide-react";
import type { LimitResetResult } from "@shared/limit-reset";
import type { LimitResetCommand, LimitResetCommandRunner } from "./limitResetClient";
import { INTERFACE_LOCALE } from "../../lib/locale";
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
  const resetsAt = plan?.resetsAt ?? offer!.resetsAt;
  const snoozed = snoozedUntil !== null && Date.parse(snoozedUntil) >= Date.parse(resetsAt);
  const when = new Date(resetsAt).toLocaleString(INTERFACE_LOCALE, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return <div className="limit-reset-banner" role="region" aria-label="Usage limit">
    <div className="limit-reset-row">
      <Clock3 size={14} aria-hidden="true" />
      <span className="limit-reset-label">{pending ? "Resume scheduled" : plan?.state === "blocked" ? "Resume needs attention" : "Usage limit reached"}</span>
      <time dateTime={resetsAt} title={new Date(resetsAt).toLocaleString(INTERFACE_LOCALE)}>{pending ? "At" : "Resets"} {when}</time>
      <div className="limit-reset-actions">
        {pending || plan?.state === "blocked" ? <button type="button" disabled={disabled || busy} onClick={() => void mutate({ type: "conversation.limit-reset.cancel", payload: { conversationId, id: plan.id } })}>Cancel resume</button>
          : offer && <button type="button" disabled={disabled || busy || !offer.canResume}
            title={offer.canResume ? "Continue this chat when quota is available and Inertia is running" : "Automatic resume is unavailable for this account"}
            onClick={() => void mutate({ type: "conversation.limit-reset.schedule", payload: { conversationId, id: crypto.randomUUID(), failedTurnId: offer.failedTurnId, resetsAt: offer.resetsAt } })}>Resume at reset</button>}
        {offer && <button type="button" disabled={disabled || busy || snoozed}
          onClick={() => void mutate({ type: "conversation.limit-reset.snooze", payload: { conversationId, failedTurnId: offer.failedTurnId, resetsAt: offer.resetsAt } })}>{snoozed ? "Snoozed until reset" : "Snooze until reset"}</button>}
      </div>
    </div>
    {(error ?? plan?.error) && <p role="status">{error ?? plan?.error}</p>}
  </div>;
}
