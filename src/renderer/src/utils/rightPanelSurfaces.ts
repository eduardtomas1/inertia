import type { WorkspacePanelTab } from "../components/workspacePanelTypes";

export const RIGHT_PANEL_SURFACES = [
  "changes",
  "files",
  "preview",
  "terminal",
  "agents",
  "usage",
  "goal",
  "plan",
] as const satisfies readonly WorkspacePanelTab[];

export const RIGHT_PANEL_SURFACE_META: Record<
  WorkspacePanelTab,
  { label: string; shortcut: string }
> = {
  changes: { label: "Changes", shortcut: "D" },
  files: { label: "Files", shortcut: "F" },
  preview: { label: "Browser", shortcut: "B" },
  terminal: { label: "Terminal", shortcut: "T" },
  agents: { label: "Agents", shortcut: "A" },
  usage: { label: "Usage", shortcut: "U" },
  goal: { label: "Goal", shortcut: "G" },
  plan: { label: "Plan", shortcut: "P" },
};

export const WORKSPACE_BOUND_SURFACES = [
  "changes",
  "files",
  "terminal",
  "preview",
] as const satisfies readonly WorkspacePanelTab[];

export const RIGHT_PANEL_SIBLING_MIN_WIDTH = 360;

export interface RightPanelState {
  isOpen: boolean;
  activeSurfaceId: WorkspacePanelTab | null;
  surfaces: WorkspacePanelTab[];
}

export const EMPTY_RIGHT_PANEL_STATE: RightPanelState = {
  isOpen: false,
  activeSurfaceId: null,
  surfaces: [],
};

const surfaceSet = new Set<string>(RIGHT_PANEL_SURFACES);

export function isRightPanelSurface(value: unknown): value is WorkspacePanelTab {
  return typeof value === "string" && surfaceSet.has(value);
}

const workspaceBoundSet = new Set<string>(WORKSPACE_BOUND_SURFACES);

export function isWorkspaceBoundSurface(value: WorkspacePanelTab | null): boolean {
  return value !== null && workspaceBoundSet.has(value);
}

function upsertSurface(
  current: RightPanelState,
  surface: WorkspacePanelTab,
  activate = true,
): RightPanelState {
  return {
    isOpen: true,
    surfaces: current.surfaces.includes(surface)
      ? current.surfaces
      : [...current.surfaces, surface],
    activeSurfaceId: activate ? surface : current.activeSurfaceId,
  };
}

export function openRightPanelSurface(
  current: RightPanelState,
  surface: WorkspacePanelTab,
): RightPanelState {
  return upsertSurface(current, surface);
}

export function toggleRightPanelSurface(
  current: RightPanelState,
  surface: WorkspacePanelTab,
): RightPanelState {
  if (current.isOpen && current.activeSurfaceId === surface) {
    return { ...current, isOpen: false };
  }
  return upsertSurface(current, surface);
}

export function activateRightPanelSurface(
  current: RightPanelState,
  surface: WorkspacePanelTab,
): RightPanelState {
  return current.surfaces.includes(surface)
    ? { ...current, isOpen: true, activeSurfaceId: surface }
    : current;
}

export function closeRightPanelSurface(
  current: RightPanelState,
  surface: WorkspacePanelTab,
): RightPanelState {
  const index = current.surfaces.indexOf(surface);
  if (index < 0) return current;
  const surfaces = current.surfaces.filter((entry) => entry !== surface);
  if (current.activeSurfaceId !== surface) {
    return { ...current, isOpen: surfaces.length > 0 && current.isOpen, surfaces };
  }
  const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null;
  return {
    ...current,
    isOpen: surfaces.length > 0 && current.isOpen,
    surfaces,
    activeSurfaceId: fallback,
  };
}

export function closeOtherRightPanelSurfaces(
  current: RightPanelState,
  surface: WorkspacePanelTab,
): RightPanelState {
  if (!current.surfaces.includes(surface) || current.surfaces.length === 1) {
    return current;
  }
  return { isOpen: true, surfaces: [surface], activeSurfaceId: surface };
}

export function closeAllRightPanelSurfaces(
  current: RightPanelState,
): RightPanelState {
  return current.surfaces.length === 0
    ? current
    : { isOpen: false, surfaces: [], activeSurfaceId: null };
}

export function showRightPanel(current: RightPanelState): RightPanelState {
  return current.isOpen ? current : { ...current, isOpen: true };
}

export function hideRightPanel(current: RightPanelState): RightPanelState {
  return current.isOpen ? { ...current, isOpen: false } : current;
}

export function toggleRightPanelVisibility(
  current: RightPanelState,
): RightPanelState {
  return { ...current, isOpen: !current.isOpen };
}

export function selectedRightPanelSurface(
  state: RightPanelState,
): WorkspacePanelTab | null {
  return state.activeSurfaceId && state.surfaces.includes(state.activeSurfaceId)
    ? state.activeSurfaceId
    : null;
}

export function activeRightPanelSurface(
  state: RightPanelState,
): WorkspacePanelTab | null {
  return state.isOpen ? selectedRightPanelSurface(state) : null;
}

export function applyRightPanelTool(
  current: RightPanelState,
  tool: WorkspacePanelTab | null,
): RightPanelState {
  return tool ? openRightPanelSurface(current, tool) : hideRightPanel(current);
}

export function parseRightPanelState(raw: string | null): RightPanelState | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<Record<keyof RightPanelState, unknown>>;
  const surfaces = Array.isArray(candidate.surfaces)
    ? [...new Set(candidate.surfaces.filter(isRightPanelSurface))]
    : [];
  const persistedActive = isRightPanelSurface(candidate.activeSurfaceId)
    && surfaces.includes(candidate.activeSurfaceId)
    ? candidate.activeSurfaceId
    : null;
  const isOpen = typeof candidate.isOpen === "boolean"
    ? candidate.isOpen
    : persistedActive !== null;
  return {
    isOpen,
    surfaces,
    activeSurfaceId: persistedActive ?? (surfaces[0] ?? null),
  };
}

export function serializeRightPanelState(state: RightPanelState): string {
  return JSON.stringify({
    isOpen: state.isOpen,
    activeSurfaceId: state.activeSurfaceId,
    surfaces: state.surfaces,
  });
}

export function legacyRightPanelState(
  tool: string | null,
  open: boolean,
): RightPanelState {
  if (!isRightPanelSurface(tool)) {
    return { isOpen: open, surfaces: [], activeSurfaceId: null };
  }
  return { isOpen: open, surfaces: [tool], activeSurfaceId: tool };
}

export type RightPanelPresentation = "inline" | "sheet";

export function rightPanelPresentation(input: {
  containerWidth: number;
  panelMinWidth: number;
  handleWidth: number;
}): RightPanelPresentation {
  return input.containerWidth - input.panelMinWidth - input.handleWidth
    < RIGHT_PANEL_SIBLING_MIN_WIDTH
    ? "sheet"
    : "inline";
}

type SurfaceShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "defaultPrevented" | "isComposing" | "key" | "metaKey"
>;

export function surfaceShortcutActionForKey<
  const Action extends { available: boolean; shortcut: string },
>(actions: readonly Action[], event: SurfaceShortcutEvent): Action | null {
  if (event.defaultPrevented || event.isComposing) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  return actions.find(
    (action) => action.available
      && action.shortcut.toLowerCase() === event.key.toLowerCase(),
  ) ?? null;
}

export function surfaceShortcutTargetsTypingContext(
  target: { closest(selectors: string): unknown } | null,
): boolean {
  return target?.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
  ) != null;
}
