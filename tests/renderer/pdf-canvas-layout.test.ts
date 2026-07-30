import { describe, expect, it } from "vitest";

import {
  MAX_PDF_CANVAS_DIMENSION,
  MAX_PDF_CANVAS_PIXELS,
  pdfCanvasLayout,
} from "../../src/renderer/src/utils/pdfCanvasLayout";

describe("PDF preview canvas layout", () => {
  it("fits an ordinary page to the preview while retaining high-DPI detail", () => {
    const layout = pdfCanvasLayout({
      pageWidth: 612,
      pageHeight: 792,
      stageWidth: 1_000,
      pixelRatio: 2,
    });

    expect(layout.displayWidth).toBeLessThanOrEqual(960);
    expect(layout.canvasWidth).toBeGreaterThan(layout.displayWidth);
    expect(layout.canvasWidth * layout.canvasHeight)
      .toBeLessThanOrEqual(MAX_PDF_CANVAS_PIXELS);
  });

  it.each([
    { pageWidth: 50_000_000, pageHeight: 1_000 },
    { pageWidth: 1_000, pageHeight: 50_000_000 },
    { pageWidth: 100_000, pageHeight: 100_000 },
  ])("bounds crafted page boxes without distorting their aspect ratio", (page) => {
    const layout = pdfCanvasLayout({
      ...page,
      stageWidth: 900,
      pixelRatio: 4,
    });

    expect(layout.displayWidth).toBeLessThanOrEqual(MAX_PDF_CANVAS_DIMENSION);
    expect(layout.displayHeight).toBeLessThanOrEqual(MAX_PDF_CANVAS_DIMENSION);
    expect(layout.canvasWidth).toBeLessThanOrEqual(MAX_PDF_CANVAS_DIMENSION);
    expect(layout.canvasHeight).toBeLessThanOrEqual(MAX_PDF_CANVAS_DIMENSION);
    expect(layout.canvasWidth * layout.canvasHeight)
      .toBeLessThanOrEqual(MAX_PDF_CANVAS_PIXELS);
  });

  it("keeps one display scale for a moderately wide page", () => {
    const layout = pdfCanvasLayout({
      pageWidth: 10_000,
      pageHeight: 1_000,
      stageWidth: 900,
      pixelRatio: 2,
    });

    expect(layout.displayWidth / layout.displayHeight).toBeCloseTo(10, 1);
  });
});
