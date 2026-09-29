import { useEffect, useRef } from "react";

import type { AppSnapshot, ConversationShell } from "@shared/contracts";
import { completionSoundDue, type CompletionSoundSettings } from "@shared/completion-sound";
import { playCompletionSound } from "../utils/completionSoundPlayer";
import { threadNotificationKind } from "./useThreadNotifications";

export function completedTurnDurationMs(conversation: ConversationShell, observedStart?: number): number | null {
  const turn = conversation.latestTurn;
  const end = Date.parse(turn?.completedAt ?? conversation.completedAt ?? "");
  const start = turn ? Date.parse(turn.startedAt ?? turn.requestedAt) : Number.NaN;
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return end - start;
  if (observedStart === undefined) return null;
  return Math.max(0, (Number.isFinite(end) ? end : Date.now()) - observedStart);
}

export function useCompletionSounds(
  snapshot: AppSnapshot | null,
  settings: CompletionSoundSettings,
  play: (settings: CompletionSoundSettings) => unknown = playCompletionSound,
): void {
  const previousRef = useRef<Map<string, ConversationShell> | null>(null);
  const runningSinceRef = useRef(new Map<string, number>());
  const settingsRef = useRef(settings);
  const playRef = useRef(play);
  settingsRef.current = settings;
  playRef.current = play;

  useEffect(() => {
    if (!snapshot) return;
    const previous = previousRef.current;
    previousRef.current = new Map(snapshot.conversations.map((conversation) => [conversation.id, conversation]));
    const runningSince = runningSinceRef.current;
    const now = Date.now();
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
      const kind = threadNotificationKind(prior, conversation);
      if (kind !== "completed" && kind !== "failed") continue;
      if (conversation.snoozedUntil && Date.parse(conversation.snoozedUntil) > now) continue;
      if (completionSoundDue(settingsRef.current, completedTurnDurationMs(conversation, observedStart))) due = true;
    }
    for (const id of runningSince.keys()) {
      if (!previousRef.current.has(id)) runningSince.delete(id);
    }
    if (due && previous) void Promise.resolve(playRef.current(settingsRef.current)).catch(() => undefined);
  }, [snapshot]);
}

export function CompletionSounds(props: { snapshot: AppSnapshot | null; settings: CompletionSoundSettings }): null {
  useCompletionSounds(props.snapshot, props.settings);
  return null;
}
