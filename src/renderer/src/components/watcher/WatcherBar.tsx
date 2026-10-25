import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Ellipsis } from "lucide-react";

import { watcherAccessLabel } from "@shared/access-labels";
import type { ConversationShell } from "@shared/contracts";
import { isAgentTurnTerminalStatus } from "@shared/turn-lifecycle";
import type { WatcherLinkView } from "@shared/watcher";
import { formatCompact } from "../../lib/compactFormat";
import { INTERFACE_LOCALE } from "../../lib/locale";
import { useWatcherLive } from "../../utils/watcherLiveStore";
import {
  watcherClockTime,
  watcherErrorText,
  watcherOutcomeText,
  watcherPauseAnnouncement,
  watcherPhaseAttention,
  watcherPhaseText,
} from "../../utils/watcherCopy";
import { watcherEventsText, watcherPresetName } from "../../utils/watcherLinks";
import type { WatcherActions } from "../../hooks/useWatcherActions";
import { ProviderBrandIcon } from "../ProviderBrandIcon";
import { TooltipButton } from "../TooltipButton";
import { WatcherElapsed } from "./WatcherElapsed";
import { WatcherMenu } from "./WatcherMenu";

interface WatcherBarProps {
  link: WatcherLinkView;
  watched: ConversationShell | undefined;
  watcher: ConversationShell | undefined;
  agentLabel: string;
  headingId: string;
  closed: boolean;
  actions: WatcherActions | null;
  privateConnectConfigured: boolean;
  resumeBlocked: string | null;
  usageTokens: number | null;
  onCollapse: () => void;
  onOpenWatcherChat: (() => void) | null;
  onResumeRequest: () => void;
  onError: (message: string | null) => void;
}

type Pending = "pause" | "wake" | "review" | "detach" | "visibility" | "delivery" | null;

const QUIET_OUTCOMES = new Set(["silent", "finding"]);

function useTransitionAnnouncement(link: WatcherLinkView, attention: string | null): string {
  const [announcement, setAnnouncement] = useState("");
  const latestFindingAt = link.latestFindingAt;
  const latestAt = link.latest?.at ?? null;
  const outcome = link.latest?.outcome ?? null;
  const previous = useRef({ status: link.status, reason: link.pauseReason, latestAt, latestFindingAt, attention });
  useEffect(() => {
    const prior = previous.current;
    previous.current = { status: link.status, reason: link.pauseReason, latestAt, latestFindingAt, attention };
    const parts: string[] = [];
    if (attention !== null && attention !== prior.attention) parts.push(attention);
    if (latestFindingAt !== null && latestFindingAt !== prior.latestFindingAt) parts.push("New finding");
    if (latestAt !== prior.latestAt && outcome !== null && !QUIET_OUTCOMES.has(outcome)) {
      parts.push(watcherOutcomeText(outcome));
    }
    if (link.status === "paused" && (prior.status !== "paused" || prior.reason !== link.pauseReason)) {
      parts.push(watcherPauseAnnouncement(link.pauseReason, link.pauseDetail));
    }
    if (parts.length === 0) return;
    const text = parts.join(". ");
    setAnnouncement((current) => current !== text ? text : text.endsWith(".") ? text.slice(0, -1) : `${text}.`);
  }, [latestAt, latestFindingAt, link.pauseDetail, link.pauseReason, link.status, attention, outcome]);
  return announcement;
}

function counterText(count: number): string {
  return count.toLocaleString(INTERFACE_LOCALE);
}

function stateText(link: WatcherLinkView, live: string | null): string {
  if (link.status === "waking") return live ?? "Checking…";
  if (link.status === "paused") return "Paused";
  return link.delivery === "auto" ? "Sends findings automatically" : "Watching";
}

function MenuNote({ children }: { children: string }): React.JSX.Element {
  return <div role="menuitem" aria-disabled="true" tabIndex={-1} className="watcher-menu-note">{children}</div>;
}

