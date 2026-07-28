import { useMemo } from "react";

import type { WorkspaceRun } from "@shared/contracts";
import type { WorkspacePanelTab } from "../components/WorkspacePanel";

export interface PaneActivityActions {
  activateContext: (
    activity: WorkspaceRun,
    tool?: WorkspacePanelTab,
  ) => void;
  openActivityPreview: (activity: WorkspaceRun) => void;
  rerunActivity: (activity: WorkspaceRun) => void;
}

interface ActivityActionRouterOptions {
  primary: PaneActivityActions;
  secondary: PaneActivityActions;
  secondaryConversationId: string | null;
}

/**
 * Routes workspace-owned activity controls to the pane already displaying
 * their conversation. A split chat remains secondary while either pane is
 * busy, so selection alone cannot decide which terminal or preview owns it.
 */
export function useActivityActionRouter({
  primary,
  secondary,
  secondaryConversationId,
}: ActivityActionRouterOptions): PaneActivityActions {
  return useMemo(() => {
    const actionsFor = (activity: WorkspaceRun): PaneActivityActions =>
      activity.conversationId !== null
      && activity.conversationId === secondaryConversationId
        ? secondary
        : primary;
    return {
      activateContext: (activity, tool) =>
        actionsFor(activity).activateContext(activity, tool),
      openActivityPreview: (activity) =>
        actionsFor(activity).openActivityPreview(activity),
      rerunActivity: (activity) =>
        actionsFor(activity).rerunActivity(activity),
    };
  }, [primary, secondary, secondaryConversationId]);
}
