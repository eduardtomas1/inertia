import type { Page } from "@playwright/test";

import { WINDOW_HEADER_HEIGHT } from "../../../src/shared/window-chrome";

export type AppRegion = "drag" | "no-drag" | "none";

export interface DragSpan {
  left: number;
  right: number;
}

export interface DragPoint {
  x: number;
  y: number;
}

export interface DragPointReading extends DragPoint {
  region: AppRegion;
  topElement: string;
  overControl: boolean;
}

export interface DragControlReading {
  label: string;
  left: number;
  right: number;
  draggableArea: number;
  hitRegion: AppRegion;
}

export interface WindowDragBand {
  left: number;
  right: number;
  height: number;
  freeArea: number;
  draggableArea: number;
  draggableShare: number;
  rowFreeWidth: number;
  rowDraggableWidth: number;
  rowDraggableShare: number;
  rowSpans: DragSpan[];
  longestRowSpan: number;
  controls: DragControlReading[];
  blockers: string[];
  points: DragPointReading[];
}

const CONTROL_SELECTOR = [
  "button",
  "input",
  "textarea",
  "select",
  "summary",
  "a[href]",
  "[role='button']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='switch']",
  "[role='checkbox']",
  "[role='separator'][tabindex]",
  "[tabindex]:not([tabindex='-1'])",
  "[contenteditable='']",
  "[contenteditable='true']",
  "[draggable='true']",
  ".header-title-wrap h1",
  ".header-trailing.no-drag",
  ".workspace-corner-controls.no-drag",
].join(", ");

