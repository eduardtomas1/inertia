import { ChevronRight } from "lucide-react";
import { formatFullDateTime, formatMessageTime } from "../../lib/format";
import { TooltipText } from "../TooltipText";

export interface TurnFoldControl {
  visible: boolean;
  open: boolean;
  label: string;
  startedAt: string;
  showTimes: boolean;
  onToggle: () => void;
}

export function TurnFoldRow({
  fold,
  controlsId,
}: {
  fold: TurnFoldControl;
  controlsId: string;
}): React.JSX.Element {
  return (
    <div className="turn-fold-row" data-turn-fold-row={fold.open ? "open" : "closed"}>
      <button
        type="button"
        className="turn-fold-toggle"
        aria-expanded={fold.open}
        aria-controls={controlsId}
        onClick={fold.onToggle}
      >
        <span className="turn-fold-label">{fold.label}</span>
        <ChevronRight size={14} className="turn-fold-chevron" aria-hidden="true" />
      </button>
      {fold.showTimes && (
        <TooltipText className="turn-fold-time" tooltip={formatFullDateTime(fold.startedAt)}>
          <time dateTime={fold.startedAt}>{formatMessageTime(fold.startedAt)}</time>
        </TooltipText>
      )}
    </div>
  );
}

export function TurnBlockTime({ createdAt }: { createdAt: string }): React.JSX.Element {
  return (
    <footer className="turn-block-time">
      <TooltipText tooltip={formatFullDateTime(createdAt)}>
        <time dateTime={createdAt}>{formatMessageTime(createdAt)}</time>
      </TooltipText>
    </footer>
  );
}
