export const COMPOSER_PREFILL_EVENT = "inertia:composer-prefill";

export interface ComposerPrefillDetail {
  conversationId: string;
  text: string;
}

export function requestComposerPrefill(detail: ComposerPrefillDetail): void {
  window.dispatchEvent(new CustomEvent<ComposerPrefillDetail>(
    COMPOSER_PREFILL_EVENT,
    { detail },
  ));
}