export async function measureWindowDragBand(
  page: Page,
  options: { points?: readonly DragPoint[]; row?: number; height?: number } = {},
): Promise<WindowDragBand> {
  return await page.evaluate(({ controlSelector, height, row, points }) => {
    const overlay = (navigator as Navigator & {
      windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): DOMRect };
    }).windowControlsOverlay;
    const titlebar = overlay?.visible ? overlay.getTitlebarAreaRect() : null;
    const left = titlebar && titlebar.width > 0 ? Math.round(titlebar.left) : 0;
    const right = titlebar && titlebar.width > 0 ? Math.round(titlebar.right) : window.innerWidth;
    const width = Math.max(0, right - left);
    const regionOf = (element: Element): "drag" | "no-drag" | "none" => {
      const style = getComputedStyle(element);
      const value = style.getPropertyValue("-webkit-app-region") || style.getPropertyValue("app-region");
      return value === "drag" || value === "no-drag" ? value : "none";
    };
    const describe = (element: Element): string => {
      const name = element.getAttribute("aria-label") ?? "";
      const classes = typeof element.className === "string" && element.className
        ? `.${element.className.trim().split(/\s+/u).join(".")}`
        : "";
      return `${element.tagName.toLowerCase()}${classes}${name ? `[${name}]` : ""}`;
    };
    const DRAG = 1;
    const NO_DRAG = 2;
    const BLOCK = 4;
    const cells = new Uint8Array(width * height);
    const owners = new Int32Array(width * height).fill(-1);
    const sources: Element[] = [];
    for (const element of document.querySelectorAll("*")) {
      const boxes = [];
      for (const rect of element.getClientRects()) {
        const x0 = Math.max(0, Math.round(rect.left) - left);
        const x1 = Math.min(width, Math.round(rect.right) - left);
        const y0 = Math.max(0, Math.round(rect.top));
        const y1 = Math.min(height, Math.round(rect.bottom));
        if (x1 > x0 && y1 > y0) boxes.push({ x0, x1, y0, y1 });
      }
      if (boxes.length === 0) continue;
      if (getComputedStyle(element).visibility !== "visible") continue;
      const region = regionOf(element);
      if (region === "none") continue;
      const owner = sources.push(element) - 1;
      for (const box of boxes) {
        for (let y = box.y0; y < box.y1; y += 1) {
          cells.fill(region === "drag" ? DRAG : NO_DRAG, y * width + box.x0, y * width + box.x1);
          owners.fill(owner, y * width + box.x0, y * width + box.x1);
        }
      }
    }
    const controlCells = new Uint8Array(width * height);
    const controls = new Map<Element, { label: string; left: number; right: number; draggableArea: number; hitRegion: "drag" | "no-drag" | "none" }>();
    const controlBoxes = new Map<Element, { x0: number; x1: number; y0: number; y1: number }[]>();
    for (let blockY = 0; blockY < height; blockY += BLOCK) {
      for (let blockX = 0; blockX < width; blockX += BLOCK) {
        const hit = document.elementFromPoint(left + blockX + BLOCK / 2, blockY + BLOCK / 2);
        const control = hit?.closest(controlSelector);
        if (!hit || !control) continue;
        const reading = controls.get(control) ?? { label: describe(control), left: left + blockX, right: left + blockX, draggableArea: 0, hitRegion: "no-drag" as const };
        controls.set(control, reading);
        reading.left = Math.min(reading.left, left + blockX);
        reading.right = Math.max(reading.right, Math.min(right, left + blockX + BLOCK));
        const hitRegion = regionOf(hit);
        if (hitRegion !== "no-drag") reading.hitRegion = hitRegion;
        const boxes = controlBoxes.get(control) ?? [...control.getClientRects()].map((rect) => ({
          x0: Math.ceil(rect.left) - left,
          x1: Math.floor(rect.right) - left,
          y0: Math.ceil(rect.top),
          y1: Math.floor(rect.bottom),
        }));
        controlBoxes.set(control, boxes);
        for (let y = blockY; y < Math.min(height, blockY + BLOCK); y += 1) {
          for (let x = blockX; x < Math.min(width, blockX + BLOCK); x += 1) {
            controlCells[y * width + x] = 1;
            if (
              cells[y * width + x] === DRAG
              && boxes.some((box) => x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1)
            ) reading.draggableArea += 1;
          }
        }
      }
    }
    let freeArea = 0;
    let draggableArea = 0;
    const blockers = new Map<string, number>();
    for (let index = 0; index < cells.length; index += 1) {
      if (controlCells[index]) continue;
      freeArea += 1;
      if (cells[index] === DRAG) draggableArea += 1;
      else if (cells[index] === NO_DRAG) {
        const label = describe(sources[owners[index]!]!);
        blockers.set(label, (blockers.get(label) ?? 0) + 1);
      }
    }
    const rowSpans: { left: number; right: number }[] = [];
    let rowFreeWidth = 0;
    let rowDraggableWidth = 0;
    let spanStart = -1;
    for (let x = 0; x <= width; x += 1) {
      const index = row * width + x;
      const draggable = x < width && cells[index] === DRAG;
      if (x < width && !controlCells[index]) {
        rowFreeWidth += 1;
        if (draggable) rowDraggableWidth += 1;
      }
      if (draggable && spanStart < 0) spanStart = x;
      if (!draggable && spanStart >= 0) {
        rowSpans.push({ left: left + spanStart, right: left + x });
        spanStart = -1;
      }
    }
    return {
      left,
      right,
      height,
      freeArea,
      draggableArea,
      draggableShare: freeArea > 0 ? draggableArea / freeArea : 0,
      rowFreeWidth,
      rowDraggableWidth,
      rowDraggableShare: rowFreeWidth > 0 ? rowDraggableWidth / rowFreeWidth : 0,
      rowSpans,
      longestRowSpan: rowSpans.reduce((longest, span) => Math.max(longest, span.right - span.left), 0),
      controls: [...controls.values()],
      blockers: [...blockers].sort((first, second) => second[1] - first[1]).map(([label, area]) => `${label} (${area}px²)`),
      points: points.map((point) => {
        const cellX = Math.round(point.x) - left;
        const cellY = Math.round(point.y);
        const inBand = cellX >= 0 && cellX < width && cellY >= 0 && cellY < height;
        const cell = inBand ? cells[cellY * width + cellX] : 0;
        const top = document.elementFromPoint(point.x, point.y);
        return {
          x: point.x,
          y: point.y,
          region: cell === DRAG ? "drag" as const : cell === NO_DRAG ? "no-drag" as const : "none" as const,
          topElement: top ? describe(top) : "",
          overControl: !inBand || Boolean(top?.closest(controlSelector)),
        };
      }),
    };
  }, {
    controlSelector: CONTROL_SELECTOR,
    height: options.height ?? WINDOW_HEADER_HEIGHT,
    row: options.row ?? Math.floor((options.height ?? WINDOW_HEADER_HEIGHT) / 2),
    points: [...(options.points ?? [])],
  });
}
