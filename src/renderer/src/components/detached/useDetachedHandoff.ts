import { useCallback, useEffect, useMemo, type Dispatch, type SetStateAction } from "react";

import { prepareComposerDetachment } from "../../utils/composerOwnership";
import { dockInMainWith, openInMain, type MainWindowTarget } from "../../utils/detachedHandoff";
import { UUID_PATTERN } from "@shared/request-identifiers";
import {
  DIAGNOSTIC_NAVIGATION_EVENT,
  parseDiagnosticNavigation,
} from "../../utils/diagnosticNavigation";

export interface DetachedHandoff {
  dockInMain: () => void;
  openInMain: (target: MainWindowTarget) => void;
}

function publicError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function useDetachedHandoff(
  conversationId: string,
  setActionError: Dispatch<SetStateAction<string | null>>,
): DetachedHandoff {
  const dockInMain = useCallback(() => {
    setActionError(null);
    const preparation = prepareComposerDetachment(conversationId);
    if (preparation.status === "blocked") {
      setActionError(preparation.reason);
      return;
    }
    void dockInMainWith(preparation.draft).catch((error: unknown) => {
      setActionError(publicError(
        error,
        "This chat could not be returned to the main window.",
      ));
    });
  }, [conversationId, setActionError]);
  const openTarget = useCallback((target: MainWindowTarget) => {
    setActionError(null);
    void openInMain(target).catch((error: unknown) => {
      setActionError(publicError(error, "The main window could not be opened."));
    });
  }, [setActionError]);
  useEffect(() => {
    const navigate = (event: Event): void => {
      const target = parseDiagnosticNavigation((event as CustomEvent<unknown>).detail);
      if (!target) return;
      const turnId = "conversationId" in target ? undefined : target.selection?.turnId;
      openTarget("conversationId" in target
        ? { kind: "conversation", conversationId: target.conversationId }
        : turnId && UUID_PATTERN.test(turnId) ? { kind: "diagnostics", turnId } : { kind: "diagnostics" });
    };
    window.addEventListener(DIAGNOSTIC_NAVIGATION_EVENT, navigate);
    return () => window.removeEventListener(DIAGNOSTIC_NAVIGATION_EVENT, navigate);
  }, [openTarget]);
  return useMemo(() => ({ dockInMain, openInMain: openTarget }), [dockInMain, openTarget]);
}
