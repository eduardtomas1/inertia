import { useEffect, useRef } from "react";

import type { AppSnapshot, ConversationShell } from "@shared/contracts";
import { completionSoundDue, type CompletionSoundSettings } from "@shared/completion-sound";
import { playCompletionSound } from "../utils/completionSoundPlayer";
import { checkingWatcherIds, threadNotificationKindFor } from "./useThreadNotifications";

export function completedTurnDurationMs(conversation: ConversationShell, observedStart?: number): number | null {
  const turn = conversation.latestTurn;
  const end = Date.parse(turn?.completedAt ?? conversation.completedAt ?? "");
  const start = turn ? Date.parse(turn.startedAt ?? turn.requestedAt) : Number.NaN;
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return end - start;
  if (observedStart === undefined) return null;
  return Math.max(0, (Number.isFinite(end) ? end : Date.now()) - observedStart);
}

export function completionSoundTriggered(
  snapshot: AppSnapshot,
  previous: ReadonlyMap<string, ConversationShell> | null,
  runningSince: Map<string, number>,
  settings: CompletionSoundSettings,
  quiet: ReadonlySet<string>,
  now = Date.now(),
): boolean {
  let due = false;
  for (const conversation of snapshot.conversations) {
    const prior = previous?.get(conversation.id);
    const observedStart = runningSince.get(conversation.id);
    if (conversation.status === "running") {
      if (observedStart === undefined) runningSince.set(conversation.id, now);
    } else {
      runningSince.delete(conversation.id);
    }
    if (!prior) continue;
    const kind = threadNotificationKindFor(prior, conversation, quiet);
    if (kind !== "completed" && kind !== "failed") continue;
    if (conversation.snoozedUntil && Date.parse(conversation.snoozedUntil) > now) continue;
    if (completionSoundDue(settings, completedTurnDurationMs(conversation, observedStart))) due = true;
  }
  const known = new Set(snapshot.conversations.map(({ id }) => id));
  for (const id of runningSince.keys()) {
    if (!known.has(id)) runningSince.delete(id);
  }
  return due && previous !== null;
}

export function useCompletionSounds(
  snapshot: AppSnapshot | null,
  settings: CompletionSoundSettings,
  play: (settings: CompletionSoundSettings) => unknown = playCompletionSound,
): void {
  const previousRef = useRef<Map<string, ConversationShell> | null>(null);
  const previousWatchersRef = useRef<AppSnapshot["watchers"]>(undefined);
  const runningSinceRef = useRef(new Map<string, number>());
  const settingsRef = useRef(settings);
  const playRef = useRef(play);
  settingsRef.current = settings;
  playRef.current = play;

  useEffect(() => {
    if (!snapshot) return;
    const previous = previousRef.current;
    const quiet = checkingWatcherIds(previousWatchersRef.current, snapshot.watchers);
    previousRef.current = new Map(snapshot.conversations.map((conversation) => [conversation.id, conversation]));
    previousWatchersRef.current = snapshot.watchers;
    if (completionSoundTriggered(snapshot, previous, runningSinceRef.current, settingsRef.current, quiet)) {
      void Promise.resolve(playRef.current(settingsRef.current)).catch(() => undefined);
    }
  }, [snapshot]);
}

export function CompletionSounds(props: { snapshot: AppSnapshot | null; settings: CompletionSoundSettings }): null {
  useCompletionSounds(props.snapshot, props.settings);
  return null;
}
