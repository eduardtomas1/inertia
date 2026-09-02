export interface PopoverRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PopoverSize {
  width: number;
  height: number;
}

export type PopoverVerticalPlacement = "above" | "below";
export type PopoverHorizontalPlacement = "start" | "end" | "clamped";

export interface ComposerPopoverPlacement {
  top: number;
  left: number;
  maxWidth: number;
  maxHeight: number;
  vertical: PopoverVerticalPlacement;
  horizontal: PopoverHorizontalPlacement;
}

const DEFAULT_GAP = 8;
const DEFAULT_PADDING = 8;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

export function intersectPopoverRects(
  first: PopoverRect,
  second: PopoverRect,
): PopoverRect {
  const left = Math.max(first.left, second.left);
  const top = Math.max(first.top, second.top);
  return {
    top,
    right: Math.max(left, Math.min(first.right, second.right)),
    bottom: Math.max(top, Math.min(first.bottom, second.bottom)),
    left,
  };
}

function insetPopoverRect(bounds: PopoverRect, padding: number): PopoverRect {
  const left = bounds.left + padding;
  const top = bounds.top + padding;
  return {
    top,
    right: Math.max(left, bounds.right - padding),
    bottom: Math.max(top, bounds.bottom - padding),
    left,
  };
}

export function calculateComposerPopoverPlacement({
  trigger,
  boundary,
  popover,
  preferredVertical = "above",
  gap = DEFAULT_GAP,
  padding = DEFAULT_PADDING,
}: {
  trigger: PopoverRect;
  boundary: PopoverRect;
  popover: PopoverSize;
  preferredVertical?: PopoverVerticalPlacement;
  gap?: number;
  padding?: number;
}): ComposerPopoverPlacement {
  const safe = insetPopoverRect(boundary, padding);
  const maxWidth = Math.max(1, safe.right - safe.left);
  const width = Math.min(Math.max(1, popover.width), maxWidth);
  const startLeft = trigger.left;
  const endLeft = trigger.right - width;
  const startFits = startLeft >= safe.left && startLeft + width <= safe.right;
  const endFits = endLeft >= safe.left && endLeft + width <= safe.right;
  const preferEnd = (trigger.left + trigger.right) / 2
    > (safe.left + safe.right) / 2;

  let horizontal: PopoverHorizontalPlacement;
  let left: number;
  if (preferEnd && endFits) {
    horizontal = "end";
    left = endLeft;
  } else if (!preferEnd && startFits) {
    horizontal = "start";
    left = startLeft;
  } else if (startFits) {
    horizontal = "start";
    left = startLeft;
  } else if (endFits) {
    horizontal = "end";
    left = endLeft;
  } else {
    horizontal = "clamped";
    left = clamp(preferEnd ? endLeft : startLeft, safe.left, safe.right - width);
  }

  const above = Math.max(0, trigger.top - gap - safe.top);
  const below = Math.max(0, safe.bottom - trigger.bottom - gap);
  const preferredSpace = preferredVertical === "above" ? above : below;
  const alternateSpace = preferredVertical === "above" ? below : above;
  const naturalHeight = Math.max(1, popover.height);
  let vertical: PopoverVerticalPlacement;
  if (naturalHeight <= preferredSpace) {
    vertical = preferredVertical;
  } else if (naturalHeight <= alternateSpace) {
    vertical = preferredVertical === "above" ? "below" : "above";
  } else if (alternateSpace > preferredSpace) {
    vertical = preferredVertical === "above" ? "below" : "above";
  } else {
    vertical = preferredVertical;
  }

  const maxHeight = Math.max(1, vertical === "above" ? above : below);
  const height = Math.min(naturalHeight, maxHeight);
  const top = vertical === "above"
    ? trigger.top - gap - height
    : trigger.bottom + gap;

  return {
    top: clamp(top, safe.top, safe.bottom - height),
    left,
    maxWidth,
    maxHeight,
    vertical,
    horizontal,
  };
}

function viewportRect(): PopoverRect {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  return {
    top,
    right: left + (viewport?.width ?? window.innerWidth),
    bottom: top + (viewport?.height ?? window.innerHeight),
    left,
  };
}

export function composerPopoverBoundary(element: Element): PopoverRect {
  const workspace = element.closest<HTMLElement>(".chat-workspace");
  const pane = element.closest<HTMLElement>(".conversation-split-pane");
  let bounds: PopoverRect = workspace?.getBoundingClientRect()
    ?? pane?.getBoundingClientRect()
    ?? viewportRect();
  if (pane) {
    bounds = intersectPopoverRects(bounds, pane.getBoundingClientRect());
  }
  return intersectPopoverRects(bounds, viewportRect());
}

