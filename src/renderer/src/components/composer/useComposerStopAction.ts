import { useLayoutEffect, useRef, useState } from "react";

import {
  COMPOSER_ACTION_STALE_FALLBACK_MS,
  STOP_REPEAT_LATCH_MS,
} from "../../utils/composerPrimaryAction";

/**
 * Owns the shared local Stop and Resume latch, invalidating it before a
 * different chat, run state, or held state paints.
 */
export function useComposerStopAction({
  conversationId,
  running,
  cancelling,
  held = false,
  onStop,
  onResume,
}: {
  conversationId: string;
  running: boolean;
  cancelling: boolean;
  held?: boolean;
  onStop(): Promise<void>;
  onResume?: () => Promise<void>;
}) {
  const [pendingKind, setPendingKind] = useState<"stop" | "resume" | null>(null);
  const pendingKindRef = useRef<"stop" | "resume" | null>(null);
  const stopClaimRef = useRef<symbol | null>(null);
  const releaseTimerRef = useRef<number | null>(null);
  const repeatLatchRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    pendingKindRef.current = null;
    setPendingKind(null);
    return () => {
      stopClaimRef.current = null;
      pendingKindRef.current = null;
      if (releaseTimerRef.current !== null) window.clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
      if (repeatLatchRef.current !== null) window.clearTimeout(repeatLatchRef.current);
      repeatLatchRef.current = null;
    };
  }, [conversationId, running, held]);

  const runLatched = async (
    kind: "stop" | "resume",
    action: () => Promise<void>,
  ): Promise<boolean> => {
    if (repeatLatchRef.current !== null) return false;
    if (stopClaimRef.current !== null && !(kind === "stop" && pendingKindRef.current === "stop")) {
      return false;
    }
    const claim = Symbol();
    stopClaimRef.current = claim;
    pendingKindRef.current = kind;
    setPendingKind(kind);
    if (releaseTimerRef.current !== null) window.clearTimeout(releaseTimerRef.current);
    releaseTimerRef.current = null;
    repeatLatchRef.current = window.setTimeout(() => {
      repeatLatchRef.current = null;
    }, STOP_REPEAT_LATCH_MS);
    const release = (): void => {
      if (stopClaimRef.current !== claim) return;
      stopClaimRef.current = null;
      pendingKindRef.current = null;
      releaseTimerRef.current = null;
      setPendingKind(null);
    };
    try {
      await action();
      if (stopClaimRef.current === claim) {
        releaseTimerRef.current = window.setTimeout(release, COMPOSER_ACTION_STALE_FALLBACK_MS);
      }
      return true;
    } catch {
      release();
      return false;
    }
  };

  const stop = async (): Promise<boolean> => {
    if (!running) return false;
    return await runLatched("stop", onStop);
  };

  const resume = async (): Promise<boolean> => {
    if (running || !onResume) return false;
    return await runLatched("resume", onResume);
  };

  const stopping = pendingKind === "stop" || cancelling;
  const resuming = pendingKind === "resume";

  return {
    stopping,
    resuming,
    actionPending: stopping || resuming,
    stopClaimRef,
    stop,
    resume,
  };
}
