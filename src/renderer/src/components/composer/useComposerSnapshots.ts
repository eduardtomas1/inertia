import { useEffect, useRef, type RefObject } from "react";
import type { SnapshotDelivery } from "@shared/snapshots";
import type { DesktopBridge } from "@shared/desktop";
import type { ComposerAttachmentImportLease } from "../../utils/composerAttachments";

type Registration = { conversationId: string; activate(): void; receive(event: SnapshotDelivery): void };
const composers = new Set<Registration>();
let focused: Registration | null = null;
let unsubscribe: (() => void) | null = null;
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
  adopt: (lease: ComposerAttachmentImportLease) => Promise<void>,
  textarea: RefObject<HTMLTextAreaElement | null>,
): void {
  const current = useRef({ adopt, conversationId });
  current.current = { adopt, conversationId };
  useEffect(() => {
    const bridge = window.inertia;
    if (!bridge?.snapshot || !bridge.onSnapshot) return;
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
        void current.current.adopt({
          attachments: selection.attachments,
          commit: async (ids) => await bridge.commitAttachmentImport(selection.batchId, [...ids]),
          cancel: async () => await bridge.cancelAttachmentImport(selection.batchId),
        }).then(() => { if (composers.has(registration) && current.current.conversationId === event.conversationId) textarea.current?.focus(); })
          .catch(() => report("Snapshot could not be attached.", conversationId));
      },
    };
    composers.add(registration);
    unsubscribe ??= bridge.onSnapshot((event) => receive(bridge, event));
    const pane = textarea.current?.closest(".conversation-pane-chat") ?? textarea.current?.closest(".composer");
    pane?.addEventListener("pointerdown", registration.activate);
    pane?.addEventListener("focusin", registration.activate);
    const restore = (): void => { if (focused === registration || !focused) registration.activate(); };
    restore(); window.addEventListener("focus", restore);
    return () => {
      pane?.removeEventListener("pointerdown", registration.activate);
      pane?.removeEventListener("focusin", registration.activate);
      window.removeEventListener("focus", restore); composers.delete(registration);
      if (focused === registration) { focused = null; composers.values().next().value?.activate(); }
      if (composers.size === 0) { unsubscribe?.(); unsubscribe = null; }
    };
  }, [conversationId, textarea]);
}