function popoverSurface(popover: HTMLElement): HTMLElement {
  if (!popover.classList.contains("composer-more-layer")) return popover;
  return popover.querySelector<HTMLElement>(":scope > .composer-popover")
    ?? popover;
}

export function positionComposerPopover(
  trigger: HTMLElement,
  popover: HTMLElement,
): ComposerPopoverPlacement {
  const surface = popoverSurface(popover);
  popover.style.translate = "none";
  surface.style.removeProperty("max-width");
  surface.style.removeProperty("min-width");
  surface.style.removeProperty("max-height");
  surface.style.removeProperty("overflow-y");

  const boundary = composerPopoverBoundary(trigger);
  const initialBounds = surface.getBoundingClientRect();
  const horizontal = calculateComposerPopoverPlacement({
    trigger: trigger.getBoundingClientRect(),
    boundary,
    popover: initialBounds,
  });
  const constrainedWidth = Math.min(initialBounds.width, horizontal.maxWidth);
  surface.style.maxWidth = `${horizontal.maxWidth}px`;
  surface.style.minWidth = `${constrainedWidth}px`;

  const widthConstrainedBounds = surface.getBoundingClientRect();
  const borderHeight = widthConstrainedBounds.height - surface.clientHeight;
  const naturalHeight = Math.max(
    widthConstrainedBounds.height,
    surface.scrollHeight + Math.max(0, borderHeight),
  );
  const placement = calculateComposerPopoverPlacement({
    trigger: trigger.getBoundingClientRect(),
    boundary,
    popover: {
      width: widthConstrainedBounds.width,
      height: naturalHeight,
    },
  });
  surface.style.maxHeight = `${placement.maxHeight}px`;
  surface.style.overflowY = "auto";
  popover.style.setProperty(
    "--composer-popover-available-height",
    `${placement.maxHeight}px`,
  );

  const positionedBounds = surface.getBoundingClientRect();
  popover.style.translate = `${placement.left - positionedBounds.left}px ${
    placement.top - positionedBounds.top
  }px`;
  popover.dataset.composerPopoverPositioned = "true";
  popover.dataset.popoverVertical = placement.vertical;
  popover.dataset.popoverHorizontal = placement.horizontal;
  return placement;
}

export function chooseComposerSubmenuSide(
  popover: HTMLElement,
  requiredSpace: number,
): "left" | "right" | null {
  return calculateComposerSubmenuSide({
    popover: popover.getBoundingClientRect(),
    boundary: composerPopoverBoundary(popover),
    requiredSpace,
  });
}

export function calculateComposerSubmenuSide({
  popover,
  boundary,
  requiredSpace,
  padding = DEFAULT_PADDING,
}: {
  popover: Pick<PopoverRect, "left" | "right">;
  boundary: Pick<PopoverRect, "left" | "right">;
  requiredSpace: number;
  padding?: number;
}): "left" | "right" | null {
  if (boundary.right - padding - popover.right >= requiredSpace) return "right";
  if (popover.left - boundary.left - padding >= requiredSpace) return "left";
  return null;
}

export function observeComposerPopover(
  trigger: HTMLElement,
  popover: HTMLElement,
  onPlacement: (submenuSide: "left" | "right" | null) => void,
): () => void {
  let frame: number | null = null;
  const update = (): void => {
    frame = null;
    positionComposerPopover(trigger, popover);
    const submenuSide = chooseComposerSubmenuSide(
      popoverSurface(popover),
      288,
    );
    popover.dataset.composerSubmenuSide = submenuSide ?? "";
    onPlacement(submenuSide);
  };
  const schedule = (): void => {
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(update);
  };
  update();
  const observer = typeof ResizeObserver === "undefined"
    ? null
    : new ResizeObserver(schedule);
  for (const element of [
    trigger,
    popoverSurface(popover),
    trigger.closest<HTMLElement>(".composer"),
    trigger.closest<HTMLElement>(".chat-workspace"),
    trigger.closest<HTMLElement>(".conversation-split-pane"),
  ]) {
    if (element) observer?.observe(element);
  }
  window.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("scroll", schedule);
  return () => {
    if (frame !== null) window.cancelAnimationFrame(frame);
    observer?.disconnect();
    window.removeEventListener("resize", schedule);
    window.visualViewport?.removeEventListener("resize", schedule);
    window.visualViewport?.removeEventListener("scroll", schedule);
  };
}
