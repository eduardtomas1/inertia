import { useEffect, useRef, useState } from "react";
import type { MessageSendAcceptance } from "@shared/contracts";
import { COMPOSER_ACTION_STALE_FALLBACK_MS } from "../../utils/composerPrimaryAction";

export const COMPOSER_SEND_FEEDBACK_MS = 900;
export const COMPOSER_SEND_FEEDBACK_RETENTION_MS =
  COMPOSER_ACTION_STALE_FALLBACK_MS + 100;

export type ComposerSendFeedback = Pick<
  MessageSendAcceptance,
  "disposition" | "turnId"
> & { visible: boolean };

export function useComposerSendFeedback(
  conversationId: string,
  acceptance: MessageSendAcceptance | null,
): ComposerSendFeedback | null {
  const [entry, setEntry] = useState<ComposerSendFeedback | null>(null);
  const shownMessageIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!acceptance) {
      shownMessageIdRef.current = null;
      setEntry(null);
      return;
    }
    if (acceptance.conversationId !== conversationId) {
      setEntry(null);
      return;
    }
    if (shownMessageIdRef.current === acceptance.userMessageId) return;
    shownMessageIdRef.current = acceptance.userMessageId;
    setEntry({
      disposition: acceptance.disposition,
      turnId: acceptance.turnId,
      visible: true,
    });
    const visualTimer = window.setTimeout(() => {
      setEntry((current) => current ? { ...current, visible: false } : current);
    }, COMPOSER_SEND_FEEDBACK_MS);
    const retentionTimer = window.setTimeout(() => {
      setEntry(null);
    }, COMPOSER_SEND_FEEDBACK_RETENTION_MS);
    return () => {
      window.clearTimeout(visualTimer);
      window.clearTimeout(retentionTimer);
    };
  }, [acceptance, conversationId]);
  return acceptance?.conversationId === conversationId ? entry : null;
}
