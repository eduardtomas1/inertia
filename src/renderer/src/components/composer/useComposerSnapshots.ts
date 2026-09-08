import { useEffect, useRef, type RefObject } from "react";
import type { SnapshotDelivery } from "@shared/snapshots";
import type { DesktopBridge } from "@shared/desktop";
import type { ComposerAttachmentAdoptionResult, ComposerAttachmentImportLease } from "../../utils/composerAttachments";

type Registration = { conversationId: string; activate(): void; receive(event: SnapshotDelivery): void };
const composers = new Set<Registration>();
let focused: Registration | null = null;
const subscribedBridges = new WeakSet<DesktopBridge>();
const hotSubscriptions = import.meta.hot?.data ? new Set<() => void>() : null;
if (import.meta.hot && hotSubscriptions) {
  // Composer can accept this dependency update without disposing this module.
  // Retire its previous sink on re-evaluation as well as explicit disposal.
  const previous: unknown = import.meta.hot.data.snapshotSubscriptionsCleanup;
  if (typeof previous === "function") previous();
  const cleanup = (): void => {
    for (const unsubscribe of hotSubscriptions) unsubscribe();
    hotSubscriptions.clear();
    composers.clear();
    focused = null;
  };
  import.meta.hot.data.snapshotSubscriptionsCleanup = cleanup;
  import.meta.hot.dispose(cleanup);
}
const report = (message: string, conversationId = focused?.conversationId): void => {
  window.dispatchEvent(new CustomEvent("inertia:snapshot-error", { detail: { message, conversationId } }));
};

// A window has one delivery subscriber even when two composers are mounted.
function receive(bridge: DesktopBridge, event: SnapshotDelivery): void {
  const destination = focused?.conversationId === event.conversationId ? focused
    : [...composers].find(({ conversationId }) => conversationId === event.conversationId);
  if (destination) { destination.receive(event); return; }
  if (event.selection) {
    void bridge.cancelAttachmentImport(event.selection.batchId).catch(() => undefined);
    report("The selected chat changed. Take the snapshot again in the chat you want to use.");
  }
}

export function useComposerSnapshots(
  conversationId: string,
  adopt: (lease: ComposerAttachmentImportLease) => Promise<ComposerAttachmentAdoptionResult>,
  textarea: RefObject<HTMLTextAreaElement | null>,
): void {
  const current = useRef({ adopt, conversationId });
  current.current = { adopt, conversationId };
  useEffect(() => {
    const bridge = window.inertia;
    if (!bridge?.snapshot || !bridge.onSnapshot) return;
    let interactionRevision = 0;
    const interacted = (): void => { interactionRevision += 1; };
    const registration: Registration = {
      conversationId,
      activate: () => {
        focused = registration;
        void bridge.snapshot({ type: "bind", conversationId }).catch(() => undefined);
      },
      receive: (event) => {
        if (!event.selection) { if (current.current.conversationId === event.conversationId) report(event.error, conversationId); return; }
        const selection = event.selection;
        if (current.current.conversationId !== event.conversationId) {
          void bridge.cancelAttachmentImport(selection.batchId).catch(() => undefined);
          report("The selected chat changed. Take the snapshot again in the chat you want to use.");
          return;
        }
        const stillCurrent = (): boolean => composers.has(registration) && current.current.conversationId === event.conversationId;
        const adoptionRevision = interactionRevision;
        void current.current.adopt({
          attachments: selection.attachments,
          commit: async (ids) => await bridge.commitAttachmentImport(selection.batchId, [...ids]),
          cancel: async () => await bridge.cancelAttachmentImport(selection.batchId),
        }).then((result) => {
          if (!stillCurrent()) return;
          if (result === "adopted" && focused === registration && adoptionRevision === interactionRevision) textarea.current?.focus();
          else if (result === "rejected") report("Snapshot could not be attached.", conversationId);
        }).catch(() => { if (stillCurrent()) report("Snapshot could not be attached.", conversationId); });
      },
    };
    composers.add(registration);
    // Keep one window-lifetime listener to cancel orphaned deliveries even if
    // the native unbind acknowledgment arrives before a queued capture event.
    if (!subscribedBridges.has(bridge)) {
      const unsubscribe = bridge.onSnapshot((event) => receive(bridge, event));
      hotSubscriptions?.add(unsubscribe);
      subscribedBridges.add(bridge);
    }
    const pane = textarea.current?.closest(".conversation-pane-chat") ?? textarea.current?.closest(".composer");
    pane?.addEventListener("pointerdown", registration.activate);
    pane?.addEventListener("focusin", registration.activate);
    document.addEventListener("focusin", interacted, true);
    document.addEventListener("pointerdown", interacted, true);
    window.addEventListener("blur", interacted);
    const restore = (): void => { if (focused === registration || !focused) registration.activate(); };
    restore(); window.addEventListener("focus", restore);
    return () => {
      pane?.removeEventListener("pointerdown", registration.activate);
      pane?.removeEventListener("focusin", registration.activate);
      document.removeEventListener("focusin", interacted, true);
      document.removeEventListener("pointerdown", interacted, true);
      window.removeEventListener("blur", interacted);
      window.removeEventListener("focus", restore); composers.delete(registration);
      if (focused === registration) { focused = null; composers.values().next().value?.activate(); }
      if (composers.size === 0) {
        void bridge.snapshot({ type: "unbind" }).catch(() => undefined);
      }
    };
  }, [conversationId, textarea]);
}
