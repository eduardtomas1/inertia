import { useEffect, useRef, useState } from "react";
import {
  Ellipsis,
  MessagesSquare,
  PanelRightClose,
  Pause,
  Play,
  RefreshCw,
} from "lucide-react";

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
import { IconButton } from "../ui";
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
  onCollapse: () => void;
  onOpenWatcherChat: (() => void) | null;
  onResumeRequest: () => void;
  onError: (message: string | null) => void;
}

type Pending = "pause" | "resume" | "wake" | "detach" | "visibility" | null;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "The watcher could not be updated.";
}

/** Announces transitions only: never timer ticks or repeated states. */
function useTransitionAnnouncement(link: WatcherLinkView): string {
  const [announcement, setAnnouncement] = useState("");
  const previous = useRef({
    status: link.status,
    reason: link.pauseReason,
    latestAt: link.latest?.at ?? null,
  });
  const latestAt = link.latest?.at ?? null;
  const outcome = link.latest?.outcome ?? null;
  useEffect(() => {
    const prior = previous.current;
    previous.current = { status: link.status, reason: link.pauseReason, latestAt };
    const parts: string[] = [];
    if (latestAt !== prior.latestAt && outcome !== null) {
      parts.push(outcome === "finding" ? "New finding" : outcome === "silent" ? "Nothing to report" : watcherOutcomeText(outcome));
    }
    if (link.status === "waking" && prior.status !== "waking") parts.push("Watcher checking");
    if (link.status === "paused" && (prior.status !== "paused" || prior.reason !== link.pauseReason)) {
      parts.push(watcherPauseAnnouncement(link.pauseReason));
    }
    if (parts.length > 0) setAnnouncement(parts.join(". "));
  }, [latestAt, link.pauseReason, link.status, outcome]);
  return announcement;
}

export function WatcherBar({
  link,
  watched,
  watcher,
  agentLabel,
  headingId,
  actions,
  privateConnectConfigured,
  onCollapse,
  onOpenWatcherChat,
  onResumeRequest,
  onError,
}: WatcherBarProps): React.JSX.Element {
  const [pending, setPending] = useState<Pending>(null);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const mounted = useRef(true);
  const keepWatchingRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => {
    if (confirmingStop) keepWatchingRef.current?.focus({ preventScroll: true });
  }, [confirmingStop]);
  const announcement = useTransitionAnnouncement(link);
  const live = useWatcherLive(link.id);
  const waking = link.status === "waking";
  const latestTurn = watcher?.latestTurn ?? null;
  const turnRunning = latestTurn !== null && !isAgentTurnTerminalStatus(latestTurn.status);
  const startedAt = waking && turnRunning ? latestTurn.startedAt ?? latestTurn.requestedAt : null;
  const liveForTurn = live && (latestTurn === null || live.turnId === latestTurn.id) ? live : null;
  const paused = link.status === "paused";
  const run = (name: Exclude<Pending, null>, operation: () => Promise<unknown>): void => {
    if (pending) return;
    setPending(name);
    void operation().then(
      () => { if (mounted.current) onError(null); },
      (error: unknown) => { if (mounted.current) onError(errorText(error)); },
    ).finally(() => { if (mounted.current) setPending(null); });
  };
  const phase = waking
    ? liveForTurn ? watcherPhaseText(liveForTurn.phase, liveForTurn.label) : "Checking"
    : paused
      ? "Paused"
      : link.status === "idle"
        ? "Waiting for the main chat"
        : link.lastWakeAt
          ? `Watching · last check ${watcherClockTime(link.lastWakeAt)}`
          : "Watching for activity";
  const counters = link.counters;
  const effort = watcher?.reasoningEffort?.trim();
  const title = watched?.title ?? "this chat";
  const summary = `Watcher for ${title}: ${agentLabel}, ${watcherPresetName(link.preset)}`;
  return (
    <div className="watcher-bar" role="group" aria-label={summary}>
      <div className="watcher-bar-identity">
        <span className="watcher-bar-mark" aria-hidden="true">
          <ProviderBrandIcon providerId={watcher?.providerId} decorative size={16} />
        </span>
        <div className="watcher-bar-heading">
          <h2 id={headingId} tabIndex={-1}>
            <span className="watcher-bar-heading-prefix">Watching</span> <span className="watcher-bar-title">{title}</span>
          </h2>
          <p className="watcher-bar-route">
            {agentLabel}
            {effort ? ` · ${effort}` : ""}
            {" · "}
            {watcherPresetName(link.preset)}
          </p>
        </div>
        <div className="watcher-bar-actions">
          {paused ? (
            <IconButton label="Resume" disabled={!actions || pending !== null} onClick={onResumeRequest}>
              <Play size={16} aria-hidden="true" />
            </IconButton>
          ) : (
            <IconButton
              label="Pause"
              disabled={!actions || pending !== null}
              onClick={() => { if (actions) run("pause", actions.pause); }}
            >
              <Pause size={16} aria-hidden="true" />
            </IconButton>
          )}
          <IconButton
            label="Check now"
            disabled={!actions || pending !== null || waking || paused}
            onClick={() => { if (actions) run("wake", actions.wake); }}
          >
            <RefreshCw size={16} aria-hidden="true" />
          </IconButton>
          {onOpenWatcherChat && (
            <IconButton label="Open watcher chat" onClick={onOpenWatcherChat}>
              <MessagesSquare size={16} aria-hidden="true" />
            </IconButton>
          )}
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
                  {privateConnectConfigured && (
                    <button
                      type="button"
                      role="menuitemcheckbox"
                      tabIndex={-1}
                      aria-checked={link.privateConnect === "hidden"}
                      disabled={pending !== null}
                      onClick={() => {
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
                    className="is-danger"
                    disabled={pending !== null}
                    onClick={() => {
                      close(false);
                      setConfirmingStop(true);
                    }}
                  >
                    Stop watching…
                  </button>
                </>
              )}
            </WatcherMenu>
          </div>
          <IconButton label="Collapse" onClick={onCollapse}>
            <PanelRightClose size={16} aria-hidden="true" />
          </IconButton>
        </div>
      </div>
      <div className="watcher-bar-status">
        <p className="watcher-bar-phase" data-phase={waking ? "waking" : link.status}>
          <span className="watcher-bar-phase-text">{phase}</span>
          <WatcherElapsed startedAt={startedAt} />
        </p>
        <p className="watcher-bar-counters">
          <span>Checks {counters.wakesThisTurn} / {link.budgets.wakesPerWatchedTurn}</span>
          <span>{counters.eventsSeen.toLocaleString(INTERFACE_LOCALE)} seen</span>
          <span>{counters.eventsPending.toLocaleString(INTERFACE_LOCALE)} pending</span>
        </p>
        {link.quietSince && (
          <p className="watcher-bar-quiet">Main chat quiet since {watcherClockTime(link.quietSince)}</p>
        )}
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
            moreRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
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
                moreRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
              }}
            >
              Keep watching
            </button>
            <button
              type="button"
              className="secondary-button is-danger"
              disabled={!actions || pending !== null}
              onClick={() => { if (actions) run("detach", actions.detach); }}
            >
              Stop watching
            </button>
          </div>
        </div>
      )}
      <p className="visually-hidden" role="status" aria-live="polite">{announcement}</p>
    </div>
  );
}
