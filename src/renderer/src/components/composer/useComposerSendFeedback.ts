import { useCallback, useEffect, useRef, useState } from "react";
import type { MessageSendAcceptance } from "@shared/contracts";
import { COMPOSER_ACTION_STALE_FALLBACK_MS } from "../../utils/composerPrimaryAction";

export const COMPOSER_SEND_FEEDBACK_MS = 900;
export const COMPOSER_SEND_FEEDBACK_RETENTION_MS =
  COMPOSER_ACTION_STALE_FALLBACK_MS + 100;

export type ComposerSendFeedback = Pick<
  MessageSendAcceptance,
  "disposition" | "turnId"
> & { visible: boolean };

interface OwnedComposerSendFeedback extends ComposerSendFeedback {
  conversationId: string;
  sequence: number;
}

export function useComposerSendFeedback(conversationId: string): readonly [
  ComposerSendFeedback | null,
  (acceptance: MessageSendAcceptance | null | void) => void,
  () => void,
] {
  const [entry, setEntry] = useState<OwnedComposerSendFeedback | null>(null);
  const visualTimerRef = useRef<number | null>(null);
  const retentionTimerRef = useRef<number | null>(null);
  const sequenceRef = useRef(0);

  useEffect(() => () => {
    if (visualTimerRef.current !== null) window.clearTimeout(visualTimerRef.current);
    if (retentionTimerRef.current !== null) {
      window.clearTimeout(retentionTimerRef.current);
    }
  }, []);

  const showAccepted = useCallback((acceptance: MessageSendAcceptance | null | void): void => {
    if (!acceptance) return;
    sequenceRef.current += 1;
    const sequence = sequenceRef.current;
    if (visualTimerRef.current !== null) window.clearTimeout(visualTimerRef.current);
    if (retentionTimerRef.current !== null) {
      window.clearTimeout(retentionTimerRef.current);
    }
    setEntry({
      conversationId,
      disposition: acceptance.disposition,
      turnId: acceptance.turnId,
      sequence,
      visible: true,
    });
    visualTimerRef.current = window.setTimeout(() => {
      visualTimerRef.current = null;
      setEntry((current) => current?.sequence === sequence
        ? { ...current, visible: false }
        : current);
    }, COMPOSER_SEND_FEEDBACK_MS);
    retentionTimerRef.current = window.setTimeout(() => {
      retentionTimerRef.current = null;
      setEntry((current) => current?.sequence === sequence ? null : current);
    }, COMPOSER_SEND_FEEDBACK_RETENTION_MS);
  }, [conversationId]);

  const clearFeedback = useCallback((): void => {
    sequenceRef.current += 1;
    if (visualTimerRef.current !== null) window.clearTimeout(visualTimerRef.current);
    if (retentionTimerRef.current !== null) {
      window.clearTimeout(retentionTimerRef.current);
    }
    visualTimerRef.current = null;
    retentionTimerRef.current = null;
    setEntry(null);
  }, []);

  return [
    entry?.conversationId === conversationId ? entry : null,
    showAccepted,
    clearFeedback,
  ] as const;
}
