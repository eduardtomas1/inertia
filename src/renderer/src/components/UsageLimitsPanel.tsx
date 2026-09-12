import { useCallback, useEffect, useId, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import type { ServerEvent } from "@shared/contracts";
import { usageSourceOrigin, usageSourceProfileId, type UsageAccount, type UsageLimitsSnapshot, type UsageResetConfirmation } from "@shared/provider-usage-limits";
import { deduplicateUsageAccounts, usagePools } from "@shared/usage-limits-projection";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { resultEvent } from "../lib/runtimeCommands";
import type { ConnectionStatus } from "../hooks/useInertiaConnection";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { trapModalFocus } from "../utils/modalFocus";
import { useUsageLimitsContext } from "./usage-limits-state";
import "./UsageLimitsPanel.css";

export function resetCountdown(value: string | null, now: number): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Reset time unavailable";
  const minutes = Math.ceil((Date.parse(value) - now) / 60000);
  if (minutes <= 0) return "Reset due · refresh to check";
  if (minutes < 60) return `in ${minutes}m`;
  if (minutes < 1440) return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `in ${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`;
}
const dateLabel = (value: string | null): string => value ? new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : "Not reported";
const percent = (value: number | null): string => value === null ? "Unavailable" : `${Math.round(value)}%`;
type Props = { request(command: CommandWithoutId): Promise<ServerEvent>; status: ConnectionStatus; compact?: boolean };

function AccountDetails({ account, number, now, selected, onSelect, request, onRefresh, online }: {
  account: UsageAccount; number: number; now: number; selected: boolean; onSelect(): void;
  request: Props["request"]; onRefresh(): void; online: boolean;
}): React.JSX.Element {
  const [revealed, setRevealed] = useState(false);
  const [confirmation, setConfirmation] = useState<UsageResetConfirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const id = useId();
  const prepare = async (): Promise<void> => {
    setBusy(true); setMessage(null);
    try {
      const result = resultEvent(await request({ type: "usage.reset.prepare", payload: { accountId: account.id } })).result;
      if (result.kind !== "usage.reset.confirmation") throw new Error();
      setConfirmation(result.confirmation); setUncertain(account.pendingReset === true);
    } catch { setMessage("Reset confirmation could not be prepared. Refresh this account and try again."); }
    finally { setBusy(false); }
  };
  const consume = async (): Promise<void> => {
    if (!confirmation) return;
    setBusy(true); setMessage(null);
    try {
      const result = resultEvent(await request({ type: "usage.reset.confirm", payload: { confirmationId: confirmation.id, confirmed: true } })).result;
      if (result.kind !== "usage.reset.outcome") throw new Error();
      setMessage({ reset: "One reset was applied. Refreshing quota…", alreadyRedeemed: "This reset was already applied. Refreshing quota…", nothingToReset: "No eligible window needed a reset. No credit was used.", noCredit: "The provider reported no available reset credit." }[result.outcome]);
      setConfirmation(null); setUncertain(false); onRefresh();
    } catch { setUncertain(true); setMessage("The result is uncertain. Retry the same attempt to check it safely. Do not start another reset."); }
    finally { setBusy(false); }
  };
  return <div className="limits-account">
    <button type="button" className="limits-account-trigger" aria-expanded={selected} aria-controls={id} onClick={onSelect}>
      <span className="limits-account-number">{number}</span><strong>{account.label}</strong><span>{account.plan ?? "Plan not reported"}</span><span className={`limits-state is-${account.status}`}>{account.status}</span>
      <span>{account.credits ? `${account.credits.availableCount} reset${account.credits.availableCount === 1 ? "" : "s"}` : ""}</span>
    </button>
    {selected && <div className="limits-account-detail" id={id}>
      <dl><div><dt>Account</dt><dd>{account.email ? <>{revealed ? account.email : "Email hidden"} <button type="button" onClick={() => setRevealed(!revealed)}>{revealed ? "Hide" : "Reveal"}</button></> : "Not reported"}</dd></div>
        <div><dt>Plan</dt><dd>{account.plan ?? "Not reported"}</dd></div><div><dt>Seen via</dt><dd>{account.sources.join(" · ")}</dd></div>
        <div><dt>Updated</dt><dd>{dateLabel(account.updatedAt)}</dd></div>
        <div><dt>Last checked</dt><dd>{dateLabel(account.checkedAt)}</dd></div></dl>
      {!account.identityKey && <p>Account identity is unverified. This account is excluded from pooled averages to avoid counting it twice.</p>}
      {account.detail && <p>{account.detail}</p>}
      {account.windows.map((window) => <div className="limits-detail-window" key={window.id}><strong>{window.label}</strong><span>{percent(window.remainingPercent)} remaining</span><span>{resetCountdown(window.resetsAt, now)}</span><time>{dateLabel(window.resetsAt)}</time></div>)}
      {account.credits ? <div className="limits-credits"><span><strong>{account.credits.availableCount} banked reset{account.credits.availableCount === 1 ? "" : "s"}</strong><small>{account.credits.expiresAt ? `Next expires ${dateLabel(account.credits.expiresAt)}` : "Expiry not reported"}</small></span>
        {!account.canReset && account.credits.availableCount > 0 && <small>Refresh to verify this account and its reset capability.</small>}
      </div> : <p>Reset credits are not reported by this connection.</p>}
      {(account.canReset || account.pendingReset) && !confirmation && <button type="button" disabled={busy || !online} onClick={() => void prepare()}>{account.pendingReset ? "Check pending reset" : "Use reset"}</button>}
      {confirmation && <section className="limits-reset-confirmation" aria-label="Confirm account reset">
        <strong>{uncertain ? "Check the original reset attempt?" : "Use one banked Codex reset?"}</strong><p>{confirmation.email ?? confirmation.accountLabel} · {confirmation.plan ?? "Plan not reported"} · {account.sources.join(" · ")}</p>
        <p>{uncertain ? "This retries the original account-bound request with the same idempotency key. It does not start a new reset attempt." : "This asks Codex to reset eligible quota windows for this account. It can consume one credit."}</p>
        <button type="button" disabled={busy || !online} onClick={() => void consume()}>{busy ? "Checking…" : uncertain ? "Retry same reset" : "Confirm reset"}</button>
        <button type="button" disabled={busy} onClick={() => { setConfirmation(null); setUncertain(false); }}>Cancel</button>
      </section>}
      {message && <p role="status">{message}</p>}
    </div>}
  </div>;
}

