import {
  lazy,
  memo,
  Suspense,
  useLayoutEffect,
  useRef,
} from "react";
import { PanelBottom, PanelRight } from "lucide-react";

import type { EnvironmentUsageSummary } from "../../utils/environmentSummary";
import { activeBackgroundTasksLabel } from "../../utils/backgroundTaskRuns";

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
  activeBackgroundTaskCount: number;
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
  activeBackgroundTaskCount,
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
  const tasksLabel = activeBackgroundTaskCount > 0
    ? activeBackgroundTasksLabel(activeBackgroundTaskCount)
    : null;
  const terminalLabel = terminalAvailable
    ? `Toggle terminal${terminalShortcutLabel ? ` (${terminalShortcutLabel})` : ""}`
    : terminalUnavailableLabel;
  const rightPanelLabel = rightPanelAvailable
    ? `Toggle right panel${tasksLabel ? `, ${tasksLabel}` : ""}`
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
        <PanelBottom size={16} aria-hidden="true" />
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
        <PanelRight size={16} aria-hidden="true" />
        {activeBackgroundTaskCount > 0 && (
          <span className="corner-toggle-badge" aria-hidden="true">{activeBackgroundTaskCount}</span>
        )}
      </button>
    </div>
  );
});
