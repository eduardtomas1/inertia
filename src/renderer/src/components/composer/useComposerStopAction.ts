import { useLayoutEffect, useRef, useState } from "react";

import { COMPOSER_ACTION_STALE_FALLBACK_MS } from "../../utils/composerPrimaryAction";

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
  useLayoutEffect(() => {
    setPending(false);
    return () => {
      stopClaimRef.current = null;
      if (releaseTimerRef.current !== null) window.clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
    };
  }, [conversationId, running]);

  const stop = async (): Promise<void> => {
    if (stopClaimRef.current || cancelling || !running) return;
    const claim = Symbol();
    stopClaimRef.current = claim;
    setPending(true);
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
    } catch {
      release();
    }
  };
  return { stopping: pending || cancelling, stopClaimRef, stop };
}
