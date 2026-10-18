export function emulateDisabledFocusFixup(): () => void {
  const observer = new MutationObserver(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !active.matches(":disabled")) return;
    const sink = document.createElement("span");
    sink.tabIndex = -1;
    document.body.append(sink);
    sink.focus();
    sink.remove();
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ["disabled"], subtree: true });
  return () => observer.disconnect();
}
