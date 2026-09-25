import { describe, expect, it } from "vitest";

import {
  activeRightPanelSurface,
  activateRightPanelSurface,
  applyRightPanelTool,
  closeAllRightPanelSurfaces,
  closeOtherRightPanelSurfaces,
  closeRightPanelSurface,
  EMPTY_RIGHT_PANEL_STATE,
  hideRightPanel,
  legacyRightPanelState,
  openRightPanelSurface,
  parseRightPanelState,
  RIGHT_PANEL_SIBLING_MIN_WIDTH,
  RIGHT_PANEL_SURFACE_META,
  RIGHT_PANEL_SURFACES,
  rightPanelPresentation,
  serializeRightPanelState,
  showRightPanel,
  surfaceShortcutActionForKey,
  surfaceShortcutTargetsTypingContext,
  toggleRightPanelSurface,
  toggleRightPanelVisibility,
  type RightPanelState,
} from "../../src/renderer/src/utils/rightPanelSurfaces";

const withSurfaces = (
  surfaces: RightPanelState["surfaces"],
  activeSurfaceId: RightPanelState["activeSurfaceId"],
  isOpen = true,
): RightPanelState => ({ isOpen, surfaces, activeSurfaceId });

describe("right panel surface host state", () => {
  it("opens a surface as a new active tab without duplicating it", () => {
    const first = openRightPanelSurface(EMPTY_RIGHT_PANEL_STATE, "changes");
    expect(first).toEqual(withSurfaces(["changes"], "changes"));
    const second = openRightPanelSurface(first, "usage");
    expect(second).toEqual(withSurfaces(["changes", "usage"], "usage"));
    expect(openRightPanelSurface(second, "changes")).toEqual(
      withSurfaces(["changes", "usage"], "changes"),
    );
  });

  it("toggles the active surface closed and reopens it", () => {
    const open = withSurfaces(["plan"], "plan");
    const hidden = toggleRightPanelSurface(open, "plan");
    expect(hidden).toEqual(withSurfaces(["plan"], "plan", false));
    expect(activeRightPanelSurface(hidden)).toBeNull();
    expect(toggleRightPanelSurface(hidden, "plan")).toEqual(open);
    expect(toggleRightPanelSurface(withSurfaces(["files"], "files"), "plan")).toEqual(
      withSurfaces(["files", "plan"], "plan"),
    );
  });

  it("closes the active tab onto its neighbour and hides an emptied panel", () => {
    const state = withSurfaces(["changes", "files", "usage"], "files");
    expect(closeRightPanelSurface(state, "files")).toEqual(
      withSurfaces(["changes", "usage"], "usage"),
    );
    expect(closeRightPanelSurface(state, "usage")).toEqual(
      withSurfaces(["changes", "files"], "files"),
    );
    expect(closeRightPanelSurface(withSurfaces(["agents"], "agents"), "agents")).toEqual(
      withSurfaces([], null, false),
    );
    expect(closeRightPanelSurface(state, "plan")).toBe(state);
  });

  it("keeps an empty open panel as the launcher", () => {
    const launcher = showRightPanel(EMPTY_RIGHT_PANEL_STATE);
    expect(launcher).toEqual(withSurfaces([], null, true));
    expect(activeRightPanelSurface(launcher)).toBeNull();
    expect(toggleRightPanelVisibility(launcher)).toEqual(EMPTY_RIGHT_PANEL_STATE);
  });

  it("activates only existing surfaces and supports close others and close all", () => {
    const state = withSurfaces(["changes", "files"], "changes", false);
    expect(activateRightPanelSurface(state, "files")).toEqual(
      withSurfaces(["changes", "files"], "files"),
    );
    expect(activateRightPanelSurface(state, "usage")).toBe(state);
    expect(closeOtherRightPanelSurfaces(withSurfaces(["changes", "files", "usage"], "changes"), "usage"))
      .toEqual(withSurfaces(["usage"], "usage"));
    expect(closeAllRightPanelSurfaces(state)).toEqual(EMPTY_RIGHT_PANEL_STATE);
  });

  it("maps the legacy active-tool API onto surfaces", () => {
    const opened = applyRightPanelTool(EMPTY_RIGHT_PANEL_STATE, "plan");
    expect(opened).toEqual(withSurfaces(["plan"], "plan"));
    expect(applyRightPanelTool(opened, null)).toEqual(hideRightPanel(opened));
  });
});

