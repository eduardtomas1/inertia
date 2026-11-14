import { useLayoutEffect, useRef, useState } from "react";
import type { ServerEvent } from "@shared/contracts";
import { USAGE_RESET_CONFIRMATION_EXPIRED, type UsageAccount, type UsageResetConfirmation } from "@shared/provider-usage-limits";

import { resultEvent, type CommandWithoutId } from "../../lib/runtimeCommands";
import { limitCountdown, limitRemaining, limitResetText } from "./limitMath";
import { ageLabel, dateLabel, plural } from "./limitText";

export interface LimitResetFlow {
  confirmation: UsageResetConfirmation | null;
  busy: boolean;
  message: string | null;
  uncertain: boolean;
  renewRequired: boolean;
}

export const IDLE_RESET_FLOW: LimitResetFlow = {
  confirmation: null,
  busy: false,
  message: null,
  uncertain: false,
  renewRequired: false,
};

const OUTCOME_MESSAGE = {
  reset: "One reset was applied. Refreshing quota…",
  alreadyRedeemed: "This reset was already applied. Refreshing quota…",
  nothingToReset: "No eligible window needed a reset. No credit was used.",
  noCredit: "The provider reported no available reset credit.",
} as const;

export function LimitAccountDetails({
  id,
  account,
  number,
  now,
  flow,
  online,
  request,
  onFlow,
  onRefresh,
}: {
  id: string;
  account: UsageAccount;
  number: number | null;
  now: number;
  flow: LimitResetFlow;
  online: boolean;
  request(command: CommandWithoutId): Promise<ServerEvent>;
  onFlow(accountId: string, patch: Partial<LimitResetFlow>): void;
  onRefresh(): void;
}): React.JSX.Element {
  const [revealed, setRevealed] = useState(false);
  const { confirmation, busy, message, uncertain, renewRequired } = flow;
  const set = (patch: Partial<LimitResetFlow>): void => onFlow(account.id, patch);
  const expired = Boolean(confirmation && (renewRequired || Date.parse(confirmation.expiresAt) <= now));
  const root = useRef<HTMLDivElement>(null);
  const resetTrigger = useRef<HTMLButtonElement>(null);
  const confirmationButton = useRef<HTMLButtonElement>(null);
  const confirmationSection = useRef<HTMLElement>(null);
  const focusAfterTransition = useRef<"confirmation" | "account" | null>(null);
  useLayoutEffect(() => {
    const target = focusAfterTransition.current;
    if (target === "confirmation") confirmationButton.current?.focus();
    else if (target === "account") (resetTrigger.current ?? root.current)?.focus();
    focusAfterTransition.current = null;
  }, [confirmation]);
  const dismissConfirmation = (): void => {
    if (confirmationSection.current?.contains(document.activeElement)) focusAfterTransition.current = "account";
    set({ confirmation: null, uncertain: false });
  };
  const prepare = async (): Promise<void> => {
    if (busy) return;
    set({ busy: true, message: null });
    try {
      const result = resultEvent(await request({ type: "usage.reset.prepare", payload: { accountId: account.id } })).result;
      if (result.kind !== "usage.reset.confirmation") throw new Error();
      if (document.activeElement === resetTrigger.current || document.activeElement === confirmationButton.current) focusAfterTransition.current = "confirmation";
      set({ confirmation: result.confirmation, uncertain: uncertain || account.pendingReset === true, renewRequired: false });
    } catch { set({ message: "Confirmation unavailable. Refresh this account and try again." }); }
    finally { set({ busy: false }); }
  };
  const consume = async (): Promise<void> => {
    if (!confirmation || busy) return;
    if (Date.parse(confirmation.expiresAt) <= Date.now()) { set({ renewRequired: true, message: USAGE_RESET_CONFIRMATION_EXPIRED }); return; }
    set({ busy: true, message: null });
    try {
      const result = resultEvent(await request({ type: "usage.reset.confirm", payload: { confirmationId: confirmation.id, confirmed: true } })).result;
      if (result.kind !== "usage.reset.outcome") throw new Error();
      set({ message: OUTCOME_MESSAGE[result.outcome] });
      dismissConfirmation(); onRefresh();
    } catch (error) {
      if (error instanceof Error && error.message === USAGE_RESET_CONFIRMATION_EXPIRED) {
        set({ renewRequired: true, message: USAGE_RESET_CONFIRMATION_EXPIRED });
      } else set({ uncertain: true, message: "The result is uncertain. Retry this attempt; do not start another reset." });
    }
    finally { set({ busy: false }); }
  };
  const resetButton = (account.canReset || account.pendingReset) && !confirmation
    ? <button ref={resetTrigger} type="button" className="secondary-button" disabled={!online} aria-disabled={busy || !online} onClick={() => void prepare()}>{account.pendingReset ? "Check pending reset" : "Use reset"}</button>
    : null;
  const title = number === null ? account.label : `${account.label} ${number}`;
  const updated = ageLabel(account.updatedAt, now);
  return (
    <div ref={root} id={id} className="limit-account-details" role="group" aria-label={`${title} details`} tabIndex={-1}>
      <header>
        <strong>{title}</strong>
        <span className={`limits-state is-${account.status}`}>{account.status}{account.status === "stale" && updated ? ` · updated ${updated}` : ""}</span>
      </header>
      <dl>
        <div><dt>Account</dt><dd>{account.email ? <>{revealed ? account.email : "Email hidden"} <button type="button" className="limit-inline-button" onClick={() => setRevealed(!revealed)}>{revealed ? "Hide" : "Reveal"}</button></> : "Not reported"}</dd></div>
        <div><dt>Plan</dt><dd>{account.plan ?? "Not reported"}</dd></div>
        <div><dt>Seen via</dt><dd>{account.sources.join(" · ")}</dd></div>
        <div><dt>Updated</dt><dd>{dateLabel(account.updatedAt)}</dd></div>
        <div><dt>Last checked</dt><dd>{dateLabel(account.checkedAt)}</dd></div>
      </dl>
      {!account.identityKey && <p>Identity unverified; this account stays separate to avoid double counting.</p>}
      {account.detail && <p>{account.detail}</p>}
      {account.windows.length > 0 && (
        <ul className="limit-detail-windows">
          {account.windows.map((window) => {
            const remaining = limitRemaining(window.remainingPercent);
            return (
              <li key={window.id}>
                <strong>{window.label}</strong>
                <span>{remaining === null ? "Unavailable" : `${remaining}%`} remaining</span>
                <span>{limitResetText(limitCountdown(window.resetsAt, now)) ?? "Reset time unavailable"}</span>
                <time>{dateLabel(window.resetsAt)}</time>
              </li>
            );
          })}
        </ul>
      )}
      {account.credits ? (
        <div className="limit-credits">
          <span>
            <strong>{plural(account.credits.availableCount, "banked reset")}</strong>
            <small>{account.credits.expiresAt ? `Next expires ${dateLabel(account.credits.expiresAt)}` : "Expiry not reported"}</small>
          </span>
          {!account.canReset && account.credits.availableCount > 0 && <small>Refresh to verify this account and its reset capability.</small>}
          {resetButton}
        </div>
      ) : <p>Reset credits not reported.</p>}
      {!account.credits && resetButton}
      {confirmation && (
        <section ref={confirmationSection} className="limit-reset-confirmation" aria-label="Confirm account reset">
          <strong>{uncertain ? "Check the original reset attempt?" : "Use one banked Codex reset?"}</strong>
          <p>{confirmation.email ?? confirmation.accountLabel} · {confirmation.plan ?? "Plan not reported"} · {account.sources.join(" · ")}</p>
          <p>{uncertain ? "This checks the original request for this account. It will not select a new credit." : "This asks Codex to reset eligible quota windows for this account. It can consume one credit."}</p>
          {expired && <p>Confirmation expired. Renew it to check the account again.</p>}
          <div>
            <button ref={confirmationButton} type="button" className="primary-button" disabled={!online} aria-disabled={busy || !online} onClick={() => void (expired ? prepare() : consume())}>{busy ? "Checking…" : expired ? "Renew confirmation" : uncertain ? "Retry same reset" : "Confirm reset"}</button>
            <button type="button" className="secondary-button" disabled={busy} onClick={dismissConfirmation}>Cancel</button>
          </div>
        </section>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
