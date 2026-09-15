import { INTERFACE_LOCALE } from "../lib/locale";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronDown, Info, RefreshCw, X } from "lucide-react";
import type { ServerEvent } from "@shared/contracts";
import { USAGE_RESET_CONFIRMATION_EXPIRED, usageSourceOrigin, usageSourceProfileId, type UsageAccount, type UsageLimitsSnapshot, type UsageResetConfirmation } from "@shared/provider-usage-limits";
import { deduplicateUsageAccounts, usagePools, type UsagePool } from "@shared/usage-limits-projection";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { resultEvent } from "../lib/runtimeCommands";
import type { ConnectionStatus } from "../hooks/useInertiaConnection";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { trapModalFocus } from "../utils/modalFocus";
import { ProviderBrandIcon } from "./ProviderBrandIcon";
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
const dateLabel = (value: string | null): string => value ? new Date(value).toLocaleString(INTERFACE_LOCALE, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }) : "Not reported";
const percent = (value: number | null): string => value === null ? "Unavailable" : `${Math.round(value)}%`;
function ageLabel(value: string | null, now: number): string | null {
  const time = Date.parse(value ?? "");
  if (!Number.isFinite(time)) return null;
  const minutes = Math.max(0, Math.floor((now - time) / 60000));
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
}
export type LimitTone = "ok" | "low" | "critical" | "stale" | "unknown";
export function limitTone(remaining: number | null, stale: boolean): LimitTone {
  if (stale) return "stale";
  if (remaining === null) return "unknown";
  return remaining < 20 ? "critical" : remaining < 50 ? "low" : "ok";
}
function ProviderLogo({ providerId }: { providerId: string }): React.JSX.Element {
  return <span className="limits-logo" aria-hidden="true"><ProviderBrandIcon providerId={providerId} decorative size={18} /></span>;
}
type Props = { request(command: CommandWithoutId): Promise<ServerEvent>; status: ConnectionStatus; compact?: boolean };
type LimitCellValue = { key: string; label: string; value: number | null; resetsAt: string | null; stale: boolean; accounts: number };

function poolCells(pools: UsagePool[], account?: UsageAccount): Array<LimitCellValue | null> {
  return pools.map((pool) => {
    const entries = account ? pool.entries.filter((entry) => entry.account.id === account.id) : pool.entries;
    if (entries.length === 0) return null;
    const shared = pool.plan && pools.some((other) => other !== pool && other.label === pool.label);
    return {
      key: pool.key, label: shared ? `${pool.label} · ${pool.plan}` : pool.label,
      value: account ? entries[0]!.window.remainingPercent : pool.averageRemaining,
      resetsAt: entries.reduce<string | null>((soonest, { window }) => window.resetsAt && (!soonest || Date.parse(window.resetsAt) < Date.parse(soonest)) ? window.resetsAt : soonest, null),
      stale: entries.some((entry) => entry.account.status === "stale"), accounts: entries.length,
    };
  });
}

function LimitCells({ cells, now }: { cells: Array<LimitCellValue | null>; now: number }): React.JSX.Element {
  if (cells.length === 0) return <span className="limits-cells"><span className="limits-cell-empty">Quota not reported</span></span>;
  return <span className="limits-cells">{cells.map((cell, index) => cell === null
    ? <span className="limits-cell" data-tone="unknown" key={`absent-${index}`} aria-hidden="true" />
    : <span className="limits-cell" data-tone={limitTone(cell.value, cell.stale)} key={cell.key} style={{ "--c": index } as CSSProperties}>
      <span className="limits-cell-label">{cell.label}</span>
      <strong>{cell.value === null ? "Not reported" : `${Math.round(cell.value)}%`}{cell.value !== null && <small>{cell.accounts > 1 ? ` avg of ${cell.accounts}` : " left"}</small>}</strong>
      {(cell.value !== null || cell.resetsAt) && <small className="limits-cell-reset">{cell.stale ? "Stale · " : ""}{resetCountdown(cell.resetsAt, now)}</small>}
      <span className="limits-meter" aria-hidden="true">{cell.value !== null && <i style={{ "--limit": `${cell.value}%` } as CSSProperties} />}</span>
    </span>)}</span>;
}

