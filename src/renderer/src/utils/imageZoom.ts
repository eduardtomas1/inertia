// Zoom and pan arithmetic for the attachment image lightbox. Kept pure so the
// transform stays predictable across wheel, pointer, button, and key input.

export interface ImageZoomState {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export interface ImageZoomBounds {
  /** Layout size of the stage the image is centred in. */
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  /** Painted size of the image once `object-fit: contain` has been applied. */
  readonly contentWidth: number;
  readonly contentHeight: number;
}

/** Offsets are measured from the centre of the stage, in stage pixels. */
export interface ImageZoomPoint {
  readonly x: number;
  readonly y: number;
}

export const IMAGE_ZOOM_MIN_SCALE = 1;
export const IMAGE_ZOOM_MAX_SCALE = 8;
export const IMAGE_ZOOM_BUTTON_STEP = 1.5;
export const IMAGE_ZOOM_TOGGLE_SCALE = 2.5;
export const IMAGE_ZOOM_KEYBOARD_PAN = 48;
export const IDENTITY_IMAGE_ZOOM: ImageZoomState = {
  scale: IMAGE_ZOOM_MIN_SCALE,
  offsetX: 0,
  offsetY: 0,
};

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

export function clampImageScale(scale: number): number {
  return Math.min(
    IMAGE_ZOOM_MAX_SCALE,
    Math.max(IMAGE_ZOOM_MIN_SCALE, finite(scale, IMAGE_ZOOM_MIN_SCALE)),
  );
}

/** Travel available on one axis before the scaled image uncovers the stage. */
function panLimit(content: number, viewport: number, scale: number): number {
  return Math.max(
    0,
    (finite(content) * scale - finite(viewport)) / 2,
  );
}

export function clampImageZoom(
  state: ImageZoomState,
  bounds: ImageZoomBounds,
): ImageZoomState {
  const scale = clampImageScale(state.scale);
  const limitX = panLimit(bounds.contentWidth, bounds.viewportWidth, scale);
  const limitY = panLimit(bounds.contentHeight, bounds.viewportHeight, scale);
  return {
    scale,
    offsetX: Math.min(limitX, Math.max(-limitX, finite(state.offsetX))),
    offsetY: Math.min(limitY, Math.max(-limitY, finite(state.offsetY))),
  };
}

/**
 * Rescale while holding the image point under `focus` still, so wheel and
 * double-click zoom track the pointer instead of the centre of the stage.
 */
export function zoomImageAtPoint(
  state: ImageZoomState,
  bounds: ImageZoomBounds,
  nextScale: number,
  focus: ImageZoomPoint,
): ImageZoomState {
  const current = clampImageScale(state.scale);
  const target = clampImageScale(nextScale);
  const ratio = target / current;
  const focusX = finite(focus.x);
  const focusY = finite(focus.y);
  return clampImageZoom({
    scale: target,
    offsetX: focusX - (focusX - finite(state.offsetX)) * ratio,
    offsetY: focusY - (focusY - finite(state.offsetY)) * ratio,
  }, bounds);
}

export function panImageZoom(
  state: ImageZoomState,
  bounds: ImageZoomBounds,
  delta: ImageZoomPoint,
): ImageZoomState {
  return clampImageZoom({
    scale: state.scale,
    offsetX: finite(state.offsetX) + finite(delta.x),
    offsetY: finite(state.offsetY) + finite(delta.y),
  }, bounds);
}

/** Wheel notches zoom geometrically so trackpads and mice feel the same. */
export function wheelZoomScale(scale: number, deltaY: number): number {
  return clampImageScale(clampImageScale(scale)
    * Math.exp(-finite(deltaY) / 320));
}

export function steppedZoomScale(scale: number, direction: 1 | -1): number {
  return clampImageScale(clampImageScale(scale)
    * IMAGE_ZOOM_BUTTON_STEP ** direction);
}

/** `object-fit: contain` geometry for the loaded bitmap inside the stage. */
export function containedImageBounds(
  viewportWidth: number,
  viewportHeight: number,
  naturalWidth: number,
  naturalHeight: number,
): ImageZoomBounds {
  const width = Math.max(0, finite(viewportWidth));
  const height = Math.max(0, finite(viewportHeight));
  const natural = {
    width: Math.max(0, finite(naturalWidth)),
    height: Math.max(0, finite(naturalHeight)),
  };
  if (natural.width === 0 || natural.height === 0) {
    return {
      viewportWidth: width,
      viewportHeight: height,
      contentWidth: width,
      contentHeight: height,
    };
  }
  const fit = Math.min(width / natural.width, height / natural.height);
  return {
    viewportWidth: width,
    viewportHeight: height,
    contentWidth: natural.width * fit,
    contentHeight: natural.height * fit,
  };
}

export function imageZoomPercentLabel(scale: number): string {
  return `${Math.round(clampImageScale(scale) * 100)}%`;
}
