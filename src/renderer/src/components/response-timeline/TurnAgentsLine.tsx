import type { SubagentTrace } from "@shared/contracts";
import type { WorkspacePanelTab } from "../workspacePanelTypes";
import { turnAgentStatus, turnAgentStatusText } from "../../utils/turnAgentStatus";

const MAX_FOCUS_FRAMES = 30;

function focusAgentsTab(origin: HTMLElement): void {
  const scope = origin.closest(".conversation-pane-workspace") ?? document;
  let frames = 0;
  const attempt = (): void => {
    const tab = scope.querySelector<HTMLElement>('[data-workspace-tab="agents"]');
    if (tab && !tab.closest("[hidden]")) {
      tab.focus();
      return;
    }
    frames += 1;
    if (frames < MAX_FOCUS_FRAMES) window.requestAnimationFrame(attempt);
  };
  window.requestAnimationFrame(attempt);
}

export function TurnAgentsLine({
  subagents,
  onOpenSurface,
  opensInMainWindow = false,
}: {
  subagents: readonly SubagentTrace[];
  onOpenSurface?: (surface: WorkspacePanelTab) => void;
  opensInMainWindow?: boolean;
}): React.JSX.Element | null {
  const status = turnAgentStatus(subagents);
  if (!status) return null;
  const { text, failed } = turnAgentStatusText(status);
  const content = (
    <>
      <span className={status.live > 0 ? "background-task-live" : undefined}>{text}</span>
      {failed && <>{" · "}<span className="turn-agents-danger">{failed}</span></>}
    </>
  );
  if (!onOpenSurface) return <p className="turn-agents-line">{content}</p>;
  const label = failed ? `${text} · ${failed}` : text;
  return (
    <button
      type="button"
      className="turn-agents-line"
      aria-label={`${opensInMainWindow ? "Return chat to main window" : "Open Background tasks"}, ${label}`}
      onClick={(event) => {
        onOpenSurface("agents");
        if (!opensInMainWindow) focusAgentsTab(event.currentTarget);
      }}
    >
      {content}
    </button>
  );
}
