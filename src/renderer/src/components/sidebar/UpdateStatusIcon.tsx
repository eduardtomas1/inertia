import { Check, Download, RefreshCw, RotateCw, TriangleAlert } from "lucide-react";
import type { UpdateIconState } from "./appUpdatePresentation";

export function UpdateStatusIcon({ state, percent, animate, onIteration }: {
  state: UpdateIconState; percent: number | null; animate: boolean; onIteration: () => void;
}): React.JSX.Element {
  if (state === "downloading") return <span className="update-status-icon is-downloading" aria-hidden="true">
    <svg className="update-progress-ring" viewBox="0 0 32 32">
      <circle className="update-progress-track" cx="16" cy="16" r="14" />
      <circle className="update-progress-value" cx="16" cy="16" r="14" pathLength="100"
        strokeDasharray={percent === null ? "20 80" : "100"} strokeDashoffset={percent === null ? "0" : 100 - percent} />
    </svg><Download size={16} />
  </span>;
  if (state === "downloaded") return <span className="update-status-icon" aria-hidden="true">
    <RotateCw size={16} /><span className="update-ready-badge"><Check size={8} strokeWidth={3} /></span>
  </span>;
  if (state === "available") return <span className="update-status-icon" aria-hidden="true"><Download size={16} /><span className="update-available-dot" /></span>;
  if (state === "attention") return <TriangleAlert size={16} aria-hidden="true" />;
  return <span aria-hidden="true" className={`update-status-icon${animate ? " is-checking" : ""}`} onAnimationIteration={onIteration}>
    <RefreshCw size={16} />
  </span>;
}
