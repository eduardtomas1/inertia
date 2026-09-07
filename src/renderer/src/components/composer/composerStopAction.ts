import type { MutableRefObject } from "react";

import { COMPOSER_ACTION_STALE_FALLBACK_MS } from "../../utils/composerPrimaryAction";

interface ComposerStopActionOptions {
  conversationId: string;
  running: boolean;
  agentStopping: boolean;
  stoppingRef: MutableRefObject<boolean>;
  stopSequenceRef: MutableRefObject<number>;
  activeStopsRef: MutableRefObject<Map<string, number>>;
  mountedRef: MutableRefObject<boolean>;
  conversationIdRef: MutableRefObject<string>;
  stopReleaseTimerRef: MutableRefObject<number | null>;
  setStopping(value: boolean): void;
  onStop(): Promise<void>;
}

/** Keeps an asynchronous Stop acknowledgement owned by its original chat. */
export function composerStopAction({
  conversationId,
  running,
  agentStopping,
  stoppingRef,
  stopSequenceRef,
  activeStopsRef,
  mountedRef,
  conversationIdRef,
  stopReleaseTimerRef,
  setStopping,
  onStop,
}: ComposerStopActionOptions): () => Promise<void> {
  return async (): Promise<void> => {
    if (stoppingRef.current || agentStopping || !running) return;
    const stoppedConversationId = conversationId;
    const stopSequence = stopSequenceRef.current + 1;
    stopSequenceRef.current = stopSequence;
    activeStopsRef.current.set(stoppedConversationId, stopSequence);
    stoppingRef.current = true;
    setStopping(true);
    try {
      await onStop();
      if (
        activeStopsRef.current.get(stoppedConversationId) !== stopSequence
      ) return;
      if (
        !mountedRef.current
        || conversationIdRef.current !== stoppedConversationId
      ) {
        activeStopsRef.current.delete(stoppedConversationId);
        return;
      }
      stopReleaseTimerRef.current = window.setTimeout(() => {
        stopReleaseTimerRef.current = null;
        if (
          activeStopsRef.current.get(stoppedConversationId) !== stopSequence
        ) return;
        activeStopsRef.current.delete(stoppedConversationId);
        stoppingRef.current = false;
        if (mountedRef.current && conversationIdRef.current === stoppedConversationId) {
          setStopping(false);
        }
      }, COMPOSER_ACTION_STALE_FALLBACK_MS);
    } catch {
      if (
        activeStopsRef.current.get(stoppedConversationId) !== stopSequence
      ) return;
      activeStopsRef.current.delete(stoppedConversationId);
      stoppingRef.current = false;
      if (mountedRef.current && conversationIdRef.current === stoppedConversationId) {
        setStopping(false);
      }
    }
  };
}
