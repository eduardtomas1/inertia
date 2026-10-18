export function focusWasLost(origin: Element | null): boolean {
  const active = document.activeElement;
  return !active
    || active === document.body
    || !active.isConnected
    || active.matches(":disabled")
    || (origin !== null && origin !== document.body && origin.contains(active));
}

export function composerFocusRestorer(origin: Element | null): () => void {
  const workspace = origin?.closest(".chat-workspace");
  const turn = origin?.closest<HTMLElement>(".response-turn");
  return () => {
    if (!focusWasLost(origin)) return;
    const composer = workspace?.querySelector<HTMLTextAreaElement>(
      'section[aria-label="Message composer"] textarea:not(:disabled)',
    );
    (composer ?? turn)?.focus({ preventScroll: true });
  };
}
