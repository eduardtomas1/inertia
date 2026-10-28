import { useLayoutEffect, useRef, useState } from "react";

import {
  COMPOSER_ACTION_STALE_FALLBACK_MS,
  STOP_REPEAT_LATCH_MS,
} from "../../utils/composerPrimaryAction";

/** Owns the local Stop latch and invalidates it before a different chat paints. */
export function useComposerStopAction({
  conversationId,
  running,
  cancelling,
  onStop,
}: {
  conversationId: string;
  running: boolean;
  cancelling: boolean;
  onStop(): Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const stopClaimRef = useRef<symbol | null>(null);
  const releaseTimerRef = useRef<number | null>(null);
  const repeatLatchRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    setPending(false);
    return () => {
      stopClaimRef.current = null;
      if (releaseTimerRef.current !== null) window.clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
      if (repeatLatchRef.current !== null) window.clearTimeout(repeatLatchRef.current);
      repeatLatchRef.current = null;
    };
  }, [conversationId, running]);

  const stop = async (): Promise<boolean> => {
    if (repeatLatchRef.current !== null || !running) return false;
    const claim = Symbol();
    stopClaimRef.current = claim;
    setPending(true);
    if (releaseTimerRef.current !== null) window.clearTimeout(releaseTimerRef.current);
    releaseTimerRef.current = null;
    repeatLatchRef.current = window.setTimeout(() => {
      repeatLatchRef.current = null;
    }, STOP_REPEAT_LATCH_MS);
    const release = (): void => {
      if (stopClaimRef.current !== claim) return;
      stopClaimRef.current = null;
      releaseTimerRef.current = null;
      setPending(false);
    };
    try {
      await onStop();
      if (stopClaimRef.current === claim) {
        releaseTimerRef.current = window.setTimeout(release, COMPOSER_ACTION_STALE_FALLBACK_MS);
      }
      return true;
    } catch {
      release();
      return false;
    }
  };
  return { stopping: pending || cancelling, stopClaimRef, stop };
}
