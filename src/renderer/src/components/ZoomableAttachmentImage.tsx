import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  IDENTITY_IMAGE_ZOOM,
  IMAGE_ZOOM_KEYBOARD_PAN,
  IMAGE_ZOOM_MAX_SCALE,
  IMAGE_ZOOM_MIN_SCALE,
  IMAGE_ZOOM_TOGGLE_SCALE,
  clampImageZoom,
  containedImageBounds,
  imageZoomPercentLabel,
  panImageZoom,
  steppedZoomScale,
  wheelZoomScale,
  zoomImageAtPoint,
  type ImageZoomBounds,
  type ImageZoomPoint,
  type ImageZoomState,
} from "../utils/imageZoom";

type ZoomableAttachmentImageProps = {
  source: string;
  alt: string;
  onFailure: () => void;
};

/**
 * Where the pointer sits relative to the image's untransformed centre. The
 * measured rect already carries the transform, so the current offset is added
 * back to recover the layout centre.
 */
function pointerFocus(
  image: HTMLImageElement,
  state: ImageZoomState,
  clientX: number,
  clientY: number,
): ImageZoomPoint {
  const rect = image.getBoundingClientRect();
  return {
    x: clientX - (rect.left + rect.width / 2) + state.offsetX,
    y: clientY - (rect.top + rect.height / 2) + state.offsetY,
  };
}

/** The zoom buttons sit inside the stage; their clicks are not pans. */
function fromControls(target: EventTarget | null): boolean {
  return target instanceof Element
    && target.closest(".image-attachment-zoom-controls") !== null;
}

export function ZoomableAttachmentImage({
  source,
  alt,
  onFailure,
}: ZoomableAttachmentImageProps): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(
    null,
  );
  const [zoom, setZoom] = useState<ImageZoomState>(IDENTITY_IMAGE_ZOOM);
  const zoomed = zoom.scale > IMAGE_ZOOM_MIN_SCALE;

  // Layout geometry, not the transformed rect: the transform is what we solve
  // for, so it must not feed back into its own bounds.
  const bounds = useCallback((): ImageZoomBounds => {
    const image = imageRef.current;
    if (!image) return containedImageBounds(0, 0, 0, 0);
    return containedImageBounds(
      image.clientWidth,
      image.clientHeight,
      image.naturalWidth,
      image.naturalHeight,
    );
  }, []);

  const zoomTo = useCallback((
    nextScale: number,
    focus: ImageZoomPoint = { x: 0, y: 0 },
  ) => {
    setZoom((current) => zoomImageAtPoint(current, bounds(), nextScale, focus));
  }, [bounds]);

  const reset = useCallback(() => setZoom(IDENTITY_IMAGE_ZOOM), []);

  useEffect(() => setZoom(IDENTITY_IMAGE_ZOOM), [source]);

  // React registers wheel listeners passively, so preventing the modal from
  // scrolling behind the stage needs a native non-passive listener.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent): void => {
      const image = imageRef.current;
      if (!image) return;
      event.preventDefault();
      setZoom((current) => zoomImageAtPoint(
        current,
        bounds(),
        wheelZoomScale(current.scale, event.deltaY),
        pointerFocus(image, current, event.clientX, event.clientY),
      ));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [bounds]);

  // Re-clamp when the dialog is resized so a zoomed image cannot strand itself
  // outside the stage.
  useEffect(() => {
    const image = imageRef.current;
    if (!image || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setZoom((current) => clampImageZoom(current, bounds()));
    });
    observer.observe(image);
    return () => observer.disconnect();
  }, [bounds]);

  const startDrag = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (!zoomed || event.button !== 0 || fromControls(event.target)) return;
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, [zoomed]);

  const continueDrag = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = { x: event.clientX - drag.x, y: event.clientY - drag.y };
    dragRef.current = {
      pointerId: drag.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    setZoom((current) => panImageZoom(current, bounds(), delta));
  }, [bounds]);

  const endDrag = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  return (
    <div
      ref={stageRef}
      className="image-attachment-zoom"
      data-zoomed={zoomed}
      role="group"
      aria-label={`Zoomable preview of ${alt}`}
      tabIndex={0}
      onPointerDown={startDrag}
      onPointerMove={continueDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={(event) => {
        const image = imageRef.current;
        if (fromControls(event.target)) return;
        if (zoomed || !image) {
          reset();
          return;
        }
        zoomTo(
          IMAGE_ZOOM_TOGGLE_SCALE,
          pointerFocus(image, zoom, event.clientX, event.clientY),
        );
      }}
      onKeyDown={(event) => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const pan = (x: number, y: number): void => {
          if (!zoomed) return;
          event.preventDefault();
          setZoom((current) => panImageZoom(current, bounds(), { x, y }));
        };
        if (event.key === "+" || event.key === "=") {
          event.preventDefault();
          zoomTo(steppedZoomScale(zoom.scale, 1));
        } else if (event.key === "-" || event.key === "_") {
          event.preventDefault();
          zoomTo(steppedZoomScale(zoom.scale, -1));
        } else if (event.key === "0") {
          event.preventDefault();
          reset();
        } else if (event.key === "ArrowLeft") {
          pan(IMAGE_ZOOM_KEYBOARD_PAN, 0);
        } else if (event.key === "ArrowRight") {
          pan(-IMAGE_ZOOM_KEYBOARD_PAN, 0);
        } else if (event.key === "ArrowUp") {
          pan(0, IMAGE_ZOOM_KEYBOARD_PAN);
        } else if (event.key === "ArrowDown") {
          pan(0, -IMAGE_ZOOM_KEYBOARD_PAN);
        }
      }}
    >
      <img
        ref={imageRef}
        src={source}
        alt={alt}
        draggable={false}
        style={{
          transform: `translate3d(${zoom.offsetX}px, ${zoom.offsetY}px, 0) scale(${zoom.scale})`,
        }}
        onError={onFailure}
      />
      <div className="image-attachment-zoom-controls">
        <button
          type="button"
          aria-label="Zoom out"
          disabled={!zoomed}
          onClick={() => zoomTo(steppedZoomScale(zoom.scale, -1))}
        >
          <ZoomOut size={15} aria-hidden="true" />
        </button>
        <output aria-label="Zoom level">{imageZoomPercentLabel(zoom.scale)}</output>
        <button
          type="button"
          aria-label="Zoom in"
          disabled={zoom.scale >= IMAGE_ZOOM_MAX_SCALE}
          onClick={() => zoomTo(steppedZoomScale(zoom.scale, 1))}
        >
          <ZoomIn size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Reset zoom"
          disabled={!zoomed}
          onClick={reset}
        >
          <RotateCcw size={14} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
