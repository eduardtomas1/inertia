export type WorkspacePreviewOwner = "primary" | "secondary";

export function focusWorkspacePreviewAddress(
  owner: WorkspacePreviewOwner,
): void {
  window.requestAnimationFrame(() => {
    const ownerPane = document.getElementById(`${owner}-conversation-pane`);
    const scope = ownerPane ?? (owner === "primary" ? document : null);
    scope?.querySelector<HTMLInputElement>('[aria-label="Preview address"]')
      ?.focus({ preventScroll: true });
  });
}
