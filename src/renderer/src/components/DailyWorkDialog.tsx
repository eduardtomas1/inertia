import {
  ChevronRight,
  RefreshCw,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
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
import {
  focusModalOnAnimationFrame,
  trapModalFocus,
} from "../utils/modalFocus";
import { DailyWorkMark } from "./DailyWorkMark";
import { ProviderMark } from "./ProviderMark";
import { IconButton, LoadingMark } from "./ui";
import "./DailyWorkDialog.css";

type DailyWorkCommand = Extract<
  CommandWithoutId,
  { type: "daily.work.get" }
>;

export interface DailyWorkDialogProps {
  open?: boolean;
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
function formatDateLabel(dateKey: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(`${dateKey}T12:00:00`));
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

export function DailyWorkDialog({
  open = true,
  status,
  request,
  onClose,
  onOpenConversation,
}: DailyWorkDialogProps): React.JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const loadGeneration = useRef(0);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [selectedDateKey, setSelectedDateKey] = useState(() =>
    localDateKey(new Date()));
  const [dashboard, setDashboard] = useState<DailyWorkDashboard | null>(null);
  const [requestLoading, setRequestLoading] = useState(true);
  const [requestError, setRequestError] = useState<string | null>(null);
  const loading = status === "connecting"
    || (status === "online" && requestLoading);
  const error = status === "offline"
    ? "Daily work is unavailable while the local service is offline."
    : requestError;
  const todayKey = localDateKey(new Date());
  const dateLabel = formatDateLabel(selectedDateKey);
  useNativePreviewSuspension(true);

  useEffect(() => {
    if (!open) return;
    const restoreFocus = focusModalOnAnimationFrame(
      () => closeRef.current?.focus(),
    );
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("keydown", closeOnEscape, true);
      restoreFocus();
    };
  }, [open]);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    if (!open || status !== "online") return;
    setRequestLoading(true);
    setRequestError(null);
    void request(dailyWorkCommand(new Date(`${selectedDateKey}T12:00:00`))).then((event) => {
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
  }, [open, refreshVersion, request, selectedDateKey, status]);

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
        onKeyDown={(event) => trapModalFocus(event, event.currentTarget)}
      >
        <header className="daily-work-header">
          <span className="daily-work-header-icon" aria-hidden="true">
            <DailyWorkMark size={19} />
          </span>
          <div>
            <h2 id={titleId}>Daily work</h2>
            <p id={descriptionId}>
              Agent work<span className="daily-work-header-date">{dateLabel}</span>
            </p>
          </div>
          <input
            className="daily-work-date-input"
            type="date"
            aria-label="Daily work date"
            value={selectedDateKey}
            max={todayKey}
            onChange={(event) => {
              const date = event.currentTarget.value;
              if (date && date <= todayKey) setSelectedDateKey(date);
            }}
          />
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
                <span>Loading daily work…</span>
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
              <section
                className="daily-work-totals"
                aria-label="Daily work totals"
              >
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
                  <small>
                    {formatCount(dashboard.totals.turnCount)} {dashboard.totals.turnCount === 1 ? "turn" : "turns"}
                  </small>
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
                    <DailyWorkMark size={24} />
                    <strong>No work recorded</strong>
                    <span>No conversations or settled agent turns were found for this date.</span>
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
                            {conversation.createdToday && (
                              <em className="daily-work-badge is-new">Created this day</em>
                            )}
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
            Runtime is clipped to this local day. Tokens count when turns settle.
          </footer>
        )}
      </section>
    </div>
  );
}
