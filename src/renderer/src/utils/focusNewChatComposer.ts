const EDITOR = "textarea[aria-label=Message]";

export function focusNewChatComposer(): void {
  const deadline = performance.now() + 800;
  const attempt = (): void => {
    if (document.activeElement?.matches(`input,select,[contenteditable=true],textarea:not(${EDITOR})`)) return;
    const editor = document.querySelector<HTMLTextAreaElement>(`#primary-conversation-pane ${EDITOR}`)
      ?? document.querySelector<HTMLTextAreaElement>(`.chat-workspace ${EDITOR}`);
    if (editor && !document.querySelector("[aria-modal=true]")) editor.focus({ preventScroll: true });
    else if (performance.now() < deadline) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}
