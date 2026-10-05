export interface AgentBrowserSnapshotOmission {
  textChars: number;
  elements: number;
}

const SNAPSHOT_REACH_STEP = "Scroll with inertia_browser_scroll, by ref or by pixels, and take a new snapshot to read more, or use inertia_browser_wait_for with text to look for specific content.";

export function agentBrowserSnapshotNextStep(readLimitReached: boolean): string {
  return readLimitReached
    ? `This page is larger than one snapshot reads, so more text and controls exist than are listed. ${SNAPSHOT_REACH_STEP}`
    : `Part of this page was left out of the snapshot. ${SNAPSHOT_REACH_STEP}`;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function viewportDistance(element: unknown, width: number, height: number): number {
  const candidate = record(element);
  if (candidate?.offscreen !== true) return 0;
  const rect = record(candidate.rect);
  const x = finite(rect?.x);
  const y = finite(rect?.y);
  return 1 + Math.max(0, y - height, -(y + finite(rect?.height)), x - width, -(x + finite(rect?.width)));
}

export function nearestAgentBrowserElements<Element>(
  elements: readonly Element[],
  count: number,
  viewport: unknown,
): Element[] {
  if (count >= elements.length) return [...elements];
  const bounds = record(viewport);
  const width = finite(bounds?.width);
  const height = finite(bounds?.height);
  const kept = new Set(elements
    .map((element, index) => ({ index, distance: viewportDistance(element, width, height) }))
    .sort((left, right) => left.distance - right.distance || left.index - right.index)
    .slice(0, Math.max(0, count))
    .map(({ index }) => index));
  return elements.filter((_element, index) => kept.has(index));
}
