import {
  Activity,
  ChevronRight,
  RefreshCw,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type {
  DailyWorkDashboard,
  DailyWorkProviderSummary,
  ServerEvent,
  UsageMeasuredValue,
} from "@shared/contracts";

import type { ConnectionStatus } from "../hooks/useInertiaConnection";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { resultEvent } from "../lib/runtimeCommands";
import { formatCompact, formatCount, formatDuration } from "../lib/usageFormat";
import { ProviderMark } from "./ProviderMark";
import { IconButton, LoadingMark } from "./ui";
import "./DailyWorkDialog.css";

type DailyWorkCommand = Extract<
  CommandWithoutId,
  { type: "daily.work.get" }
>;

export interface DailyWorkDialogProps {
  status: ConnectionStatus;
  request(command: CommandWithoutId): Promise<ServerEvent>;
  onClose(): void;
  onOpenConversation(conversationId: string): void;
}

function localDateKey(date: Date): string {
  const part = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}`;
}

export function dailyWorkCommand(now = new Date()): DailyWorkCommand {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return {
    type: "daily.work.get",
    payload: {
      date: localDateKey(now),
      fromInclusive: start.toISOString(),
      toExclusive: end.toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    },
  };
}

/** Renders the dashboard day key as a calendar label without re-parsing as UTC. */
function formatDateLabel(dateKey: string | undefined): string | null {
  if (!dateKey) return null;
  const [year, month, day] = dateKey.split("-").map(Number);
  if (!year || !month || !day) return null;
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(new Date(year, month - 1, day));
  } catch {
    return null;
  }
}

/** Share of a settled total, or null when either side is unmeasured. */
function shareOfTotal(
  part: UsageMeasuredValue,
  total: UsageMeasuredValue,
): number | null {
  if (part.value === null || total.value === null || total.value <= 0) return null;
  return Math.min(1, Math.max(0, part.value / total.value));
}

function formatShare(share: number): string {
  const percent = share * 100;
  if (percent > 0 && percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
}

function MetricValue({
  metric,
  format,
}: {
  metric: UsageMeasuredValue;
  format(value: number): string;
}): React.JSX.Element {
  return metric.value === null
    ? <span className="daily-work-unavailable">Unavailable</span>
    : (
        <>
          {format(metric.value)}
          {metric.coverage === "partial" && <sup>*</sup>}
        </>
      );
}

function ProviderSummary({
  provider,
  share,
}: {
  provider: DailyWorkProviderSummary;
  share: number | null;
}): React.JSX.Element {
  return (
    <article className="daily-work-provider-summary" data-provider={provider.providerId}>
      <header>
        <span><ProviderMark providerId={provider.providerId} />{provider.providerLabel}</span>
        {share !== null && <b className="daily-work-provider-share">{formatShare(share)}</b>}
      </header>
      <div>
        <span>
          <strong><MetricValue metric={provider.processedTokens} format={formatCompact} /></strong>
          <small>tokens</small>
        </span>
        <span>
          <strong><MetricValue metric={provider.runtime} format={formatDuration} /></strong>
          <small>runtime</small>
        </span>
        <span>
          <strong>{formatCount(provider.turnCount)}</strong>
          <small>{provider.turnCount === 1 ? "turn" : "turns"}</small>
        </span>
      </div>
      <span
        className={share === null
          ? "daily-work-provider-meter is-unavailable"
          : "daily-work-provider-meter"}
        aria-hidden="true"
      >
        {share !== null && <i style={{ width: `${share * 100}%` }} />}
      </span>
    </article>
  );
}

function trapFocus(event: ReactKeyboardEvent<HTMLElement>): void {
  if (event.key !== "Tab") return;
  const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  )];
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function DailyWorkDialog({
  status,
  request,
  onClose,
  onOpenConversation,
}: DailyWorkDialogProps): React.JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const loadGeneration = useRef(0);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [dashboard, setDashboard] = useState<DailyWorkDashboard | null>(null);
  const [requestLoading, setRequestLoading] = useState(true);
  const [requestError, setRequestError] = useState<string | null>(null);
  const loading = status === "connecting"
    || (status === "online" && requestLoading);
  const error = status === "offline"
    ? "Daily work is unavailable while the local service is offline."
    : requestError;
  const dateLabel = useMemo(
    () => formatDateLabel(dashboard?.date),
    [dashboard?.date],
  );
  useNativePreviewSuspension(true);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", closeOnEscape, true);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [onClose]);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    if (status !== "online") return;
    setRequestLoading(true);
    setRequestError(null);
    void request(dailyWorkCommand()).then((event) => {
      if (loadGeneration.current !== generation) return;
      const result = resultEvent(event).result;
      if (result.kind !== "daily.work") {
        throw new Error("The local service returned an unexpected daily work response.");
      }
      setDashboard(result.dashboard);
    }).catch((cause: unknown) => {
      if (loadGeneration.current !== generation) return;
      setRequestError(cause instanceof Error ? cause.message : "Daily work could not be loaded.");
    }).finally(() => {
      if (loadGeneration.current === generation) setRequestLoading(false);
    });
  }, [refreshVersion, request, status]);

  return (
    <div
      className="dialog-backdrop daily-work-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="daily-work-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={loading}
        onKeyDown={trapFocus}
      >
        <header className="daily-work-header">
          <span className="daily-work-header-icon"><Activity size={18} aria-hidden="true" /></span>
          <div>
            <h2 id={titleId}>Daily work</h2>
            <p id={descriptionId}>
              Today’s agent work{dateLabel && <span className="daily-work-header-date">{dateLabel}</span>}
            </p>
          </div>
          <button
            type="button"
            className="daily-work-refresh"
            aria-label="Refresh daily work"
            disabled={loading || status !== "online"}
            onClick={() => setRefreshVersion((version) => version + 1)}
          >
            <RefreshCw size={14} aria-hidden="true" />
          </button>
          <IconButton ref={closeRef} label="Close daily work" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </header>

        <div className="daily-work-content">
          {loading && (
            <div className="daily-work-loading">
              <p className="daily-work-loading-status">
                <LoadingMark label="Loading daily work" />
                <span>Loading today’s work…</span>
              </p>
              <div className="daily-work-skeleton" aria-hidden="true">
                <div className="daily-work-skeleton-band"><i /><i /><i /></div>
                <div className="daily-work-skeleton-rows"><i /><i /><i /><i /></div>
              </div>
            </div>
          )}
          {!loading && error && (
            <div className="daily-work-error" role="alert">
              <span><strong>Daily work could not be loaded</strong><small>{error}</small></span>
              <button type="button" onClick={() => setRefreshVersion((version) => version + 1)} disabled={status !== "online"}>Try again</button>
            </div>
          )}
          {!loading && !error && dashboard && (
            <>
              <section className="daily-work-totals" aria-label="Today’s totals">
                <article className="is-primary">
                  <span>Processed tokens</span>
                  <strong><MetricValue metric={dashboard.totals.processedTokens} format={formatCompact} /></strong>
                  <small>Settled only</small>
                </article>
                <article>
                  <span>Agent runtime</span>
                  <strong><MetricValue metric={dashboard.totals.runtime} format={formatDuration} /></strong>
                  <small>Settled only</small>
                </article>
                <article className="is-conversation-count">
                  <span>Conversations</span>
                  <strong>{formatCount(dashboard.totals.conversationCount)}</strong>
                  <small>{formatCount(dashboard.totals.turnCount)} {dashboard.totals.turnCount === 1 ? "turn" : "turns"} today</small>
                </article>
              </section>

              {dashboard.totals.activeTurnCount > 0 && (
                <p className="daily-work-active-note" role="status">
                  {formatCount(dashboard.totals.activeTurnCount)} active {dashboard.totals.activeTurnCount === 1 ? "turn is" : "turns are"} excluded from settled totals.
                </p>
              )}

              {dashboard.providers.length > 0 && (
                <section className="daily-work-provider-section" aria-labelledby="daily-work-provider-heading">
                  <h3 id="daily-work-provider-heading">By provider</h3>
                  <div>
                    {dashboard.providers.map((provider) => (
                      <ProviderSummary
                        provider={provider}
                        share={shareOfTotal(
                          provider.processedTokens,
                          dashboard.totals.processedTokens,
                        )}
                        key={provider.providerId}
                      />
                    ))}
                  </div>
                </section>
              )}

              <section className="daily-work-conversations" aria-labelledby="daily-work-conversations-heading">
                <header>
                  <h3 id="daily-work-conversations-heading">Conversations</h3>
                  <span>Most recent first</span>
                </header>
                {dashboard.conversations.length === 0 ? (
                  <div className="daily-work-empty">
                    <Activity size={24} aria-hidden="true" />
                    <strong>No work recorded today</strong>
                    <span>New conversations and settled agent turns will appear here.</span>
                  </div>
                ) : (
                  <div className="daily-work-conversation-list">
                    {dashboard.conversations.map((conversation) => (
                      <button
                        type="button"
                        className="daily-work-conversation-card"
                        onClick={() => onOpenConversation(conversation.conversationId)}
                        key={conversation.conversationId}
                      >
                        <span className="daily-work-provider-stack" aria-label={conversation.providerIds.join(", ")}>
                          {conversation.providerIds.map((providerId) => (
                            <ProviderMark providerId={providerId} size={18} key={providerId} />
                          ))}
                        </span>
                        <span className="daily-work-conversation-identity">
                          <strong>{conversation.title}</strong>
                          <span className="daily-work-conversation-meta">
                            <small>{conversation.projectName} · {conversation.turnCount} {conversation.turnCount === 1 ? "turn" : "turns"}</small>
                            {conversation.running && <em className="daily-work-badge is-running">Running</em>}
                            {conversation.createdToday && <em className="daily-work-badge is-new">Created today</em>}
                          </span>
                        </span>
                        <span className="daily-work-card-metrics">
                          <span>
                            <small>Runtime</small>
                            <strong><MetricValue metric={conversation.runtime} format={formatDuration} /></strong>
                          </span>
                          <span>
                            <small>Tokens</small>
                            <strong><MetricValue metric={conversation.processedTokens} format={formatCompact} /></strong>
                          </span>
                        </span>
                        <ChevronRight className="daily-work-card-chevron" size={15} aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>

        {!loading && !error && dashboard && (
          <footer className="daily-work-note">
            Runtime is clipped to today. Tokens count when turns settle.
          </footer>
        )}
      </section>
    </div>
  );
}
