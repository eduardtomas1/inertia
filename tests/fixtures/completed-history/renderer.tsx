import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AgentActivity } from "../../../src/shared/contracts";
import { ActivityGroup } from "../../../src/renderer/src/components/response-timeline/activity";
import { useDocumentPresence } from "../../../src/renderer/src/hooks/useDocumentPresence";
import "../../../src/renderer/src/styles.css";

declare global {
  interface Window {
    mountCompletedHistory(): void;
    inspectCompletedHistory(): {
      visibility: DocumentVisibilityState;
      count: number;
      completed: number;
      icons: number;
      expanded: string | null | undefined;
      summary: string | null | undefined;
      pending: Array<{
        type: string; property: string | null; pending: boolean; time: CSSNumberish | null;
      }>;
    };
  }
}

const root = createRoot(document.getElementById("root")!);
const base = {
  conversationId: "native-history", runId: "native-run", turnId: "native-turn",
  detail: null, createdAt: "2026-01-01T00:00:00.000Z",
};
const activities: AgentActivity[] = [
  { ...base, id: "edit", kind: "file", title: "Editing backend adapter", status: "running" },
  { ...base, id: "command", kind: "command", title: "Running focused tests", status: "running" },
  ...Array.from({ length: 320 }, (_, index): AgentActivity => ({
    ...base, id: "patch-" + index, kind: "tool", title: "Patch updated",
    detail: "Diff:\nedit-heavy fixture patch " + index, status: "completed",
  })),
];

function History(): React.JSX.Element {
  useDocumentPresence();
  return <ActivityGroup entry={{
    kind: "activity-group", id: "native-history-group", createdAt: base.createdAt, activities,
  }} settled={false} />;
}

window.mountCompletedHistory = () => flushSync(() => root.render(<History />));
window.inspectCompletedHistory = () => {
  const rows = [...document.querySelectorAll(".agent-activity")]
    .filter((row) => row.textContent?.includes("Patch updated"));
  const summary = document.querySelector(".turn-activity-group-summary");
  return {
    visibility: document.visibilityState,
    count: rows.length,
    completed: rows.filter((row) => row.classList.contains("is-completed")).length,
    icons: rows.filter((row) => row.querySelector(".lucide-wrench")).length,
    expanded: summary?.getAttribute("aria-expanded"),
    summary: summary?.getAttribute("aria-label"),
    pending: rows.flatMap((row) => row.getAnimations({ subtree: true })
      .filter((animation) => animation.pending || animation.playState === "running")
      .map((animation) => ({
        type: animation.constructor.name,
        property: animation instanceof CSSTransition ? animation.transitionProperty : null,
        pending: animation.pending,
        time: animation.currentTime,
      }))),
  };
};
