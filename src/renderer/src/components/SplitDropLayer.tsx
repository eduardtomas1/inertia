import { useEffect, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";

import { useMediaQuery } from "../hooks/useMediaQuery";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import {
  currentChatDrag,
  registerChatDropTarget,
  subscribeChatDrag,
} from "../utils/chatDrag";
import {
  splitDropRect,
  splitDropZones,
  type SplitDropZone,
} from "../utils/splitConversation";
import {
  PINNED_SPLIT_OWNERS,
  type SplitDropPlan,
  type SplitPaneOwner,
} from "../utils/splitLayout";

const PANE_OWNERS: readonly string[] = ["primary", ...PINNED_SPLIT_OWNERS];

interface SplitDropLayerProps {
  surfaceRef: RefObject<HTMLElement | null>;
  planDrop:
    | ((
        conversationId: string,
        target: SplitPaneOwner,
        zones: readonly SplitDropZone[],
      ) => SplitDropPlan | null)
    | null;
  onDrop: (conversationId: string, plan: SplitDropPlan) => void;
}

export function SplitDropLayer({
  surfaceRef,
  planDrop,
  onDrop,
}: SplitDropLayerProps): React.JSX.Element | null {
  const drag = useSyncExternalStore(subscribeChatDrag, currentChatDrag);
  const stackedOnly = useMediaQuery("(max-width: 860px)");
  useNativePreviewSuspension(drag !== null);

  useEffect(() => {
    if (!planDrop) return;
    return registerChatDropTarget({
      resolve: (conversationId, x, y) => {
        const surface = surfaceRef.current;
        const hit = document.elementFromPoint(x, y);
        if (!surface || !hit || !surface.contains(hit)) return null;
        const pane = hit.closest<HTMLElement>("[data-split-pane-owner]");
        const owner = pane?.dataset.splitPaneOwner ?? "primary";
        if (
          (!pane && surface.querySelector(".conversation-split-view"))
          || !PANE_OWNERS.includes(owner)
        ) {
          return null;
        }
        const rect = (pane ?? surface).getBoundingClientRect();
        const plan = planDrop(
          conversationId,
          owner as SplitPaneOwner,
          splitDropZones(rect, x, y, stackedOnly),
        );
        if (!plan) return null;
        return plan.kind === "swap" || plan.kind === "replace"
          ? { plan, left: rect.left, top: rect.top, width: rect.width, height: rect.height }
          : { plan, ...splitDropRect(rect, plan.zone) };
      },
      drop: (conversationId, target) => onDrop(conversationId, target.plan),
    });
  }, [onDrop, planDrop, stackedOnly, surfaceRef]);

  if (!drag) return null;
  const target = drag.target;
  return createPortal(
    <>
      {target && (
        <div
          className="split-drop-highlight"
          data-split-drop-action={target.plan.kind}
          data-split-drop-zone={"zone" in target.plan ? target.plan.zone : undefined}
          aria-hidden="true"
          style={{
            left: target.left,
            top: target.top,
            width: target.width,
            height: target.height,
          }}
        >
          {target.plan.kind === "replace"
            ? "Replace chat"
            : target.plan.kind === "swap" ? "Swap chats" : null}
        </div>
      )}
      <div
        className="chat-drag-chip"
        aria-hidden="true"
        style={{ transform: `translate(${drag.x + 14}px, ${drag.y + 12}px)` }}
      >
        {drag.title}
      </div>
    </>,
    document.body,
  );
}
