const COMPOSER_EDITOR = '#primary-conversation-pane textarea[aria-label="Message"], .chat-workspace textarea[aria-label="Message"]';
const BLOCKING_LAYER = '[role="dialog"][aria-modal="true"]';
const SETTLE_WINDOW_MS = 800;

function typingElsewhere(active: Element | null): boolean {
  if (!(active instanceof HTMLElement) || active === document.body) return false;
  if (active.matches('textarea[aria-label="Message"]')) return false;
  return active.isContentEditable || active.matches("input, textarea, select");
}

export function focusNewChatComposer(): void {
  const deadline = performance.now() + SETTLE_WINDOW_MS;
  const attempt = (): void => {
    if (typingElsewhere(document.activeElement)) return;
    const editor = document.querySelector<HTMLTextAreaElement>(COMPOSER_EDITOR);
    if (editor && !editor.disabled && !document.querySelector(BLOCKING_LAYER)) {
      editor.focus({ preventScroll: true });
      return;
    }
    if (performance.now() < deadline) window.requestAnimationFrame(attempt);
  };
  window.requestAnimationFrame(attempt);
}
