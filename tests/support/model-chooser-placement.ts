export interface ModelChooserPlacementGeometry {
  frame: { top: number; bottom: number; height: number };
  anchor: { top: number; bottom: number };
  workspace: { top: number; bottom: number };
  viewportHeight: number;
  vertical: string | null;
}

// Fractional Electron zoom can give mathematically equal DOMRect edges
// differences of ~0.000015 CSS px. This is numerical precision, not gap slack.
const FIT_ROUNDING_TOLERANCE = 0.001;

export function modelChooserPlacementChecks({
  frame, anchor, workspace, viewportHeight, vertical,
}: ModelChooserPlacementGeometry): {
  correctSide: boolean;
  anchored: boolean;
  insideWorkspace: boolean;
} {
  const availableBelow = Math.min(viewportHeight, workspace.bottom) - anchor.bottom - 16;
  const fitDifference = availableBelow - frame.height;
  return {
    correctSide: vertical === "below"
      ? fitDifference >= -FIT_ROUNDING_TOLERANCE
      : vertical === "above" && fitDifference <= FIT_ROUNDING_TOLERANCE,
    anchored: vertical === "below"
      ? frame.top >= anchor.bottom + 7.5
      : vertical === "above" && frame.bottom <= anchor.top - 7.5,
    insideWorkspace: frame.top >= Math.max(0, workspace.top) + 7.5
      && frame.bottom <= Math.min(viewportHeight, workspace.bottom) - 7.5,
  };
}
