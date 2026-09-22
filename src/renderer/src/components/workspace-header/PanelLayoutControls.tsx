import {
  lazy,
  memo,
  Suspense,
  useLayoutEffect,
  useRef,
} from "react";
import { PanelBottom, PanelRight } from "lucide-react";

import type { EnvironmentUsageSummary } from "../../utils/environmentSummary";

const HeaderUsageMeter = lazy(async () => ({
  default: (await import("./HeaderUsageMeter")).HeaderUsageMeter,
}));

interface PanelLayoutControlsProps {
  usage: EnvironmentUsageSummary | null;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalShortcutLabel: string | null;
  terminalUnavailableLabel?: string;
  rightPanelAvailable: boolean;
  rightPanelOpen: boolean;
  rightPanelUnavailableLabel?: string;
  liveAgentCount: number;
  onToggleTerminal: () => void;
  onToggleRightPanel: () => void;
  onOpenUsage: () => void;
  onWidthChange?: (width: number) => void;
}

export const PanelLayoutControls = memo(function PanelLayoutControls({
  usage,
  terminalAvailable,
  terminalOpen,
  terminalShortcutLabel,
  terminalUnavailableLabel = "Terminal is unavailable",
  rightPanelAvailable,
  rightPanelOpen,
  rightPanelUnavailableLabel = "Right panel is unavailable",
  liveAgentCount,
  onToggleTerminal,
  onToggleRightPanel,
  onOpenUsage,
  onWidthChange,
}: PanelLayoutControlsProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const onWidthChangeRef = useRef(onWidthChange);
  onWidthChangeRef.current = onWidthChange;
  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const report = (): void => onWidthChangeRef.current?.(Math.ceil(node.getBoundingClientRect().width));
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const agentsLabel = liveAgentCount > 0
    ? `${liveAgentCount} ${liveAgentCount === 1 ? "agent" : "agents"} working`
    : null;
  const terminalLabel = terminalAvailable
    ? `Toggle terminal${terminalShortcutLabel ? ` (${terminalShortcutLabel})` : ""}`
    : terminalUnavailableLabel;
  const rightPanelLabel = rightPanelAvailable
    ? `Toggle right panel${agentsLabel ? `, ${agentsLabel}` : ""}`
    : rightPanelUnavailableLabel;
  return (
    <div
      ref={rootRef}
      className="workspace-corner-controls no-drag"
      data-panel-layout-controls
    >
      {usage && (
        <Suspense fallback={null}>
          <HeaderUsageMeter usage={usage} onOpenUsage={onOpenUsage} />
        </Suspense>
      )}
      <button
        type="button"
        className="corner-toggle"
        aria-label={terminalAvailable ? "Toggle terminal" : terminalLabel}
        title={terminalLabel}
        aria-pressed={terminalOpen}
        disabled={!terminalAvailable}
        onClick={onToggleTerminal}
      >
        <PanelBottom size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="corner-toggle"
        aria-label={rightPanelLabel}
        title={rightPanelLabel}
        aria-pressed={rightPanelOpen}
        disabled={!rightPanelAvailable}
        data-right-panel-toggle
        onClick={onToggleRightPanel}
      >
        <PanelRight size={15} aria-hidden="true" />
        {liveAgentCount > 0 && (
          <span className="corner-toggle-badge" aria-hidden="true">{liveAgentCount}</span>
        )}
      </button>
    </div>
  );
});
