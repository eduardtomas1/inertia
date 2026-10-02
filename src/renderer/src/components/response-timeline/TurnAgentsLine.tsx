import type { SubagentTrace } from "@shared/contracts";
import type { WorkspacePanelTab } from "../workspacePanelTypes";
import { requestBackgroundTaskReveal } from "../../utils/backgroundTaskReveal";
import { turnAgentStatus, turnAgentStatusText } from "../../utils/turnAgentStatus";

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

export function TurnAgentsLine({
  conversationId,
  turnId,
  subagents,
  onOpenSurface,
}: {
  conversationId: string;
  turnId: string;
  subagents: readonly SubagentTrace[];
  onOpenSurface?: (surface: WorkspacePanelTab) => void;
}): React.JSX.Element | null {
  const status = turnAgentStatus(subagents);
  if (!status) return null;
  const { text, failed } = turnAgentStatusText(status);
  const content = (
    <>
      <span className={status.running > 0 ? "background-task-live" : undefined}>{text}</span>
      {failed && <>{" · "}<span className="turn-agents-danger">{failed}</span></>}
    </>
  );
  if (!onOpenSurface) return <p className="turn-agents-line">{content}</p>;
  return (
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
  );
}
