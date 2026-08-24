import { useEffect, useRef, type RefObject } from "react";

export type WorkspacePreviewOwner = "primary" | "secondary";

interface PendingPreviewTabCloseFocus {
  closedTabId: string;
  initialActiveElement: Element | null;
}

export function usePreviewTabCloseFocus(
  tabs: readonly { id: string }[],
  activeTabId: string | null,
  tabRefs: RefObject<Map<string, HTMLButtonElement>>,
): (closedTabId: string) => void {
  const pending = useRef<PendingPreviewTabCloseFocus | null>(null);
  useEffect(() => {
    const request = pending.current;
    if (!request || tabs.some((tab) => tab.id === request.closedTabId)) return;
    const activeElement = document.activeElement;
    if (
      activeElement !== request.initialActiveElement
      && activeElement instanceof HTMLElement
      && activeElement !== document.body
      && activeElement.isConnected
    ) {
      pending.current = null;
      return;
    }
    const targetId = activeTabId ?? tabs[0]?.id;
    if (!targetId) return;
    const element = tabRefs.current.get(targetId);
    if (!element) return;
    pending.current = null;
    element.focus();
  }, [activeTabId, tabRefs, tabs]);
  return (closedTabId) => {
    pending.current = {
      closedTabId,
      initialActiveElement: document.activeElement,
    };
  };
}

export function routeWorkspaceRunPreview<Run extends {
  conversationId: string | null;
}>(
  run: Run,
  secondaryConversationId: string | null,
  openPrimary: (run: Run) => void,
  openSecondary: (run: Run) => void,
): void {
  if (
    run.conversationId !== null
    && run.conversationId === secondaryConversationId
  ) {
    openSecondary(run);
    return;
  }
  openPrimary(run);
}

interface PendingWorkspacePreviewFocus {
  owner: WorkspacePreviewOwner;
  initialActiveElement: Element | null;
  cancel: () => void;
}

let pendingFocus: PendingWorkspacePreviewFocus | null = null;

function clearPendingFocus(
  request: PendingWorkspacePreviewFocus,
): void {
  if (pendingFocus !== request) return;
  pendingFocus = null;
  request.cancel();
}

function focusAddress(
  request: PendingWorkspacePreviewFocus,
  address: HTMLInputElement,
): void {
  const activeElement = document.activeElement;
  if (
    activeElement !== request.initialActiveElement
    && activeElement instanceof HTMLElement
    && activeElement !== document.body
    && activeElement.isConnected
    && !activeElement.matches('[aria-label="Preview address"]')
  ) {
    clearPendingFocus(request);
    return;
  }
  clearPendingFocus(request);
  address.focus({ preventScroll: true });
}

function previewAddress(
  owner: WorkspacePreviewOwner,
): HTMLInputElement | null {
  const ownerPane = document.getElementById(`${owner}-conversation-pane`);
  const scope = ownerPane ?? (owner === "primary" ? document : null);
  return scope?.querySelector<HTMLInputElement>(
    '[aria-label="Preview address"]',
  ) ?? null;
}

export function focusWorkspacePreviewAddress(
  owner: WorkspacePreviewOwner,
): void {
  pendingFocus?.cancel();
  pendingFocus = null;
  const cancelForUserFocus = (event: FocusEvent): void => {
    const target = event.target;
    if (
      target instanceof HTMLElement
      && !target.matches('[aria-label="Preview address"]')
    ) {
      request.cancel();
    }
  };
  const cancelForUserInput = (): void => request.cancel();
  const cancel = (): void => {
    if (pendingFocus === request) pendingFocus = null;
    document.removeEventListener("focusin", cancelForUserFocus, true);
    document.removeEventListener("pointerdown", cancelForUserInput, true);
    document.removeEventListener("keydown", cancelForUserInput, true);
    window.removeEventListener("blur", cancelForUserInput);
  };
  const request: PendingWorkspacePreviewFocus = {
    owner,
    initialActiveElement: document.activeElement,
    cancel,
  };
  pendingFocus = request;
  document.addEventListener("focusin", cancelForUserFocus, true);
  document.addEventListener("pointerdown", cancelForUserInput, true);
  document.addEventListener("keydown", cancelForUserInput, true);
  window.addEventListener("blur", cancelForUserInput);

  const address = previewAddress(owner);
  if (address) focusAddress(request, address);
}

export function registerWorkspacePreviewAddress(
  owner: WorkspacePreviewOwner,
  address: HTMLInputElement | null,
): void {
  const request = pendingFocus;
  if (!address || !request || request.owner !== owner) return;
  focusAddress(request, address);
}
