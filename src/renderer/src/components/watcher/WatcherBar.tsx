import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Ellipsis, Play, RefreshCw } from "lucide-react";

import type { ConversationShell } from "@shared/contracts";
import { isAgentTurnTerminalStatus } from "@shared/turn-lifecycle";
import type { WatcherLinkView } from "@shared/watcher";
import { INTERFACE_LOCALE } from "../../lib/locale";
import { useWatcherLive } from "../../utils/watcherLiveStore";
import {
  watcherClockTime,
  watcherOutcomeText,
  watcherPauseAnnouncement,
  watcherPhaseText,
} from "../../utils/watcherCopy";
import { watcherPresetName } from "../../utils/watcherLinks";
import type { WatcherActions } from "../../hooks/useWatcherActions";
import { ProviderBrandIcon } from "../ProviderBrandIcon";
import { TooltipButton } from "../TooltipButton";
import { WatcherElapsed } from "./WatcherElapsed";
import { WatcherMenu } from "./WatcherMenu";

export interface WatcherBarProps {
  link: WatcherLinkView;
  watched: ConversationShell | undefined;
  watcher: ConversationShell | undefined;
  agentLabel: string;
  headingId: string;
  actions: WatcherActions | null;
  privateConnectConfigured: boolean;
  /** Why Resume would be refused right now, or null when it can resume. */
  resumeBlocked: string | null;
  onCollapse: () => void;
  onOpenWatcherChat: (() => void) | null;
  onResumeRequest: () => void;
  onError: (message: string | null) => void;
}

type Pending = "pause" | "resume" | "wake" | "detach" | "visibility" | null;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "The watcher could not be updated.";
}

const QUIET_OUTCOMES = new Set(["silent", "finding"]);

/**
 * Announces what needs attention only: a new finding, a check that failed
 * and a pause. Routine checks ("checking", "nothing to report") stay silent,
 * so a busy turn does not produce two dozen announcements.
 */
function useTransitionAnnouncement(link: WatcherLinkView): string {
  const [announcement, setAnnouncement] = useState("");
  const latestFindingAt = link.latestFindingAt ?? null;
  const latestAt = link.latest?.at ?? null;
  const outcome = link.latest?.outcome ?? null;
  const previous = useRef({ status: link.status, reason: link.pauseReason, latestAt, latestFindingAt });
  useEffect(() => {
    const prior = previous.current;
    previous.current = { status: link.status, reason: link.pauseReason, latestAt, latestFindingAt };
    const parts: string[] = [];
    if (latestFindingAt !== null && latestFindingAt !== prior.latestFindingAt) parts.push("New finding");
    if (latestAt !== prior.latestAt && outcome !== null && !QUIET_OUTCOMES.has(outcome)) {
      parts.push(watcherOutcomeText(outcome));
    }
    if (link.status === "paused" && (prior.status !== "paused" || prior.reason !== link.pauseReason)) {
      parts.push(watcherPauseAnnouncement(link.pauseReason));
    }
    if (parts.length === 0) return;
    const text = parts.join(". ");
    setAnnouncement((current) => current !== text ? text : text.endsWith(".") ? text.slice(0, -1) : `${text}.`);
  }, [latestAt, latestFindingAt, link.pauseReason, link.status, outcome]);
  return announcement;
}

function counterText(count: number): string {
  return count.toLocaleString(INTERFACE_LOCALE);
}

function stateText(link: WatcherLinkView, live: string | null): string {
  if (link.status === "waking") return live ?? "Checking…";
  if (link.status === "paused") return "Paused";
  if (link.status === "idle") return "Waiting for the next event";
  return "Watching";
}

function MenuNote({ children }: { children: string }): React.JSX.Element {
  return <div role="menuitem" aria-disabled="true" tabIndex={-1} className="watcher-menu-note">{children}</div>;
}

