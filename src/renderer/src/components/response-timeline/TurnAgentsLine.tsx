import { lazy, Suspense, useId, useState } from "react";
import type { SubagentTrace } from "@shared/contracts";
import type { WorkspacePanelTab } from "../workspacePanelTypes";
import { requestBackgroundTaskReveal } from "../../utils/backgroundTaskReveal";
import { turnAgentStatus, turnAgentStatusText } from "../../utils/turnAgentStatus";
import { usePhaseLockedAnimations } from "../../hooks/usePhaseLockedAnimations";
import { useDelegationActions } from "../orchestration/delegation-surface";
import "../orchestration/delegation-panel.css";

const ObservedChildView = lazy(async () => ({ default: (await import("../orchestration/observed-child-view")).ObservedChildView }));

const MAX_FOCUS_FRAMES = 30;

function focusAgentsTab(origin: HTMLElement): void {
  const scope = origin.closest(".conversation-pane-workspace") ?? document;
  let frames = 0;
  let frame = 0;
  function stop(): void {
    window.cancelAnimationFrame(frame);
    document.removeEventListener("focusin", cancel);
  }
  function cancel(event: FocusEvent): void {
    if (event.target instanceof Element && event.target.closest(".workspace-panel")) return;
    stop();
  }
  function attempt(): void {
    const tab = scope.querySelector<HTMLElement>('[data-workspace-tab="agents"]');
    if (tab && !tab.closest("[hidden]")) {
      stop();
      tab.focus();
      return;
    }
    frames += 1;
    if (frames < MAX_FOCUS_FRAMES) frame = window.requestAnimationFrame(attempt);
    else stop();
  }
  document.addEventListener("focusin", cancel);
  frame = window.requestAnimationFrame(attempt);
}

function ObservedAgents({ conversationId, turnId, turnIndex, line }: {
  conversationId: string; turnId: string; turnIndex?: number; line: React.JSX.Element;
}): React.JSX.Element {
  const run = useDelegationActions()?.run;
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (!run) return line;
  return (
    <div className="turn-agents-row">
      {line}
      <button
        type="button"
        className="turn-agents-line turn-agents-inspect"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? "Hide agent details" : "Agent details"}
      </button>
      <div id={panelId} className="turn-agents-observed" hidden={!open}>
        {open && (
          <Suspense fallback={null}>
            <ObservedChildView
              conversationId={conversationId}
              turnId={turnId}
              turnLabel={turnIndex === undefined ? "Turn" : `Turn ${turnIndex}`}
              run={run}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}

export function TurnAgentsLine({
  conversationId,
  turnId,
  turnIndex,
  subagents,
  onOpenSurface,
}: {
  conversationId: string;
  turnId: string;
  turnIndex?: number;
  subagents: readonly SubagentTrace[];
  onOpenSurface?: (surface: WorkspacePanelTab) => void;
}): React.JSX.Element | null {
  const status = turnAgentStatus(subagents);
  const liveRef = usePhaseLockedAnimations<HTMLSpanElement>((status?.running ?? 0) > 0);
  if (!status) return null;
  const { text, failed } = turnAgentStatusText(status);
  const content = (
    <>
      <span ref={liveRef} className={status.running > 0 ? "background-task-live" : undefined}>{text}</span>
      {failed && <>{" · "}<span className="turn-agents-danger">{failed}</span></>}
    </>
  );
  const observed = { conversationId, turnId, turnIndex };
  if (!onOpenSurface) return <ObservedAgents {...observed} line={<p className="turn-agents-line">{content}</p>} />;
  return <ObservedAgents {...observed} line={
    <button
      type="button"
      className="turn-agents-line"
      aria-label={`Open Background tasks, ${failed ? `${text} · ${failed}` : text}`}
      onClick={(event) => {
        requestBackgroundTaskReveal({ conversationId, turnId });
        onOpenSurface("agents");
        focusAgentsTab(event.currentTarget);
      }}
    >
      {content}
    </button>
  } />;
}
