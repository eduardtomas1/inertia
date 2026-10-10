import { useEffect, useRef } from "react";
import type { ServerEvent, WorkspaceRun } from "@shared/contracts";

import type { CommandWithoutId } from "../lib/runtimeCommands";
import { shouldMarkWorkspaceRunSeen } from "../utils/attentionVisibility";

export function useMarkRunSeen({
  request,
  run,
  conversationId,
  workspaceVisible,
  latestContentVisible,
  obstructed,
  refresh,
}: {
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  run: WorkspaceRun | null;
  conversationId: string | null;
  workspaceVisible: boolean;
  latestContentVisible: boolean;
  obstructed: boolean;
  refresh: number;
}): void {
  const pendingRef = useRef(new Set<string>());
  useEffect(() => {
    if (
      !run
      || pendingRef.current.has(run.id)
      || !shouldMarkWorkspaceRunSeen(run, conversationId, {
        documentVisible: document.visibilityState === "visible",
        documentFocused: document.hasFocus(),
        workspaceVisible,
        latestContentVisible,
        obstructed,
      })
    ) return;
    pendingRef.current.add(run.id);
    void request({
      type: "activity.mark-seen",
      payload: { runId: run.id },
    }).catch(() => undefined).finally(() => {
      pendingRef.current.delete(run.id);
    });
  }, [conversationId, latestContentVisible, obstructed, refresh, request, run, workspaceVisible]);
}