export function WatcherBar({
  link,
  watched,
  watcher,
  agentLabel,
  headingId,
  actions,
  privateConnectConfigured,
  resumeBlocked,
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
  // Set in the effect body too: StrictMode runs the cleanup once at mount.
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (confirmingStop) keepWatchingRef.current?.focus({ preventScroll: true });
  }, [confirmingStop]);
  const announcement = useTransitionAnnouncement(link);
  const live = useWatcherLive(link.id);
  const waking = link.status === "waking";
  const latestTurn = watcher?.latestTurn ?? null;
  const turnRunning = latestTurn !== null && !isAgentTurnTerminalStatus(latestTurn.status);
  const startedAt = waking && turnRunning ? latestTurn.startedAt ?? latestTurn.requestedAt : null;
  // The runtime drops a link's phase when its check ends; the turn id guards
  // a late tick from the previous check until the new turn reaches the shell.
  const liveForTurn = waking && live && (latestTurn === null || live.turnId === latestTurn.id) ? live : null;
  const paused = link.status === "paused";
  const run = (name: Exclude<Pending, null>, operation: () => Promise<unknown>): void => {
    if (pending) return;
    setPending(name);
    void operation().then(
      () => { if (mounted.current) onError(null); },
      (error: unknown) => { if (mounted.current) onError(errorText(error)); },
    ).finally(() => { if (mounted.current) setPending(null); });
  };
  const phase = stateText(link, liveForTurn ? watcherPhaseText(liveForTurn.phase, liveForTurn.label) : null);
  const counters = link.counters;
  const allowance = link.budgets.wakesPerWatchedTurn;
  const checksLeft = Math.min(allowance, Math.max(0, counters.wakeAllowance - counters.wakesThisTurn));
  const budgetPaused = paused && link.pauseReason === "wake-budget";
  const title = watched?.title ?? "this chat";
  const preset = watcherPresetName(link.preset);
  const summary = `Watcher for ${title}: ${agentLabel}, ${preset}`;
  // Pending actions keep focus: aria-disabled, never disabled, while busy.
  const resumeUnavailable = !actions || pending !== null || resumeBlocked !== null;
  const checkUnavailable = !actions || pending !== null || waking;
  const primaryUnavailable = paused ? resumeUnavailable : checkUnavailable;
  const primaryLabel = paused ? "Resume" : "Check now";
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
        <p className="watcher-bar-state" data-phase={waking ? "waking" : link.status}>
          <span className="watcher-bar-route">{agentLabel} · {preset} · </span>
          <span className="watcher-bar-phase-text">{phase}</span>
          <WatcherElapsed startedAt={startedAt} />
        </p>
      </div>
      <div className="watcher-bar-actions">
        <TooltipButton
          tooltip={paused && resumeBlocked ? resumeBlocked : primaryLabel}
          aria-label={primaryLabel}
          className="icon-button"
          aria-disabled={primaryUnavailable || undefined}
          onClick={() => {
            if (primaryUnavailable || !actions) return;
            if (paused) onResumeRequest();
            else run("wake", actions.wake);
          }}
        >
          {paused ? <Play size={16} aria-hidden="true" /> : <RefreshCw size={16} aria-hidden="true" />}
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
                    setConfirmingStop(true);
                  }}
                >
                  Stop watching…
                </button>
                <div role="separator" />
                {!budgetPaused && (
                  <MenuNote>{`${counterText(checksLeft)} of ${counterText(allowance)} checks left this turn`}</MenuNote>
                )}
                <MenuNote>{`${counterText(counters.eventsSeen)} ${counters.eventsSeen === 1 ? "event" : "events"} seen`}</MenuNote>
                <MenuNote>{`${counterText(counters.eventsPending)} waiting`}</MenuNote>
                {link.lastWakeAt && <MenuNote>{`Last check ${watcherClockTime(link.lastWakeAt)}`}</MenuNote>}
                {link.quietSince && <MenuNote>{`Main chat quiet since ${watcherClockTime(link.quietSince)}`}</MenuNote>}
              </>
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
