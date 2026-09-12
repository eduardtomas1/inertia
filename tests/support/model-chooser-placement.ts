export interface ModelChooserPlacementGeometry {
  frame: { top: number; bottom: number; height: number };
  anchor: { top: number; bottom: number };
  workspace: { top: number; bottom: number };
  // The visual viewport that production placement measures against
  // (composerPopoverPlacement viewportRect), not the layout viewport.
  viewportTop?: number;
  viewportHeight: number;
  vertical: string | null;
}

/** Read related bounds in one renderer turn: a snapshot can move the entire
 * composer between two separate Playwright boundingBox requests. */
export function modelChooserContentGeometry(element: Element): {
  frameHeight: number;
  bottomGap: number;
} {
  const list = element.querySelector('[aria-label="Model results"]');
  if (!list) throw new Error("The model chooser results list is missing.");
  const frame = element.getBoundingClientRect();
  const results = list.getBoundingClientRect();
  return {
    frameHeight: frame.height,
    bottomGap: Math.abs(frame.bottom - results.bottom),
  };
}

// Fractional Electron zoom can give mathematically equal DOMRect edges
// differences of ~0.000015 CSS px. This is numerical precision, not gap slack.
const FIT_ROUNDING_TOLERANCE = 0.001;

export function modelChooserPlacementChecks({
  frame, anchor, workspace, viewportTop = 0, viewportHeight, vertical,
}: ModelChooserPlacementGeometry): {
  correctSide: boolean;
  anchored: boolean;
  insideWorkspace: boolean;
} {
  const viewportBottom = viewportTop + viewportHeight;
  const availableBelow = Math.min(viewportBottom, workspace.bottom) - anchor.bottom - 16;
  const fitDifference = availableBelow - frame.height;
  return {
    correctSide: vertical === "below"
      ? fitDifference >= -FIT_ROUNDING_TOLERANCE
      : vertical === "above" && fitDifference <= FIT_ROUNDING_TOLERANCE,
    anchored: vertical === "below"
      ? frame.top >= anchor.bottom + 7.5
      : vertical === "above" && frame.bottom <= anchor.top - 7.5,
    insideWorkspace: frame.top >= Math.max(viewportTop, workspace.top) + 7.5
      && frame.bottom <= Math.min(viewportBottom, workspace.bottom) - 7.5,
  };
}
