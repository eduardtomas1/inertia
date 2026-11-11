import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronDown, Info, Ticket } from "lucide-react";
import type { ServerEvent } from "@shared/contracts";
import type { UsageAccount } from "@shared/provider-usage-limits";

import type { ConnectionStatus } from "../hooks/useInertiaConnection";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { ProviderBrandIcon } from "./ProviderBrandIcon";
import { LimitAccountDetails, IDLE_RESET_FLOW, type LimitResetFlow } from "./usage/LimitAccountDetails";
import { LimitBar, PaceIcon } from "./usage/LimitBar";
import { limitChipText, limitResetText, paceRemainingPercent } from "./usage/limitMath";
import { limitSections, type LimitCard, type LimitSection, type LimitSegment } from "./usage/limitPools";
import { ageLabel } from "./usage/limitText";
import { accountMatchesSource, ALL_USAGE_SOURCES } from "./usage/usageFilters";
import { UsageSources } from "./usage/UsageSources";
import { useUsageLimits } from "./usage/useUsageLimits";
import "./UsageLimitsPanel.css";

interface UsageLimitsPanelProps {
  request(command: CommandWithoutId): Promise<ServerEvent>;
  status: ConnectionStatus;
  hiddenProviderIds?: ReadonlySet<string>;
  source?: string;
  refreshToken?: number;
  onBusyChange?(busy: boolean): void;
}

interface CardContext {
  providerId: string;
  now: number;
  selected: string | null;
  pending: ReadonlySet<string>;
  onSelect(key: string): void;
  renderDetails(id: string, account: UsageAccount, number: number | null): React.ReactNode;
}

function accountTitle(account: UsageAccount, number: number | null): string {
  return number === null ? account.label : `${account.label} ${number}`;
}

function segmentSummary(segment: LimitSegment, multi: boolean, now: number): string {
  const { reading, countdown, credits } = segment;
  const parts = [reading.due ? "reset due" : reading.remaining === null ? "quota not reported" : `${reading.remaining}% left`];
  const reset = reading.due ? null : limitResetText(countdown);
  if (reset) parts.push(reset.toLowerCase());
  const timeLeft = paceRemainingPercent(reading, now);
  if (timeLeft !== null) parts.push(`${timeLeft}% of the window left`);
  if (credits > 0) parts.push(`${credits} reset ${credits === 1 ? "credit" : "credits"} banked`);
  return `${accountTitle(segment.account, multi ? segment.number : null)}: ${parts.join(", ")}`;
}

function LimitChip({ segment }: { segment: LimitSegment }): React.JSX.Element | null {
  const text = limitChipText(segment.countdown);
  if (!text && segment.credits === 0) return null;
  return (
    <span className="limit-chip">
      {text}
      {segment.credits > 0 && (
        <>
          {text && <span className="limit-chip-separator" aria-hidden="true">·</span>}
          <span className="limit-chip-credits"><Ticket size={14} aria-hidden="true" />{segment.credits}</span>
        </>
      )}
    </span>
  );
}

