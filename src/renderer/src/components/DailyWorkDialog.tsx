import {
  Activity,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
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
}: {
  provider: DailyWorkProviderSummary;
}): React.JSX.Element {
  return (
    <article className="daily-work-provider-summary">
      <header>
        <span><ProviderMark providerId={provider.providerId} />{provider.providerLabel}</span>
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
      </div>
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
            <p id={descriptionId}>Today’s agent work</p>
          </div>
          <button
            type="button"
            className="daily-work-refresh"
            aria-label="Refresh daily work"
            disabled={loading || status !== "online"}
            onClick={() => setRefreshVersion((version) => version + 1)}
          >
            <span aria-hidden="true">↻</span>
          </button>
          <IconButton ref={closeRef} label="Close daily work" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </header>

        <div className="daily-work-content">
          {loading && (
            <div className="daily-work-loading">
              <LoadingMark label="Loading daily work" />
              <span>Loading today’s work…</span>
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
                <article>
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
                      <ProviderSummary provider={provider} key={provider.providerId} />
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
                          <small>{conversation.projectName} · {conversation.turnCount} {conversation.turnCount === 1 ? "turn" : "turns"}</small>
                          <span>
                            {conversation.running && <em>Running</em>}
                            {conversation.createdToday && <em>Created today</em>}
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
                      </button>
                    ))}
                  </div>
                )}
              </section>

              <footer className="daily-work-note">
                Runtime is clipped to today. Tokens count when turns settle.
              </footer>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
