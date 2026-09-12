import { useEffect } from "react";
import type { Conversation } from "@shared/contracts";
import {
  DIAGNOSTIC_NAVIGATION_EVENT,
  parseDiagnosticNavigation,
  type DiagnosticNavigation,
} from "../utils/diagnosticNavigation";

export function useDiagnosticNavigation({
  conversations, online, selectConversation, showWorkspace, openSettings, setActionError,
}: {
  conversations: readonly Conversation[] | undefined;
  online: boolean;
  selectConversation: (conversation: Conversation) => void;
  showWorkspace: () => void;
  openSettings: (target: Exclude<DiagnosticNavigation, { conversationId: string }>) => void;
  setActionError: (message: string) => void;
}): void {
  useEffect(() => {
    const navigate = (event: Event): void => {
      const target = parseDiagnosticNavigation((event as CustomEvent<unknown>).detail);
      if (!target) return;
      if ("conversationId" in target) {
        const affected = conversations?.find(({ id }) => id === target.conversationId);
        if (!affected || !online) {
          setActionError("This conversation is unavailable. Its diagnostic record is still readable.");
          return;
        }
        showWorkspace();
        selectConversation(affected);
      } else openSettings(target);
    };
    window.addEventListener(DIAGNOSTIC_NAVIGATION_EVENT, navigate);
    return () => window.removeEventListener(DIAGNOSTIC_NAVIGATION_EVENT, navigate);
  }, [conversations, online, selectConversation, showWorkspace, openSettings, setActionError]);
}
