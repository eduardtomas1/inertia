import { useEffect, useRef, type RefObject } from "react";
import type { DesktopBridge } from "@shared/desktop";
import type { PreviewAnnotationDelivery } from "@shared/preview-annotation";
import type {
  ComposerAttachmentAdoptionResult,
  ComposerAttachmentImportLease,
} from "../../utils/composerAttachments";

interface ComposerPreviewAnnotationRegistration {
  conversationId: string;
  receive(event: PreviewAnnotationDelivery): void;
  reportError(message: string): void;
}

const registrations = new Set<ComposerPreviewAnnotationRegistration>();
const subscribedBridges = new WeakSet<DesktopBridge>();
const hotCleanups = import.meta.hot?.data ? new Set<() => void>() : null;

if (import.meta.hot && hotCleanups) {
  const previous: unknown = import.meta.hot.data.previewAnnotationSubscriptionsCleanup;
  if (typeof previous === "function") previous();
  const cleanup = (): void => {
    for (const unsubscribe of hotCleanups) unsubscribe();
    hotCleanups.clear();
    registrations.clear();
  };
  import.meta.hot.data.previewAnnotationSubscriptionsCleanup = cleanup;
  import.meta.hot.dispose(cleanup);
}

export const PREVIEW_ANNOTATION_CONVERSATION_MISMATCH =
  "The page annotation belongs to a different chat and was not attached.";

export function dispatchPreviewAnnotationDelivery(
  bridge: Pick<DesktopBridge, "cancelAttachmentImport" | "commitAttachmentImport">,
  event: PreviewAnnotationDelivery,
  targets: Iterable<ComposerPreviewAnnotationRegistration> = registrations,
): boolean {
  const list = [...targets];
  const destination = list.find(({ conversationId }) => conversationId === event.conversationId);
  if (destination) {
    destination.receive(event);
    return true;
  }
  if (event.selection) {
    void bridge.cancelAttachmentImport(event.selection.batchId).catch(() => undefined);
    list[0]?.reportError(PREVIEW_ANNOTATION_CONVERSATION_MISMATCH);
  }
  return false;
}

export function useComposerPreviewAnnotations(
  conversationId: string,
  adopt: (lease: ComposerAttachmentImportLease) => Promise<ComposerAttachmentAdoptionResult>,
  reportError: (message: string) => void,
  textarea: RefObject<HTMLTextAreaElement | null>,
): void {
  const current = useRef({ adopt, conversationId, reportError });
  current.current = { adopt, conversationId, reportError };

  useEffect(() => {
    const bridge = window.inertia;
    if (!bridge?.onPreviewAnnotation) return;

    const registration: ComposerPreviewAnnotationRegistration = {
      conversationId,
      reportError: (message) => current.current.reportError(message),
      receive: (event) => {
        if (current.current.conversationId !== event.conversationId) {
          if (event.selection) {
            void bridge.cancelAttachmentImport(event.selection.batchId).catch(() => undefined);
          }
          current.current.reportError(PREVIEW_ANNOTATION_CONVERSATION_MISMATCH);
          return;
        }
        if (!event.selection) {
          current.current.reportError(event.error);
          return;
        }
        const selection = event.selection;
        const stillCurrent = (): boolean =>
          registrations.has(registration)
          && current.current.conversationId === event.conversationId;
        void current.current.adopt({
          attachments: selection.attachments,
          commit: async (ids) => await bridge.commitAttachmentImport(selection.batchId, [...ids]),
          cancel: async () => await bridge.cancelAttachmentImport(selection.batchId),
        }).then((result) => {
          if (!stillCurrent()) return;
          if (result === "adopted") {
            textarea.current?.focus();
          } else if (result === "rejected") {
            current.current.reportError("Page annotation could not be attached.");
          }
        }).catch(() => {
          if (stillCurrent()) {
            current.current.reportError("Page annotation could not be attached.");
          }
        });
      },
    };

    registrations.add(registration);
    if (!subscribedBridges.has(bridge)) {
      const unsubscribe = bridge.onPreviewAnnotation((event) => {
        dispatchPreviewAnnotationDelivery(bridge, event);
      });
      hotCleanups?.add(unsubscribe);
      subscribedBridges.add(bridge);
    }

    return () => {
      registrations.delete(registration);
    };
  }, [conversationId, textarea]);
}
