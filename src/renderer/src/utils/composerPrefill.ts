export const COMPOSER_PREFILL_EVENT = "inertia:composer-prefill";

export interface ComposerPrefillDetail {
  conversationId: string;
  text: string;
}

/** Shown when no message box for the chat is open to receive the text. */
export const COMPOSER_PREFILL_UNAVAILABLE =
  "Open this chat's message box to add the selection.";

export interface ComposerPrefillTarget {
  /** Read at delivery time: a message box can switch chats while mounted. */
  conversationId(): string;
  receive(text: string): void;
}

const targets: ComposerPrefillTarget[] = [];

function currentTarget(conversationId: string): ComposerPrefillTarget | undefined {
  for (let index = targets.length - 1; index >= 0; index -= 1) {
    const target = targets[index]!;
    if (target.conversationId() === conversationId) return target;
  }
  return undefined;
}

/** The most recently mounted message box showing a chat receives prefilled text. */
export function registerComposerPrefillTarget(target: ComposerPrefillTarget): () => void {
  targets.push(target);
  return () => {
    const index = targets.lastIndexOf(target);
    if (index >= 0) targets.splice(index, 1);
  };
}

export function hasComposerPrefillTarget(conversationId: string): boolean {
  return currentTarget(conversationId) !== undefined;
}

/**
 * Adds text to the chat's open message box and reports whether one received
 * it. Callers keep their selection when nothing did. The window event stays
 * as a notification for observers; it never delivers the text itself.
 */
export function requestComposerPrefill(detail: ComposerPrefillDetail): boolean {
  const target = typeof detail.text === "string" ? currentTarget(detail.conversationId) : undefined;
  window.dispatchEvent(new CustomEvent<ComposerPrefillDetail>(
    COMPOSER_PREFILL_EVENT,
    { detail },
  ));
  if (!target) return false;
  target.receive(detail.text);
  return true;
}
