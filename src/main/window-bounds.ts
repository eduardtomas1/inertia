import type { Rectangle } from "electron";

export interface WindowBoundsDisplay {
  workArea: Rectangle;
}

export interface RestoredWindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface WindowBoundsLimits {
  minimum: Readonly<Pick<Rectangle, "width" | "height">>;
  maximum: Readonly<Pick<Rectangle, "width" | "height">>;
}

const MIN_REACHABLE_TITLE_WIDTH = 80;
const MIN_REACHABLE_TITLE_HEIGHT = 32;
const TITLE_BAR_HEIGHT = 48;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

function overlap(
  firstStart: number,
  firstLength: number,
  secondStart: number,
  secondLength: number,
): number {
  return Math.max(0, Math.min(
    firstStart + firstLength,
    secondStart + secondLength,
  ) - Math.max(firstStart, secondStart));
}

/**
 * Electron window coordinates and display work areas are both expressed in
 * device-independent pixels. Requiring a usable part of the title bar keeps a
 * restored window movable after monitor removal or display-scale changes and
 * rejects accidental one-pixel intersections with an old display.
 */
export function restoreReachableWindowBounds(
  saved: Rectangle,
  displays: readonly WindowBoundsDisplay[],
  limits: WindowBoundsLimits,
): RestoredWindowBounds {
  const normalized: Rectangle = {
    x: saved.x,
    y: saved.y,
    width: clamp(saved.width, limits.minimum.width, limits.maximum.width),
    height: clamp(saved.height, limits.minimum.height, limits.maximum.height),
  };
  const reachable = displays.some(({ workArea }) => {
    if (workArea.width <= 0 || workArea.height <= 0) return false;
    const visibleTitleWidth = overlap(
      normalized.x,
      normalized.width,
      workArea.x,
      workArea.width,
    );
    const visibleTitleHeight = overlap(
      normalized.y,
      Math.min(TITLE_BAR_HEIGHT, normalized.height),
      workArea.y,
      workArea.height,
    );
    return visibleTitleWidth >= Math.min(
      MIN_REACHABLE_TITLE_WIDTH,
      normalized.width,
      workArea.width,
    ) && visibleTitleHeight >= Math.min(
      MIN_REACHABLE_TITLE_HEIGHT,
      TITLE_BAR_HEIGHT,
      normalized.height,
      workArea.height,
    );
  });
  return reachable
    ? normalized
    : { width: normalized.width, height: normalized.height };
}