function AccountDetails({ account, number, cells, now, selected, onSelect, request, onRefresh, online }: {
  account: UsageAccount; number: number; cells: Array<LimitCellValue | null>; now: number; selected: boolean; onSelect(): void;
  request: Props["request"]; onRefresh(): void; online: boolean;
}): React.JSX.Element {
  const [revealed, setRevealed] = useState(false);
  const [confirmation, setConfirmation] = useState<UsageResetConfirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [renewRequired, setRenewRequired] = useState(false);
  const expired = Boolean(confirmation && (renewRequired || Date.parse(confirmation.expiresAt) <= now));
  const id = useId();
  const resetTrigger = useRef<HTMLButtonElement>(null);
  const accountTrigger = useRef<HTMLButtonElement>(null);
  const confirmationButton = useRef<HTMLButtonElement>(null);
  const confirmationSection = useRef<HTMLElement>(null);
  const focusAfterTransition = useRef<"confirmation" | "account" | null>(null);
  useLayoutEffect(() => {
    const target = focusAfterTransition.current;
    if (target) (target === "confirmation" ? confirmationButton : accountTrigger).current?.focus();
    focusAfterTransition.current = null;
  }, [confirmation]);
  const dismissConfirmation = (): void => {
    if (confirmationSection.current?.contains(document.activeElement)) focusAfterTransition.current = "account";
    setConfirmation(null); setUncertain(false);
  };
  const prepare = async (): Promise<void> => {
    if (busy) return;
    setBusy(true); setMessage(null);
    try {
      const result = resultEvent(await request({ type: "usage.reset.prepare", payload: { accountId: account.id } })).result;
      if (result.kind !== "usage.reset.confirmation") throw new Error();
      if (document.activeElement === resetTrigger.current || document.activeElement === confirmationButton.current) focusAfterTransition.current = "confirmation";
      setConfirmation(result.confirmation); setUncertain(uncertain || account.pendingReset === true); setRenewRequired(false);
    } catch { setMessage("Confirmation unavailable. Refresh this account and try again."); }
    finally { setBusy(false); }
  };
  const consume = async (): Promise<void> => {
    if (!confirmation || busy) return;
    if (Date.parse(confirmation.expiresAt) <= Date.now()) { setRenewRequired(true); setMessage(USAGE_RESET_CONFIRMATION_EXPIRED); return; }
    setBusy(true); setMessage(null);
    try {
      const result = resultEvent(await request({ type: "usage.reset.confirm", payload: { confirmationId: confirmation.id, confirmed: true } })).result;
      if (result.kind !== "usage.reset.outcome") throw new Error();
      setMessage({ reset: "One reset was applied. Refreshing quota…", alreadyRedeemed: "This reset was already applied. Refreshing quota…", nothingToReset: "No eligible window needed a reset. No credit was used.", noCredit: "The provider reported no available reset credit." }[result.outcome]);
      dismissConfirmation(); onRefresh();
    } catch (error) {
      if (error instanceof Error && error.message === USAGE_RESET_CONFIRMATION_EXPIRED) {
        setRenewRequired(true); setMessage(USAGE_RESET_CONFIRMATION_EXPIRED);
      } else { setUncertain(true); setMessage("The result is uncertain. Retry this attempt; do not start another reset."); }
    }
    finally { setBusy(false); }
  };
  return <div className="limits-account">
    <button ref={accountTrigger} type="button" className="limits-account-trigger" aria-expanded={selected} aria-controls={id} onClick={onSelect}>
      <span className="limits-account-number">{number}</span>
      <span className="limits-account-name"><strong>{account.label}</strong><span>{account.plan ?? "Plan not reported"}</span><span className={`limits-state is-${account.status}`}>{account.status}</span><span>{account.credits ? `${account.credits.availableCount} reset${account.credits.availableCount === 1 ? "" : "s"}` : ""}</span></span>
      <LimitCells cells={cells} now={now} />
      <ChevronDown className="limits-chevron" size={14} aria-hidden="true" />
    </button>
    {selected && <div className="limits-account-detail" id={id}>
      <dl><div><dt>Account</dt><dd>{account.email ? <>{revealed ? account.email : "Email hidden"} <button type="button" onClick={() => setRevealed(!revealed)}>{revealed ? "Hide" : "Reveal"}</button></> : "Not reported"}</dd></div>
        <div><dt>Plan</dt><dd>{account.plan ?? "Not reported"}</dd></div><div><dt>Seen via</dt><dd>{account.sources.join(" · ")}</dd></div>
        <div><dt>Updated</dt><dd>{dateLabel(account.updatedAt)}</dd></div>
        <div><dt>Last checked</dt><dd>{dateLabel(account.checkedAt)}</dd></div></dl>
      {!account.identityKey && <p>Identity unverified; this account stays separate to avoid double counting.</p>}
      {account.detail && <p>{account.detail}</p>}
      {account.windows.map((window) => <div className="limits-detail-window" key={window.id}><strong>{window.label}</strong><span>{percent(window.remainingPercent)} remaining</span><span>{resetCountdown(window.resetsAt, now)}</span><time>{dateLabel(window.resetsAt)}</time></div>)}
      {account.credits ? <div className="limits-credits"><span><strong>{account.credits.availableCount} banked reset{account.credits.availableCount === 1 ? "" : "s"}</strong><small>{account.credits.expiresAt ? `Next expires ${dateLabel(account.credits.expiresAt)}` : "Expiry not reported"}</small></span>
        {!account.canReset && account.credits.availableCount > 0 && <small>Refresh to verify this account and its reset capability.</small>}
        {(account.canReset || account.pendingReset) && !confirmation && <button ref={resetTrigger} type="button" disabled={!online} aria-disabled={busy || !online} onClick={() => void prepare()}>{account.pendingReset ? "Check pending reset" : "Use reset"}</button>}
      </div> : <p>Reset credits not reported.</p>}
      {!account.credits && (account.canReset || account.pendingReset) && !confirmation && <button ref={resetTrigger} type="button" disabled={!online} aria-disabled={busy || !online} onClick={() => void prepare()}>{account.pendingReset ? "Check pending reset" : "Use reset"}</button>}
      {confirmation && <section ref={confirmationSection} className="limits-reset-confirmation" aria-label="Confirm account reset">
        <strong>{uncertain ? "Check the original reset attempt?" : "Use one banked Codex reset?"}</strong><p>{confirmation.email ?? confirmation.accountLabel} · {confirmation.plan ?? "Plan not reported"} · {account.sources.join(" · ")}</p>
        <p>{uncertain ? "This checks the original request for this account. It will not select a new credit." : "This asks Codex to reset eligible quota windows for this account. It can consume one credit."}</p>
        {expired && <p>Confirmation expired. Renew it to check the account again.</p>}
        <button ref={confirmationButton} type="button" disabled={!online} aria-disabled={busy || !online} onClick={() => void (expired ? prepare() : consume())}>{busy ? "Checking…" : expired ? "Renew confirmation" : uncertain ? "Retry same reset" : "Confirm reset"}</button>
        <button type="button" disabled={busy} onClick={dismissConfirmation}>Cancel</button>
      </section>}
      {message && <p role="status">{message}</p>}
    </div>}
  </div>;
}

