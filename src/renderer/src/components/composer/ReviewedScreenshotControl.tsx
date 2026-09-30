import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, X } from "lucide-react";
import type { SnapshotDelivery } from "@shared/snapshots";
import type { SnapshotReview, SnapshotReviewArea, SnapshotReviewRequest } from "@shared/snapshot-review";
import { useNativePreviewSuspension } from "../../hooks/useNativePreviewSuspension";
import { captureModalFocus, trapModalFocus } from "../../utils/modalFocus";
import { IconButton } from "../ui";
import "./ReviewedScreenshotControl.css";

export function ReviewedScreenshotControl({ conversationId, disabled = false }: {
  conversationId: string; disabled?: boolean;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<SnapshotReview | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [area, setArea] = useState<SnapshotReviewArea>({ x: 0, y: 0, width: 1, height: 1 });
  const id = useRef<string | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const image = review?.stage === "image" ? review : null;
  useNativePreviewSuspension(open);

  useEffect(() => {
    const bridge = window.inertia;
    const receive = (event: Event): void => {
      const delivery = (event as CustomEvent<SnapshotDelivery>).detail;
      if (delivery.conversationId !== conversationId || !delivery.review || delivery.review.reviewId !== id.current) return;
      const next = delivery.review;
      setPending(false);
      if (next.stage === "closed") {
        id.current = null;
        setReview(null);
        if (next.message) setError(next.message);
        else setOpen(false);
      } else {
        setReview(next);
        if (next.stage === "image") setArea({ x: 0, y: 0, width: next.width, height: next.height });
      }
    };
    window.addEventListener("inertia:snapshot-review", receive);
    return () => {
      window.removeEventListener("inertia:snapshot-review", receive);
      const reviewId = id.current;
      id.current = null;
      if (reviewId) void bridge?.snapshot({ type: "review-cancel", reviewId }).catch(() => undefined);
    };
  }, [conversationId]);

  useEffect(() => {
    setOpen(false); setReview(null); setError(null); setPending(false);
  }, [conversationId]);

  useEffect(() => {
    if (!open) return;
    const restore = captureModalFocus(false);
    closeButton.current?.focus();
    return restore;
  }, [open]);

  const request = async (input: SnapshotReviewRequest): Promise<void> => {
    const requested = id.current;
    setPending(true); setError(null);
    try { await window.inertia.snapshot(input); }
    catch (cause) {
      if (id.current === requested) setError(cause instanceof Error ? cause.message : "Screenshot is unavailable.");
    } finally { if (id.current === requested) setPending(false); }
  };
  const close = (): void => {
    const reviewId = id.current;
    id.current = null; setOpen(false); setReview(null); setError(null); setPending(false);
    if (reviewId) void window.inertia.snapshot({ type: "review-cancel", reviewId }).catch(() => undefined);
  };
  const start = (): void => {
    id.current = crypto.randomUUID(); setOpen(true); setReview(null); setError(null);
    void request({ type: "review-start", reviewId: id.current, conversationId });
  };
  const edit = (operation: "crop" | "mask"): void => {
    if (image) void request({ type: "review-edit", reviewId: image.reviewId, revision: image.revision, operation, area });
  };
  const validArea = image && area.x >= 0 && area.y >= 0 && area.width > 0 && area.height > 0
    && area.x + area.width <= image.width && area.y + area.height <= image.height;

  if (!navigator.platform.toLowerCase().includes("linux") || !window.inertia?.snapshot) return null;
  return <>
    <IconButton label="Take reviewed screenshot" disabled={disabled || open} onClick={start}><Camera size={16} /></IconButton>
    {open && createPortal(<div className="snapshot-backdrop" role="presentation">
      <section className="snapshot-dialog screenshot-review" role="dialog" aria-modal="true" aria-labelledby="screenshot-review-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.stopPropagation(); close(); }
          else trapModalFocus(event, event.currentTarget);
        }}>
        <header><h2 id="screenshot-review-title">Review screenshot</h2><button type="button" ref={closeButton} aria-label="Cancel screenshot" onClick={close}><X size={18} /></button></header>
        <p className="snapshot-note">Automatic masking is not verified. Check the image, crop it or mask sensitive areas before attaching. Nothing is sent automatically.</p>
        {pending && <p role="status">{review ? "Preparing screenshot…" : "Choose a source in the system picker if it opens…"}</p>}
        {error && <p role="alert" className="snapshot-alert">{error}</p>}
        {review?.stage === "sources" && <div className="screenshot-sources" aria-label="Windows and screens">
          {review.sources.map((source) => <button type="button" key={source.id} disabled={pending}
            onClick={() => void request({ type: "review-select", reviewId: review.reviewId, sourceId: source.id })}>
            <img src={source.preview} alt="" /><span>{source.name}</span>
          </button>)}
        </div>}
        {image && <>
          <div className="screenshot-image" style={{ width: `min(100%, ${image.width}px, ${48 * image.width / image.height}vh)`, aspectRatio: image.width / image.height }} onPointerDown={(event) => {
            if (pending) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const x = Math.max(0, Math.min(image.width - 1, Math.floor((event.clientX - rect.left) * image.width / rect.width)));
            const y = Math.max(0, Math.min(image.height - 1, Math.floor((event.clientY - rect.top) * image.height / rect.height)));
            drag.current = { x, y }; setArea({ x, y, width: 1, height: 1 }); event.currentTarget.setPointerCapture(event.pointerId);
          }} onPointerMove={(event) => {
            if (!drag.current || pending) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const x = Math.max(0, Math.min(image.width, Math.round((event.clientX - rect.left) * image.width / rect.width)));
            const y = Math.max(0, Math.min(image.height, Math.round((event.clientY - rect.top) * image.height / rect.height)));
            setArea({ x: Math.min(x, drag.current.x), y: Math.min(y, drag.current.y), width: Math.max(1, Math.abs(x - drag.current.x)), height: Math.max(1, Math.abs(y - drag.current.y)) });
          }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
            <img src={image.preview} alt="Screenshot to review before attaching" draggable={false} />
            {validArea && <span className="screenshot-area" style={{ left: `${area.x / image.width * 100}%`, top: `${area.y / image.height * 100}%`, width: `${area.width / image.width * 100}%`, height: `${area.height / image.height * 100}%` }} />}
          </div>
          <fieldset disabled={pending} className="screenshot-edit"><legend>Drag an area on the image or enter its pixel coordinates</legend>
            {(["x", "y", "width", "height"] as const).map((key) => <label key={key}>{({ x: "Left", y: "Top", width: "Width", height: "Height" })[key]}
              <input type="number" min={key === "x" || key === "y" ? 0 : 1} max={key === "x" || key === "width" ? image.width : image.height}
                value={area[key]} onChange={(event) => setArea({ ...area, [key]: Math.floor(Number(event.target.value)) })} />
            </label>)}
            <button type="button" className="secondary-button" disabled={!validArea} onClick={() => edit("crop")}>Crop to area</button>
            <button type="button" className="secondary-button" disabled={!validArea} onClick={() => edit("mask")}>Mask area</button>
          </fieldset>
          <footer><button type="button" className="secondary-button" onClick={close}>Discard</button>
            <button type="button" className="primary-button" disabled={pending || disabled}
              onClick={() => void request({ type: "review-approve", reviewId: image.reviewId, revision: image.revision })}>Attach reviewed image</button></footer>
        </>}
      </section>
    </div>, document.body)}
  </>;
}
