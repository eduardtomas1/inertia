import { ChevronLeft, ChevronRight, LoaderCircle } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
} from "react";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";

import { pdfCanvasLayout } from "../utils/pdfCanvasLayout";

interface PdfAttachmentPreviewProps {
  source: string;
  title: string;
  onFailure: () => void;
}

export function PdfAttachmentPreview({
  source,
  title,
  onFailure,
}: PdfAttachmentPreviewProps): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const taskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const renderRef = useRef<{ cancel(): void } | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [stageWidth, setStageWidth] = useState(0);
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const update = (): void => setStageWidth(Math.max(0, stage.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setRendering(true);
    void (async () => {
      const [{ getDocument, GlobalWorkerOptions }, response] =
        await Promise.all([
          import("pdfjs-dist"),
          fetch(source, { cache: "no-store", credentials: "omit" }),
        ]);
      if (!response.ok) throw new Error("The PDF preview is unavailable.");
      GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (cancelled) return;
      const task = getDocument({
        data: bytes,
        useWorkerFetch: false,
      });
      taskRef.current = task;
      const document = await task.promise;
      if (cancelled) {
        await task.destroy();
        return;
      }
      documentRef.current = document;
      setPageCount(document.numPages);
      setPageNumber(1);
    })().catch(() => {
      if (!cancelled) onFailure();
    });
    return () => {
      cancelled = true;
      renderRef.current?.cancel();
      renderRef.current = null;
      documentRef.current = null;
      const task = taskRef.current;
      taskRef.current = null;
      if (task) void task.destroy();
    };
  }, [onFailure, source]);

  useEffect(() => {
    const document = documentRef.current;
    const canvas = canvasRef.current;
    if (!document || !canvas || pageCount === 0 || stageWidth === 0) return;
    let cancelled = false;
    setRendering(true);
    renderRef.current?.cancel();
    void document.getPage(pageNumber).then(async (page) => {
      if (cancelled) return;
      const baseline = page.getViewport({ scale: 1 });
      const layout = pdfCanvasLayout({
        pageWidth: baseline.width,
        pageHeight: baseline.height,
        stageWidth,
        pixelRatio: window.devicePixelRatio,
      });
      const renderViewport = page.getViewport({
        scale: layout.renderScale,
      });
      canvas.width = layout.canvasWidth;
      canvas.height = layout.canvasHeight;
      canvas.style.width = `${layout.displayWidth}px`;
      canvas.style.height = `${layout.displayHeight}px`;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("Canvas is unavailable.");
      const render = page.render({
        canvas,
        canvasContext: context,
        viewport: renderViewport,
      });
      renderRef.current = render;
      await render.promise;
      if (!cancelled) setRendering(false);
    }).catch((error: unknown) => {
      if (
        !cancelled
        && !(error instanceof Error && error.name === "RenderingCancelledException")
      ) onFailure();
    });
    return () => {
      cancelled = true;
      renderRef.current?.cancel();
    };
  }, [onFailure, pageCount, pageNumber, stageWidth]);

  return (
    <div ref={stageRef} className="pdf-attachment-preview">
      <div
        className="pdf-attachment-preview-toolbar"
        aria-label="PDF page navigation"
      >
        <button
          type="button"
          aria-label="Previous PDF page"
          disabled={pageNumber <= 1}
          onClick={() => setPageNumber((current) => Math.max(1, current - 1))}
        >
          <ChevronLeft size={15} aria-hidden="true" />
        </button>
        <span aria-live="polite">
          {pageCount > 0 ? `${pageNumber} / ${pageCount}` : "Loading PDF"}
        </span>
        <button
          type="button"
          aria-label="Next PDF page"
          disabled={pageCount === 0 || pageNumber >= pageCount}
          onClick={() =>
            setPageNumber((current) => Math.min(pageCount, current + 1))}
        >
          <ChevronRight size={15} aria-hidden="true" />
        </button>
      </div>
      {rendering && (
        <span className="pdf-attachment-preview-loading" role="status">
          <LoaderCircle size={17} aria-hidden="true" />
          Rendering PDF…
        </span>
      )}
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`${title}, page ${pageNumber}`}
      />
    </div>
  );
}