describe("right panel persistence", () => {
  it("round-trips and sanitizes persisted state", () => {
    const state = withSurfaces(["changes", "usage"], "usage");
    expect(parseRightPanelState(serializeRightPanelState(state))).toEqual(state);
    expect(parseRightPanelState(JSON.stringify({
      isOpen: true,
      activeSurfaceId: "environment",
      surfaces: ["environment", "terminal", "files", "files", 3],
    }))).toEqual(withSurfaces(["terminal", "files"], "terminal"));
    expect(parseRightPanelState("{broken")).toBeNull();
    expect(parseRightPanelState(null)).toBeNull();
  });

  it("migrates the single-tool layout, dropping Environment", () => {
    expect(legacyRightPanelState("files", true)).toEqual(withSurfaces(["files"], "files"));
    // Terminal is again a supported surface, including persisted legacy tabs.
    expect(legacyRightPanelState("terminal", true)).toEqual(withSurfaces(["terminal"], "terminal"));
    expect(legacyRightPanelState("environment", true)).toEqual(withSurfaces([], null, true));
    expect(legacyRightPanelState("files", false)).toEqual(withSurfaces(["files"], "files", false));
  });
});

describe("right panel presentation", () => {
  it("becomes a sheet only when the chat would drop below its minimum", () => {
    const panelMinWidth = 300;
    const handleWidth = 7;
    const threshold = RIGHT_PANEL_SIBLING_MIN_WIDTH + panelMinWidth + handleWidth;
    expect(RIGHT_PANEL_SIBLING_MIN_WIDTH).toBe(360);
    expect(rightPanelPresentation({ containerWidth: threshold, panelMinWidth, handleWidth }))
      .toBe("inline");
    expect(rightPanelPresentation({ containerWidth: threshold - 1, panelMinWidth, handleWidth }))
      .toBe("sheet");
  });
});

describe("right panel launcher shortcuts", () => {
  const actions = RIGHT_PANEL_SURFACES.map((surface) => ({
    surface,
    shortcut: RIGHT_PANEL_SURFACE_META[surface].shortcut,
    available: surface !== "preview",
  }));
  const key = (value: string, modifiers: Partial<KeyboardEvent> = {}) => ({
    key: value,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    defaultPrevented: false,
    isComposing: false,
    ...modifiers,
  });

  it("uses one unique letter per surface", () => {
    const letters = RIGHT_PANEL_SURFACES.map((surface) => RIGHT_PANEL_SURFACE_META[surface].shortcut);
    expect(new Set(letters).size).toBe(letters.length);
    expect(RIGHT_PANEL_SURFACE_META.changes.shortcut).toBe("D");
    expect(RIGHT_PANEL_SURFACE_META.usage.shortcut).toBe("U");
    expect(RIGHT_PANEL_SURFACE_META.agents.shortcut).toBe("A");
  });

  it("matches available surfaces case-insensitively and ignores chords", () => {
    expect(surfaceShortcutActionForKey(actions, key("u"))?.surface).toBe("usage");
    expect(surfaceShortcutActionForKey(actions, key("D"))?.surface).toBe("changes");
    expect(surfaceShortcutActionForKey(actions, key("b"))).toBeNull();
    expect(surfaceShortcutActionForKey(actions, key("u", { ctrlKey: true }))).toBeNull();
    expect(surfaceShortcutActionForKey(actions, key("u", { defaultPrevented: true }))).toBeNull();
    expect(surfaceShortcutActionForKey(actions, key("u", { isComposing: true }))).toBeNull();
  });

  it("never steals letters from typing contexts", () => {
    expect(surfaceShortcutTargetsTypingContext({ closest: () => ({}) })).toBe(true);
    expect(surfaceShortcutTargetsTypingContext({ closest: () => null })).toBe(false);
    expect(surfaceShortcutTargetsTypingContext(null)).toBe(false);
  });
});