function ProviderLimits({ accounts, index, now, open, onToggle, renderAccount }: {
  accounts: UsageAccount[]; index: number; now: number; open: boolean; onToggle(): void;
  renderAccount(account: UsageAccount, number: number, cells: Array<LimitCellValue | null>): React.ReactNode;
}): React.JSX.Element {
  const id = useId();
  const pools = usagePools(accounts);
  const { providerId, providerLabel } = accounts[0]!;
  const credits = accounts.reduce((total, account) => total + (account.credits?.availableCount ?? 0), 0);
  const summary = [...new Set(accounts.flatMap(({ plan }) => plan ? [plan] : [])), credits ? `${credits} banked reset${credits === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
  return <section className="limits-provider" aria-label={`${providerLabel} limits`} data-open={open ? "" : undefined} style={{ "--cols": Math.max(pools.length, 1), "--i": index } as CSSProperties}>
    <div className="limits-strip">
      <ProviderLogo providerId={providerId} />
      <div className="limits-strip-name"><h3>{providerLabel}<span>{accounts.length} account{accounts.length === 1 ? "" : "s"}</span></h3><small>{summary || "Plan not reported"}</small></div>
      <LimitCells cells={poolCells(pools)} now={now} />
      <button type="button" className="limits-strip-toggle" aria-expanded={open} aria-controls={id} aria-label={`${open ? "Hide" : "Show"} ${providerLabel} accounts`} onClick={onToggle}><ChevronDown size={16} aria-hidden="true" /></button>
    </div>
    <div className="limits-strip-accounts" id={id} inert={!open}><div>{accounts.map((account, number) => renderAccount(account, number + 1, poolCells(pools, account)))}</div></div>
  </section>;
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
  return <details className="limits-sources"><summary>Usage sources <span>{snapshot?.sources.length ?? 0} hub{snapshot?.sources.length === 1 ? "" : "s"}</span></summary>
    <p>CLIProxyAPI hubs add usage without changing agent routing. Keys stay in secure storage.</p>
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
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [about, setAbout] = useState(false); const aboutId = useId();
  const alive = useRef(true); const pending = useRef(false); const publish = context?.setSnapshot;
  const load = useCallback(async (refresh: boolean, force = false): Promise<void> => {
    if (pending.current || status !== "online") return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const result = resultEvent(await request({ type: "usage.limits.get", payload: { refresh, force } })).result;
      if (result.kind !== "usage.limits") throw new Error();
      if (alive.current) { setSnapshot(result.snapshot); publish?.(result.snapshot); setNow(Date.now()); }
    } catch { if (alive.current) setError("Refresh failed. Previously reported limits may be stale."); }
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
  const checked = ageLabel(snapshot?.checkedAt ?? null, now);
  const toggle = (providerId: string): void => setExpanded((current) => {
    const next = new Set(current);
    if (!next.delete(providerId)) next.add(providerId);
    return next;
  });
  return <section className="usage-limits-panel" aria-label="Provider limits" aria-busy={busy}>
    <header className="limits-heading">
      <div className="limits-title"><h2>Limits</h2><button type="button" className="limits-about" aria-label="About these numbers" aria-expanded={about} aria-controls={aboutId} onClick={() => setAbout(!about)}><Info size={14} aria-hidden="true" /></button></div>
      <small className="limits-checked" title={snapshot?.checkedAt ? dateLabel(snapshot.checkedAt) : undefined}>{checked ? `Checked ${checked}` : "Not checked yet"}</small>
      <button type="button" className="limits-refresh" disabled={busy || status !== "online"} onClick={() => void load(true, true)}><RefreshCw size={14} aria-hidden="true" />{busy ? "Refreshing…" : "Refresh limits"}</button>
    </header>
    <p className="limits-explanation" id={aboutId} hidden={!about}>Subscription quota across your accounts. Remaining percentages describe provider quota. Account averages give each equivalent account equal weight; they do not estimate tokens or combined plan capacity. Reset times stay due until the provider reports new quota.</p>
    {status !== "online" && <p className="limits-notice" role="status">The local service is offline. Displayed limits may be stale.</p>}
    {error && <p className="limits-notice" role="alert">{error}</p>}
    {accounts.length === 0 && (busy
      ? <><p className="visually-hidden" role="status">Reading provider accounts…</p><div className="limits-skeleton" aria-hidden="true">{[0, 1, 2].map((index) => <span key={index} style={{ "--i": index } as CSSProperties}><i /><b /><em /><em /></span>)}</div></>
      : <p className="limits-empty">No limits loaded. Refresh configured providers or connect a usage hub.</p>)}
    {providerIds.map((providerId, index) => <ProviderLimits key={providerId} accounts={accounts.filter((account) => account.providerId === providerId)} index={index} now={now}
      open={expanded.has(providerId)} onToggle={() => toggle(providerId)}
      renderAccount={(account, number, cells) => <AccountDetails key={account.id} account={account} number={number} cells={cells} now={now} selected={selected === account.id} onSelect={() => setSelected(selected === account.id ? null : account.id)} request={request} onRefresh={() => void load(true, true)} online={status === "online"} />} />)}
    <UsageSources snapshot={snapshot} request={request} online={status === "online"} onChange={() => void load(true, true)} />
  </section>;
}

export function UsageAccountsHint({ providerId, remaining }: { providerId: string; remaining: number }): React.JSX.Element | null {
  const context = useUsageLimitsContext();
  const snapshot = context?.snapshot ?? null; const request = context?.request; const publish = context?.setSnapshot;
  const online = context?.status === "online";
  const [now] = useState(Date.now);
  useEffect(() => {
    if (snapshot || !request || !online) return;
    let active = true;
    void request({ type: "usage.limits.get", payload: { refresh: false, force: false } }).then((event) => {
      const result = resultEvent(event).result;
      if (active && result.kind === "usage.limits") publish?.(result.snapshot);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [snapshot, request, online, publish]);
  let best: { number: number; value: number; label: string; updatedAt: string } | null = null;
  for (const [index, account] of deduplicateUsageAccounts(snapshot?.accounts ?? []).filter((candidate) => candidate.providerId === providerId).entries()) {
    if (account.status !== "ready" || !account.updatedAt || account.sources.includes("This computer") || account.windows.length === 0) continue;
    const windows = account.windows.flatMap((window) => window.remainingPercent === null ? [] : [{ label: window.label, value: window.remainingPercent }]);
    if (windows.length !== account.windows.length) continue;
    const tightest = windows.reduce((low, window) => window.value < low.value ? window : low);
    if (tightest.value > (best?.value ?? remaining)) best = { number: index + 1, ...tightest, updatedAt: account.updatedAt };
  }
  if (!best) return null;
  const age = now - Date.parse(best.updatedAt) >= 300000 ? ageLabel(best.updatedAt, now) : null;
  return <p className="usage-accounts-hint" role="status"><span>Account {best.number} has more room</span><b>{Math.round(best.value)}% · {best.label}</b>{age && <small>Checked {age}</small>}</p>;
}

export function UsageLimitsDialog({ onClose, returnFocusTo }: { onClose(): void; returnFocusTo?: HTMLElement | null }): React.JSX.Element | null {
  const context = useUsageLimitsContext(); const dialog = useRef<HTMLElement>(null);
  useNativePreviewSuspension(true);
  useEffect(() => {
    const previous = returnFocusTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [returnFocusTo]);
  if (!context) return null;
  return <div className="dialog-backdrop limits-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialog} role="dialog" aria-modal="true" aria-label="Provider usage limits" className="limits-dialog" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } else trapModalFocus(event, event.currentTarget); }}>
      <button type="button" className="limits-dialog-close" aria-label="Close provider limits" onClick={onClose}><X size={18} /></button>
      <UsageLimitsPanel request={context.request} status={context.status} compact />
    </section>
  </div>;
}