function UsageSources({ snapshot, request, onChange, online }: { snapshot: UsageLimitsSnapshot | null; request: Props["request"]; onChange(): void; online: boolean }): React.JSX.Element {
  const [label, setLabel] = useState(""); const [url, setUrl] = useState(""); const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    const origin = usageSourceOrigin(url.trim());
    if (!origin) { setError("Use an HTTPS origin or HTTP on localhost, without a path or credentials."); return; }
    setBusy(true); setError(null);
    const id = crypto.randomUUID(); const profileId = usageSourceProfileId(id);
    let stored = false;
    try {
      const state = await window.inertia.setBackendCredential({ profileId, secret: key });
      if (!state.hasSecret || !state.storage.available) throw new Error();
      stored = true; setKey("");
      resultEvent(await request({ type: "usage.source.save", payload: { id, label: label.trim() || "CLIProxyAPI hub", url: origin, enabled: true } }));
      setLabel(""); setUrl(""); onChange();
    } catch {
      // A timed-out save might have committed. Keep its vault slot for the configured source.
      setError(stored ? "Hub save could not be confirmed. Refresh sources before trying again." : "The management key could not be saved in secure storage.");
      onChange();
    } finally { setBusy(false); }
  };
  const remove = async (id: string): Promise<void> => {
    setBusy(true); setError(null);
    try { resultEvent(await request({ type: "usage.source.remove", payload: { id } })); onChange(); }
    catch { setError("Hub removal could not be confirmed. Refresh to check."); }
    finally { setBusy(false); }
  };
  return <details className="limits-sources"><summary>Usage sources <span>{snapshot?.sources.length ?? 0} hubs</span></summary>
    <p>Optional CLIProxyAPI hubs add account usage. They do not change where agents run. Management keys stay in secure credential storage.</p>
    {snapshot?.sources.map((source) => <div className="limits-source-row" key={source.id}><span><strong>{source.label}</strong><small>{source.url} · {source.enabled ? "Enabled" : "Disabled"}</small>{source.error && <small role="status">{source.error}</small>}</span><button type="button" disabled={busy || !online} onClick={() => void remove(source.id)}>Remove</button></div>)}
    <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label>Hub name<input value={label} maxLength={200} onChange={(event) => setLabel(event.target.value)} placeholder="Home hub" /></label>
      <label>Hub URL<input value={url} maxLength={2048} onChange={(event) => setUrl(event.target.value)} placeholder="https://hub.example.com" required /></label>
      <label>Management key<input type="password" value={key} maxLength={16384} autoComplete="off" spellCheck={false} onChange={(event) => setKey(event.target.value)} required /></label>
      <button type="submit" disabled={busy || !online || !key || (snapshot?.sources.length ?? 0) >= 4}>{busy ? "Saving…" : "Add hub"}</button>
    </form>{error && <p role="alert">{error}</p>}
  </details>;
}

