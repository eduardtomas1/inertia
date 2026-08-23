import type { Rectangle } from "electron";

import {
  restoreReachableWindowBounds,
  type WindowBoundsDisplay,
} from "./window-bounds.js";

export interface MainWindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export const MAIN_WINDOW_DEFAULT_STATE = Object.freeze({
  width: 1_440,
  height: 920,
  maximized: false,
});

const MAIN_WINDOW_LIMITS = Object.freeze({
  minimum: { width: 760, height: 600 },
  maximum: { width: 5_000, height: 3_000 },
});

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

export function restoreMainWindowState(
  value: unknown,
  displays: readonly WindowBoundsDisplay[],
): MainWindowState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...MAIN_WINDOW_DEFAULT_STATE };
  }
  const candidate = value as Partial<MainWindowState>;
  if (!integer(candidate.width) || !integer(candidate.height)) {
    return { ...MAIN_WINDOW_DEFAULT_STATE };
  }
  const saved: Rectangle = {
    x: integer(candidate.x) ? candidate.x : 0,
    y: integer(candidate.y) ? candidate.y : 0,
    width: candidate.width,
    height: candidate.height,
  };
  const restored = restoreReachableWindowBounds(saved, displays, MAIN_WINDOW_LIMITS);
  const hasSavedPosition = integer(candidate.x) && integer(candidate.y);
  return {
    ...(hasSavedPosition && restored.x !== undefined && restored.y !== undefined
      ? { x: restored.x, y: restored.y }
      : {}),
    width: restored.width,
    height: restored.height,
    maximized: candidate.maximized === true,
  };
}