function WatcherBarMenuItems({
  link,
  watcher,
  pending,
  actions,
  reviewUnavailable,
  privateConnectConfigured,
  usageTokens,
  close,
  run,
  onOpenWatcherChat,
  onCollapse,
  onStop,
}: {
  link: WatcherLinkView;
  watcher: ConversationShell | undefined;
  pending: Pending;
  actions: WatcherActions | null;
  reviewUnavailable: boolean;
  privateConnectConfigured: boolean;
  usageTokens: number | null;
  close: (restoreFocus?: boolean) => void;
  run: (name: Exclude<Pending, null>, operation: () => Promise<unknown>) => void;
  onOpenWatcherChat: (() => void) | null;
  onCollapse: () => void;
  onStop: () => void;
}): React.JSX.Element {
  const paused = link.status === "paused";
  const counters = link.counters;
  const allowance = link.budgets.wakesPerWatchedTurn;
  const checksLeft = Math.min(allowance, Math.max(0, counters.wakeAllowance - counters.wakesThisTurn));
  const budgetPaused = paused && link.pauseReason === "wake-budget";
  return (
    <>
      {!paused && (
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          aria-disabled={pending !== null || undefined}
          onClick={() => {
            if (pending !== null || !actions) return;
            close();
            run("pause", actions.pause);
          }}
        >
          Pause
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        aria-disabled={reviewUnavailable || undefined}
        onClick={() => {
          if (reviewUnavailable || !actions) return;
          close();
          run("review", actions.review);
        }}
      >
        Review the last turn
      </button>
      {onOpenWatcherChat && (
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          onClick={() => {
            close(false);
            onOpenWatcherChat();
          }}
        >
          Open watcher chat
        </button>
      )}
      <button
        type="button"
        role="menuitemcheckbox"
        tabIndex={-1}
        aria-checked={link.delivery === "auto"}
        aria-disabled={pending !== null || undefined}
        onClick={() => {
          if (pending !== null || !actions) return;
          close();
          run("delivery", () => actions.update({ delivery: link.delivery === "auto" ? "manual" : "auto" }));
        }}
      >
        Send findings automatically
      </button>
      {privateConnectConfigured && (
        <button
          type="button"
          role="menuitemcheckbox"
          tabIndex={-1}
          aria-checked={link.privateConnect === "hidden"}
          aria-disabled={pending !== null || undefined}
          onClick={() => {
            if (pending !== null) return;
            close();
            if (actions) {
              run("visibility", () => actions.update({
                privateConnect: link.privateConnect === "hidden" ? "inherit" : "hidden",
              }));
            }
          }}
        >
          Hide from paired devices
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        onClick={() => {
          close(false);
          onCollapse();
        }}
      >
        Collapse
      </button>
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        className="is-danger"
        aria-disabled={pending !== null || undefined}
        onClick={() => {
          if (pending !== null) return;
          close(false);
          onStop();
        }}
      >
        Stop watching…
      </button>
      <div role="separator" />
      <MenuNote>{watcherAccessLabel(link, watcher ?? null)}</MenuNote>
      {!budgetPaused && (
        <MenuNote>{`${counterText(checksLeft)} of ${counterText(allowance)} checks left this turn`}</MenuNote>
      )}
      <MenuNote>{`${watcherEventsText(counters.eventsPending)} waiting`}</MenuNote>
      {link.lastWakeAt && <MenuNote>{`Last check ${watcherClockTime(link.lastWakeAt)}`}</MenuNote>}
      {link.quietSince && <MenuNote>{`Main chat quiet since ${watcherClockTime(link.quietSince)}`}</MenuNote>}
      {usageTokens !== null && <MenuNote>{`Used ${formatCompact(usageTokens)} tokens`}</MenuNote>}
    </>
  );
}

export function WatcherBar({
  link,
  watched,
  watcher,
  agentLabel,
  headingId,
  closed,
  actions,
  privateConnectConfigured,
  resumeBlocked,
  usageTokens,
  onCollapse,
  onOpenWatcherChat,
  onResumeRequest,
  onError,
}: WatcherBarProps): React.JSX.Element {
  const [pending, setPending] = useState<Pending>(null);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const mounted = useRef(false);
  const keepWatchingRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (confirmingStop) keepWatchingRef.current?.focus({ preventScroll: true });
  }, [confirmingStop]);
  useEffect(() => {
    if (closed) setConfirmingStop(false);
  }, [closed]);
  const live = useWatcherLive(link.id);
  const waking = link.status === "waking";
  const latestTurn = watcher?.latestTurn ?? null;
  const turnRunning = latestTurn !== null && !isAgentTurnTerminalStatus(latestTurn.status);
  const startedAt = waking && turnRunning ? latestTurn.startedAt ?? latestTurn.requestedAt : null;
  const liveForTurn = waking && live && (latestTurn === null || live.turnId === latestTurn.id) ? live : null;
  const attention = liveForTurn ? watcherPhaseAttention(liveForTurn.phase) : null;
  const announcement = useTransitionAnnouncement(link, attention);
  const paused = link.status === "paused";
  const run = (name: Exclude<Pending, null>, operation: () => Promise<unknown>): void => {
    if (pending) return;
    setPending(name);
    void operation().then(
      () => { if (mounted.current) onError(null); },
      (error: unknown) => { if (mounted.current) onError(watcherErrorText(error, "The watcher could not be updated.")); },
    ).finally(() => { if (mounted.current) setPending(null); });
  };
  const phase = stateText(link, liveForTurn ? watcherPhaseText(liveForTurn.phase, liveForTurn.label) : null);
  const title = watched?.title ?? "this chat";
  const preset = watcherPresetName(link.preset);
  const summary = `Watcher for ${title}: ${agentLabel}, ${preset}`;
  const resumeUnavailable = !actions || pending !== null || resumeBlocked !== null;
  const checkUnavailable = !actions || pending !== null || waking;
  const reviewUnavailable = checkUnavailable || paused || link.status === "detached";
  const openChat = attention !== null && !paused ? onOpenWatcherChat : null;
  const primaryUnavailable = openChat ? false : paused ? resumeUnavailable : checkUnavailable;
  const primaryLabel = openChat
    ? "Open chat"
    : paused ? link.pauseReason === "write-detected" ? "Resume…" : "Resume" : "Check now";
  const restoreMoreFocus = (): void => {
    moreRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  };
  return (
    <div className="watcher-bar" role="group" aria-label={summary}>
      <span className="watcher-bar-mark" aria-hidden="true">
        <ProviderBrandIcon providerId={watcher?.providerId} decorative size={16} />
      </span>
      <div className="watcher-bar-text">
        <h2 id={headingId} tabIndex={-1} title={title}>
          <span className="visually-hidden">Watching </span>
          <span className="watcher-bar-title">{title}</span>
        </h2>
        <p className="watcher-bar-state" data-phase={attention !== null ? "attention" : waking ? "waking" : link.status}>
          <span className="watcher-bar-route">{agentLabel} · {preset} · </span>
          <span className="watcher-bar-phase-text">{phase}</span>
          <WatcherElapsed startedAt={startedAt} />
        </p>
      </div>
      <div className="watcher-bar-actions">
        <TooltipButton
          tooltip={paused && resumeBlocked ? resumeBlocked : ""}
          className="watcher-text-button"
          aria-disabled={primaryUnavailable || undefined}
          onClick={() => {
            if (openChat) {
              openChat();
              return;
            }
            if (primaryUnavailable || !actions) return;
            if (paused) onResumeRequest();
            else run("wake", actions.wake);
          }}
        >
          {primaryLabel}
        </TooltipButton>
        <div ref={moreRef}>
          <WatcherMenu
            label="More watcher actions"
            trigger={<Ellipsis size={16} aria-hidden="true" />}
            triggerClassName="icon-button"
            menuClassName="watcher-bar-menu"
            disabled={!actions}
          >
            {(close) => (
              <WatcherBarMenuItems
                link={link}
                watcher={watcher}
                pending={pending}
                actions={actions}
                reviewUnavailable={reviewUnavailable}
                privateConnectConfigured={privateConnectConfigured}
                usageTokens={usageTokens}
                close={close}
                run={run}
                onOpenWatcherChat={onOpenWatcherChat}
                onCollapse={onCollapse}
                onStop={() => setConfirmingStop(true)}
              />
            )}
          </WatcherMenu>
        </div>
      </div>
      {confirmingStop && (
        <div
          className="watcher-confirm"
          role="group"
          aria-label="Stop watching"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            setConfirmingStop(false);
            restoreMoreFocus();
          }}
        >
          <p>Stop watching? Any running check stops and the watcher becomes an ordinary chat.</p>
          <div className="watcher-confirm-actions">
            <button
              ref={keepWatchingRef}
              type="button"
              className="secondary-button"
              onClick={() => {
                setConfirmingStop(false);
                restoreMoreFocus();
              }}
            >
              Keep watching
            </button>
            <button
              type="button"
              className="secondary-button is-danger"
              aria-disabled={!actions || pending !== null || undefined}
              onClick={() => { if (actions && pending === null) run("detach", actions.detach); }}
            >
              {pending === "detach" ? "Stopping…" : "Stop watching"}
            </button>
          </div>
        </div>
      )}
      <p className="visually-hidden" role="status" aria-live="polite">{announcement}</p>
    </div>
  );
}
