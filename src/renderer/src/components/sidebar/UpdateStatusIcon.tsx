import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw, RotateCw, TriangleAlert } from "lucide-react";
import type { UpdateIconState } from "./appUpdatePresentation";

type SpinPhase = "rest" | "start" | "run" | "settle";

const SPIN_CLASS: Record<SpinPhase, string> = {
  rest: "",
  start: " is-spin-start",
  run: " is-spinning",
  settle: " is-spin-settle",
};

export function UpdateStatusIcon({ state, percent, spinning, reducedMotion, onMovingChange }: {
  state: UpdateIconState; percent: number | null; spinning: boolean; reducedMotion: boolean;
  onMovingChange: (moving: boolean) => void;
}): React.JSX.Element {
  const [phase, setPhase] = useState<SpinPhase>("rest");
  const wanted = useRef(spinning);
  wanted.current = spinning;
  const spinnable = state === "idle" || state === "checking";
  useEffect(() => {
    if (!spinnable) setPhase("rest");
    else if (reducedMotion) setPhase(spinning ? "run" : "rest");
    else if (spinning) setPhase((current) => current === "rest" ? "start" : current);
  }, [spinnable, spinning, reducedMotion]);
  useEffect(() => { onMovingChange(phase !== "rest"); }, [phase, onMovingChange]);
  if (state === "downloading") return <span className="update-status-icon is-downloading" aria-hidden="true">
    <svg className="update-progress-ring" viewBox="0 0 32 32">
      <circle className="update-progress-track" cx="16" cy="16" r="14" />
      <circle className="update-progress-value" cx="16" cy="16" r="14" pathLength="100"
        strokeDasharray={percent === null ? "20 80" : "100"} strokeDashoffset={percent === null ? "0" : 100 - percent} />
    </svg><Download size={16} />
  </span>;
  if (state === "downloaded" || state === "installing") return <span className="update-status-icon" aria-hidden="true">
    <RotateCw size={16} />
  </span>;
  if (state === "available") return <span className="update-status-icon" aria-hidden="true"><Download size={16} /></span>;
  if (state === "attention") return <TriangleAlert size={16} aria-hidden="true" />;
  return <span aria-hidden="true" className={`update-status-icon${SPIN_CLASS[phase]}`}
    onAnimationEnd={(event) => {
      if (event.target !== event.currentTarget) return;
      if (phase === "start") setPhase(wanted.current ? "run" : "settle");
      else if (phase === "settle") setPhase(wanted.current ? "start" : "rest");
    }}
    onAnimationIteration={(event) => {
      if (event.target === event.currentTarget && phase === "run" && !wanted.current) setPhase("settle");
    }}>
    <RefreshCw size={16} />
  </span>;
}