function LimitCardView({ card, context }: { card: LimitCard; context: CardContext }): React.JSX.Element {
  const baseId = useId();
  const multi = card.columns.length > 1;
  const { now, pending, selected } = context;
  const refreshing = card.segments.some(({ account }) => pending.has(account.id));
  const open = card.segments.find(({ account }) => selected === `${card.key}\n${account.id}`) ?? null;
  const detailsId = `${baseId}-details`;
  const toggle = (segment: LimitSegment) => ({
    "aria-expanded": open === segment,
    "aria-controls": open === segment ? detailsId : undefined,
    onClick: () => context.onSelect(`${card.key}\n${segment.account.id}`),
  });
  return (
    <div className="limit-card" data-stale={card.stale || undefined}>
      <div className="limit-card-meta">
        <span className="limit-card-label">{card.label}</span>
        <span className="limit-card-figure" data-refreshing={refreshing || undefined}>
          {card.due
            ? <><strong>Reset</strong><span className="limit-card-left">due</span></>
            : card.remaining === null
              ? <strong className="is-unknown">Not reported</strong>
              : <><strong>{card.remaining}%</strong><span className="limit-card-left">left{card.pace && <PaceIcon pace={card.pace} />}</span></>}
        </span>
        {card.nextRestore !== null && <span className="limit-card-refill">↻ +{card.nextRestore}%</span>}
        {card.stale && !refreshing && <span className="limit-card-note">Stale</span>}
      </div>
      <div className="limit-card-bars" style={{ "--limit-columns": card.columns.length } as CSSProperties}>
        {card.columns.map((segment, index) => segment ? (
          <button
            type="button"
            className="limit-segment"
            key={segment.account.id}
            style={{ gridColumn: index + 1 }}
            aria-label={segmentSummary(segment, multi, now)}
            data-refreshing={pending.has(segment.account.id) || undefined}
            {...toggle(segment)}
          >
            <LimitBar providerId={context.providerId} reading={segment.reading} now={now} muted={segment.stale && !pending.has(segment.account.id)}>
              {multi && <span className="limit-segment-index" aria-hidden="true">{segment.number}</span>}
              <span className="limit-segment-row" aria-hidden="true">
                {multi && <span className="limit-segment-name">Account {segment.number}</span>}
                {multi && segment.reading.remaining !== null && !segment.reading.due && <b>{segment.reading.remaining}%</b>}
                <LimitChip segment={segment} />
              </span>
            </LimitBar>
          </button>
        ) : <span className="limit-segment-gap" key={`gap-${index}`} style={{ gridColumn: index + 1 }} aria-hidden="true" />)}
        {card.segments.map((segment) => {
          const chip = limitChipText(segment.countdown);
          return (
            <button type="button" className="limit-legend" key={segment.account.id} aria-label={`${accountTitle(segment.account, multi ? segment.number : null)} details`} {...toggle(segment)}>
              {multi && <span className="limit-legend-index" aria-hidden="true">{segment.number}</span>}
              <span className="limit-legend-name">{multi ? `Account ${segment.number}` : segment.account.label}</span>
              {multi && segment.reading.remaining !== null && !segment.reading.due && <b>{segment.reading.remaining}%</b>}
              <span className="limit-legend-reset">
                {chip}
                {segment.credits > 0 && <span className="limit-chip-credits"><Ticket size={14} aria-hidden="true" />{segment.credits}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {open && context.renderDetails(detailsId, open.account, multi ? open.number : null)}
    </div>
  );
}

function UnreportedAccount({ account, number, context }: { account: UsageAccount; number: number | null; context: CardContext }): React.JSX.Element {
  const detailsId = useId();
  const key = `account\n${account.id}`;
  const open = context.selected === key;
  return (
    <div className="limit-card is-unreported">
      <p className="limit-unreported">
        {number !== null && <b>Account {number}</b>}
        <span>{account.detail?.trim() || "Quota not reported"}</span>
      </p>
      <button
        type="button"
        className="limit-details-toggle"
        aria-label={`${accountTitle(account, number)} details`}
        aria-expanded={open}
        aria-controls={open ? detailsId : undefined}
        onClick={() => context.onSelect(key)}
      >
        Details<ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && context.renderDetails(detailsId, account, number)}
    </div>
  );
}

function ProviderSection({ section, index, context }: { section: LimitSection; index: number; context: Omit<CardContext, "providerId"> }): React.JSX.Element {
  const cardContext = { ...context, providerId: section.providerId };
  const multi = section.accounts.length > 1;
  return (
    <section className="limits-provider" aria-label={`${section.providerLabel} limits`} data-provider={section.providerId} style={{ "--i": index } as CSSProperties}>
      <h3 className="limits-provider-heading">
        <span className="limits-logo" aria-hidden="true"><ProviderBrandIcon providerId={section.providerId} decorative size={16} /></span>
        {section.providerLabel}
      </h3>
      {section.cards.map((card) => <LimitCardView key={card.key} card={card} context={cardContext} />)}
      {section.unreported.map((account) => (
        <UnreportedAccount
          key={account.id}
          account={account}
          number={multi ? section.accounts.indexOf(account) + 1 : null}
          context={cardContext}
        />
      ))}
    </section>
  );
}

export function UsageLimitsPanel({
  request,
  status,
  hiddenProviderIds,
  source = ALL_USAGE_SOURCES,
  refreshToken = 0,
  onBusyChange,
}: UsageLimitsPanelProps): React.JSX.Element {
  const { snapshot, accounts, busy, pending, error, now, refresh } = useUsageLimits(request, status);
  const [selected, setSelected] = useState<string | null>(null);
  const [flows, setFlows] = useState<Record<string, LimitResetFlow>>({});
  const [about, setAbout] = useState(false);
  const aboutId = useId();
  const online = status === "online";
  const handledToken = useRef(refreshToken);
  useEffect(() => {
    if (handledToken.current === refreshToken) return;
    handledToken.current = refreshToken;
    refresh();
  }, [refresh, refreshToken]);
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  const sources = snapshot?.sources;
  const sections = useMemo(() => limitSections(accounts.filter((account) => (
    !hiddenProviderIds?.has(account.providerId) && accountMatchesSource(account, source, sources ?? [])
  )), now), [accounts, hiddenProviderIds, now, source, sources]);
  const patchFlow = useCallback((accountId: string, patch: Partial<LimitResetFlow>): void => {
    setFlows((current) => ({ ...current, [accountId]: { ...(current[accountId] ?? IDLE_RESET_FLOW), ...patch } }));
  }, []);
  const context = {
    now,
    selected,
    pending,
    onSelect: (key: string) => setSelected((current) => current === key ? null : key),
    renderDetails: (id: string, account: UsageAccount, number: number | null) => (
      <LimitAccountDetails
        id={id}
        account={account}
        number={number}
        now={now}
        flow={flows[account.id] ?? IDLE_RESET_FLOW}
        online={online}
        request={request}
        onFlow={patchFlow}
        onRefresh={refresh}
      />
    ),
  };
  const checked = ageLabel(snapshot?.checkedAt ?? null, now);
  const filtered = accounts.length > 0 && sections.length === 0;
  return (
    <section className="usage-limits-panel" aria-label="Provider limits" aria-busy={busy}>
      {!online && <p className="limits-notice" role="status">The local service is offline. Displayed limits may be stale.</p>}
      {error && <p className="limits-notice" role="alert">{error}</p>}
      {sources?.filter((hub) => hub.error).map((hub) => (
        <p className="limits-notice" role="status" key={hub.id}>{hub.label}: {hub.error}</p>
      ))}
      {sections.length === 0 && (busy && !filtered
        ? (
          <>
            <p className="visually-hidden" role="status">Reading provider accounts…</p>
            <div className="limits-skeleton" aria-hidden="true">
              {[0, 1, 2].map((index) => <span key={index} style={{ "--i": index } as CSSProperties}><i /><b /></span>)}
            </div>
          </>
        )
        : <p className="limits-empty">{filtered ? "No accounts match these filters." : "No limits loaded"}</p>)}
      {sections.map((section, index) => (
        <ProviderSection key={`${section.providerId}\n${section.providerLabel}`} section={section} index={index} context={context} />
      ))}
      <footer className="limits-footer">
        <div className="limits-footnote">
          <button type="button" className="limits-about" aria-label="About these numbers" aria-expanded={about} aria-controls={aboutId} onClick={() => setAbout(!about)}>
            <Info size={14} aria-hidden="true" />
          </button>
          <small className="limits-checked">{busy ? "Refreshing…" : checked ? `Checked ${checked}` : "Not checked yet"}</small>
        </div>
        <p className="limits-explanation" id={aboutId} hidden={!about}>
          Subscription quota across your accounts. Remaining percentages describe provider quota. Account averages give each equivalent account equal weight; they do not estimate tokens or combined plan capacity. The hatched part is what the next reset restores, and the line marks an even pace through the window. A session shows 0% while its weekly limit is used up. Reset times stay due until the provider reports new quota.
        </p>
        <UsageSources snapshot={snapshot} request={request} online={online} onChange={refresh} />
      </footer>
    </section>
  );
}