export function UsageLimitsPanel({ request, status, compact = false }: Props): React.JSX.Element {
  const context = useUsageLimitsContext();
  const [snapshot, setSnapshot] = useState<UsageLimitsSnapshot | null>(context?.snapshot ?? null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null); const [now, setNow] = useState(Date.now);
  const alive = useRef(true); const pending = useRef(false); const publish = context?.setSnapshot;
  const load = useCallback(async (refresh: boolean, force = false): Promise<void> => {
    if (pending.current || status !== "online") return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const result = resultEvent(await request({ type: "usage.limits.get", payload: { refresh, force } })).result;
      if (result.kind !== "usage.limits") throw new Error();
      if (alive.current) { setSnapshot(result.snapshot); publish?.(result.snapshot); setNow(Date.now()); }
    } catch { if (alive.current) setError("Limits could not be refreshed. Previously reported values may be out of date."); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }, [request, status, publish]);
  useEffect(() => {
    alive.current = true;
    if (document.visibilityState !== "hidden") void load(!compact);
    let timer: ReturnType<typeof setInterval> | undefined;
    let ticks = 0;
    const visibility = (): void => {
      if (timer) clearInterval(timer);
      if (document.visibilityState === "hidden") return;
      setNow(Date.now());
      timer = setInterval(() => { setNow(Date.now()); ticks += 1; if (!compact && ticks % 3 === 0) void load(true); }, 60000);
    };
    visibility(); document.addEventListener("visibilitychange", visibility);
    return () => { alive.current = false; if (timer) clearInterval(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [load, compact]);
  const accounts = deduplicateUsageAccounts((snapshot?.accounts ?? []).map((account) => account.status === "ready" && (
    error || status !== "online" || now - Date.parse(account.updatedAt ?? "") > 180000 || account.windows.some((window) => window.resetsAt && Date.parse(window.resetsAt) <= now))
    ? { ...account, status: "stale", canReset: false } : account));
  const providerIds = [...new Set(accounts.map(({ providerId }) => providerId))];
  return <section className="usage-limits-panel" aria-label="Provider limits" aria-busy={busy}>
    <header className="limits-heading"><div><h2>Limits</h2><p>Subscription quota across your accounts.</p></div><button type="button" disabled={busy || status !== "online"} onClick={() => void load(true, true)}><RefreshCw size={14} aria-hidden="true" />{busy ? "Refreshing…" : "Refresh limits"}</button></header>
    <p className="limits-explanation">Remaining percentages describe provider quota. Account averages give each equivalent account equal weight; they do not estimate tokens or combined plan capacity.</p>
    {status !== "online" && <p role="status">The local service is offline. Displayed limits may be stale.</p>}
    {error && <p role="alert">{error}</p>}
    {accounts.length === 0 && <p className="limits-empty">{busy ? "Reading provider accounts…" : "No account limits loaded. Refresh to check configured providers or connect a usage hub."}</p>}
    {providerIds.map((providerId) => {
      const providerAccounts = accounts.filter((account) => account.providerId === providerId);
      return <section className="limits-provider" key={providerId} aria-label={`${providerAccounts[0]!.providerLabel} limits`}>
        <h3>{providerAccounts[0]!.providerLabel}<span>{providerAccounts.length} account{providerAccounts.length === 1 ? "" : "s"}</span></h3>
        {usagePools(providerAccounts).map((pool) => <div className="limits-window" key={pool.key}>
          <div className="limits-window-summary"><span>{pool.label}{pool.entries.length > 1 && pool.plan ? ` · ${pool.plan}` : ""}</span><strong>{percent(pool.averageRemaining)} <small>left</small></strong><small>{pool.entries.length > 1 ? `Account average${pool.entries.some(({ account }) => account.status === "stale") ? " · stale" : ""}` : pool.entries[0]?.account.status === "stale" ? "Stale observation" : "Reported quota"}</small></div>
          <div className="limits-segments">{pool.entries.map(({ account, window }) => {
            const number = providerAccounts.findIndex(({ id }) => id === account.id) + 1;
            return <button type="button" className={`limits-segment${account.status === "stale" ? " is-stale" : ""}`} key={account.id} onClick={() => setSelected(account.id)} aria-label={`Account ${number}, ${window.label}, ${percent(window.remainingPercent)} remaining. Show account details.`}>
              <span><b>{number}</b><strong>{percent(window.remainingPercent)}</strong><small>{resetCountdown(window.resetsAt, now)}</small></span>
              {window.remainingPercent === null ? <span className="limits-meter-unavailable">Quota not reported</span> : <span className="limits-meter" aria-hidden="true"><i style={{ width: `${window.remainingPercent}%` }} /></span>}
            </button>;
          })}</div>
        </div>)}
        <div className="limits-accounts">{providerAccounts.map((account, index) => <AccountDetails key={account.id} account={account} number={index + 1} now={now} selected={selected === account.id} onSelect={() => setSelected(selected === account.id ? null : account.id)} request={request} onRefresh={() => void load(true, true)} online={status === "online"} />)}</div>
      </section>;
    })}
    <footer className="limits-footer">Last refresh {dateLabel(snapshot?.checkedAt ?? null)}. Passed reset times remain due until the provider confirms new quota.</footer>
    <UsageSources snapshot={snapshot} request={request} online={status === "online"} onChange={() => void load(true, true)} />
  </section>;
}

export function UsageLimitsDialog({ onClose }: { onClose(): void }): React.JSX.Element | null {
  const context = useUsageLimitsContext(); const dialog = useRef<HTMLElement>(null);
  useNativePreviewSuspension(true);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  if (!context) return null;
  return <div className="dialog-backdrop limits-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialog} role="dialog" aria-modal="true" aria-label="Provider usage limits" className="limits-dialog" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } else trapModalFocus(event, event.currentTarget); }}>
      <button type="button" className="limits-dialog-close" aria-label="Close provider limits" onClick={onClose}><X size={18} /></button>
      <UsageLimitsPanel request={context.request} status={context.status} compact />
    </section>
  </div>;
}
