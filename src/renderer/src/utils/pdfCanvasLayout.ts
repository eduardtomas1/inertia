export const MAX_PDF_CANVAS_PIXELS = 8 * 1024 * 1024;
export const MAX_PDF_CANVAS_DIMENSION = 8_192;
const MAX_PDF_DISPLAY_DIMENSION = 8_192;
const MAX_PDF_DISPLAY_SCALE = 1.65;
const MAX_PDF_PIXEL_RATIO = 2;
const PREVIEW_HORIZONTAL_INSET = 40;

export interface PdfCanvasLayoutInput {
  pageWidth: number;
  pageHeight: number;
  stageWidth: number;
  pixelRatio: number;
}

export interface PdfCanvasLayout {
  displayScale: number;
  renderScale: number;
  displayWidth: number;
  displayHeight: number;
  canvasWidth: number;
  canvasHeight: number;
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

export function pdfCanvasLayout({
  pageWidth,
  pageHeight,
  stageWidth,
  pixelRatio,
}: PdfCanvasLayoutInput): PdfCanvasLayout {
  const width = positiveFinite(pageWidth, "PDF page width");
  const height = positiveFinite(pageHeight, "PDF page height");
  const availableWidth = Math.max(
    1,
    positiveFinite(stageWidth, "PDF preview width") - PREVIEW_HORIZONTAL_INSET,
  );
  const displayScale = Math.min(
    MAX_PDF_DISPLAY_SCALE,
    availableWidth / width,
    MAX_PDF_DISPLAY_DIMENSION / width,
    MAX_PDF_DISPLAY_DIMENSION / height,
  );
  const safePixelRatio = Number.isFinite(pixelRatio)
    ? Math.min(MAX_PDF_PIXEL_RATIO, Math.max(1, pixelRatio))
    : 1;
  const areaScale = Math.sqrt(MAX_PDF_CANVAS_PIXELS / width / height);
  const renderScale = Math.min(
    displayScale * safePixelRatio,
    areaScale,
    MAX_PDF_CANVAS_DIMENSION / width,
    MAX_PDF_CANVAS_DIMENSION / height,
  );
  positiveFinite(displayScale, "PDF display scale");
  positiveFinite(renderScale, "PDF render scale");
  return {
    displayScale,
    renderScale,
    displayWidth: Math.max(1, Math.ceil(width * displayScale)),
    displayHeight: Math.max(1, Math.ceil(height * displayScale)),
    canvasWidth: Math.max(1, Math.floor(width * renderScale)),
    canvasHeight: Math.max(1, Math.floor(height * renderScale)),
  };
}
