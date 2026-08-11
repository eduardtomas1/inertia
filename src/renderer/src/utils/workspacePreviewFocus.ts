export type WorkspacePreviewOwner = "primary" | "secondary";

const PREVIEW_FOCUS_RETRY_FRAMES = 60;

export function focusWorkspacePreviewAddress(
  owner: WorkspacePreviewOwner,
): void {
  const focusWhenMounted = (remainingFrames: number): void => {
    const ownerPane = document.getElementById(`${owner}-conversation-pane`);
    const scope = ownerPane ?? (owner === "primary" ? document : null);
    const address = scope?.querySelector<HTMLInputElement>(
      '[aria-label="Preview address"]',
    ) ?? null;
    const activeElement = document.activeElement;
    if (activeElement === address) return;
    if (
      activeElement instanceof HTMLElement
      && activeElement !== document.body
      && activeElement.isConnected
      && !activeElement.matches('[aria-label="Preview address"]')
    ) {
      return;
    }
    if (address) {
      address.focus({ preventScroll: true });
      return;
    }
    if (remainingFrames > 0) {
      window.requestAnimationFrame(() =>
        focusWhenMounted(remainingFrames - 1));
    }
  };
  window.requestAnimationFrame(() =>
    focusWhenMounted(PREVIEW_FOCUS_RETRY_FRAMES));
}
