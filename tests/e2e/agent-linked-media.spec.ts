// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import * as XLSX from "xlsx";

import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { closeWorkspaceTools } from "./support/workspace-tools";

// Valid 64x64 0.25s VP8 WebM clip (541 bytes), decodable natively by Chromium on all platforms.
const SAMPLE_WEBM_BASE64 =
  "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwH/////////EU2bdKtNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHNTbuMU6uEElTDZ1OsggET7AEAAAAAAABoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmpyrXsYMPQkBNgI1MYXZmNjAuMTYuMTAwV0GNTGF2ZjYwLjE2LjEwMBZUrmvBrgEAAAAAAAA414EBc8WIn7o2BWTsG++cgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QF9eEA4ImwgUC6gUCagQISVMNn2HNzoGPAgGfImkWjh0VOQ09ERVJEh41MYXZmNjAuMTYuMTAwc3OyY8CLY8WIn7o2BWTsG+9nyKFFo4dFTkNPREVSRIeUTGF2YzYwLjMxLjEwMiBsaWJ2cHgfQ7Z1+OeBAKPDgQAAgNADAJ0BKkAAQAAARwiFhYiFhIgCAgJ1qgP4A/oCBxpGRgFwx0hLxAD++ecD/8LLWzTBn/hZn/4rWHWcX/icQKOWgQBkANEBAAEQEAAYABhYL/QACI6AAKOWgQDIANEBAAEQEAAYABhYL/QACI6AAA==";

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function buildChartPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  const bars = [
    { x0: 28, x1: 82, top: 72, color: [37, 99, 235] as const },
    { x0: 102, x1: 156, top: 44, color: [16, 185, 129] as const },
    { x0: 176, x1: 230, top: 58, color: [245, 158, 11] as const },
    { x0: 250, x1: 296, top: 24, color: [99, 102, 241] as const },
  ];
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      let r = 248;
      let g = 250;
      let b = 252;
      if (y === height - 20 && x >= 16 && x <= width - 16) {
        r = 148;
        g = 163;
        b = 184;
      } else if (y < height - 20) {
        const bar = bars.find((item) => x >= item.x0 && x <= item.x1 && y >= item.top);
        if (bar) {
          [r, g, b] = bar.color;
        }
      }
      const offset = row + 1 + x * 3;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
    }
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function buildTwoPagePdf(): Buffer {
  const page1Stream = "BT /F1 22 Tf 72 720 Td (Quarterly Report - Page 1) Tj ET";
  const page2Stream = "BT /F1 22 Tf 72 720 Td (Quarterly Report - Page 2) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(page1Stream, "ascii")} >>\nstream\n${page1Stream}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    `<< /Length ${Buffer.byteLength(page2Stream, "ascii")} >>\nstream\n${page2Stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  pdf += offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

function buildBudgetWorkbook(): Buffer {
  const workbook = XLSX.utils.book_new();
  const summarySheet = XLSX.utils.aoa_to_sheet([
    ["Category", "Q1", "Q2"],
    ["Revenue", 125000, 148500],
    ["Operating Cost", 64000, 68200],
  ]);
  const detailsSheet = XLSX.utils.aoa_to_sheet([
    ["Line Item", "Owner", "Monthly USD"],
    ["Cloud Hosting", "Platform", 4200],
    ["CI Runners", "Infra", 1850],
  ]);
  XLSX.utils.book_append_sheet(workbook, summarySheet, "Summary");
  XLSX.utils.book_append_sheet(workbook, detailsSheet, "Details");
  return Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Uint8Array);
}

const SAMPLE_DIAGRAM_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160">',
  '  <rect width="320" height="160" rx="12" fill="#0f172a"/>',
  '  <rect x="24" y="52" width="110" height="56" rx="8" fill="#2563eb"/>',
  '  <text x="79" y="85" fill="#ffffff" font-family="sans-serif" font-size="14" text-anchor="middle">Agent</text>',
  '  <rect x="186" y="52" width="110" height="56" rx="8" fill="#10b981"/>',
  '  <text x="241" y="85" fill="#ffffff" font-family="sans-serif" font-size="14" text-anchor="middle">Viewer</text>',
  '  <line x1="134" y1="80" x2="186" y2="80" stroke="#94a3b8" stroke-width="3"/>',
  "</svg>",
].join("\n");

let app!: AppFixture;

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "agent-linked-media",
    initialState: "conversation",
    beforeLaunch: async ({ testDirectory, workspaceDirectory }) => {
      await mkdir(join(workspaceDirectory, "assets"), { recursive: true });
      await mkdir(join(workspaceDirectory, "docs"), { recursive: true });
      await mkdir(join(workspaceDirectory, "data"), { recursive: true });

      const chartPath = join(workspaceDirectory, "assets", "chart.png");
      await writeFile(chartPath, buildChartPng(320, 180));
      await writeFile(join(workspaceDirectory, "assets", "diagram.svg"), SAMPLE_DIAGRAM_SVG, "utf8");
      await writeFile(
        join(workspaceDirectory, "assets", "demo.webm"),
        Buffer.from(SAMPLE_WEBM_BASE64, "base64"),
      );
      await writeFile(join(workspaceDirectory, "docs", "report.pdf"), buildTwoPagePdf());
      await writeFile(join(workspaceDirectory, "data", "budget.xlsx"), buildBudgetWorkbook());
      await writeFile(
        join(workspaceDirectory, "data", "metrics.csv"),
        "Metric,Q1,Q2\nLatency,42,35\nUptime,99.9,99.98\n",
        "utf8",
      );

      const store = new RuntimeStore(
        join(testDirectory, "data", "inertia.sqlite"),
        workspaceDirectory,
        { recoverInterruptedRuns: false },
      );
      const conversationId = store.shellSnapshot().activeConversationId;
      if (!conversationId) throw new Error("Media fixture needs an active conversation.");

      const chartFileUrl = pathToFileURL(chartPath).href;
      store.createMessage(
        conversationId,
        [
          "Here are the generated media and documents:",
          "",
          `![Sales chart](${chartFileUrl})`,
          "",
          "![Demo clip](assets/demo.webm)",
          "",
          "- [Quarterly report](docs/report.pdf)",
          "- [Budget workbook](data/budget.xlsx)",
          "- [Architecture diagram](assets/diagram.svg)",
          "- Metrics table: `data/metrics.csv`",
        ].join("\n"),
        "assistant",
      );
      store.close();
    },
  });
});

test.afterAll(async () => {
  await app?.close();
});

test("renders inline image and video embeds and opens PDF, Excel, SVG, and CSV previews in-ADE", async ({
  browserName: _browserName,
}, testInfo) => {
  const { page, electronApp, rendererErrors } = app;
  await app.resizeWindow(1_280, 820);
  await closeWorkspaceTools(page);
  await expect(page.locator(".workspace-panel:visible")).toHaveCount(0);

  // 1. Inline file:// PNG image loads with its exact 320x180 dimensions.
  const inlineImage = page.locator('img[alt="Sales chart"]');
  await expect(inlineImage).toBeVisible();
  await expect.poll(() => inlineImage.evaluate((element) => {
    const image = element as HTMLImageElement;
    return {
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
    };
  })).toEqual({ complete: true, naturalWidth: 320, naturalHeight: 180 });

  // 2. Inline WebM <video controls> loads metadata over inertia://bundle/workspace-media with 206 Range support.
  const inlineVideo = page.locator('video[aria-label="Demo clip"]');
  await expect(inlineVideo).toBeVisible();
  await expect.poll(() => inlineVideo.evaluate((element) => {
    const video = element as HTMLVideoElement;
    return {
      readyState: video.readyState,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      controls: video.controls,
    };
  })).toMatchObject({
    videoWidth: 64,
    videoHeight: 64,
    controls: true,
  });
  expect(await inlineVideo.evaluate((element) => (element as HTMLVideoElement).readyState))
    .toBeGreaterThanOrEqual(1);
  const videoSource = await inlineVideo.getAttribute("src");
  expect(videoSource).toMatch(/^inertia:\/\/bundle\/workspace-media\//u);
  const rangeResponse = await electronApp.evaluate(async ({ net }, url) => {
    const response = await net.fetch(url, { headers: { Range: "bytes=0-63" } });
    return {
      status: response.status,
      contentRange: response.headers.get("content-range"),
      byteLength: (await response.arrayBuffer()).byteLength,
    };
  }, videoSource!);
  expect(rangeResponse.status).toBe(206);
  expect(rangeResponse.contentRange).toMatch(/^bytes 0-63\/\d+$/u);
  expect(rangeResponse.byteLength).toBe(64);

  const inlineScreenshot = testInfo.outputPath("agent-linked-media-inline.png");
  await page.screenshot({ animations: "disabled", path: inlineScreenshot });
  await testInfo.attach("agent-linked-media-inline", {
    path: inlineScreenshot,
    contentType: "image/png",
  });

  // Clicking the inline PNG opens the zoomable lightbox dialog.
  await page.getByRole("button", { name: "Preview Sales chart" }).click();
  const imageDialog = page.getByRole("dialog", { name: "chart.png" });
  await expect(imageDialog).toBeVisible();
  const dialogImage = imageDialog.getByRole("img", { name: "chart.png" });
  await expect(dialogImage).toBeVisible();
  await expect.poll(() => dialogImage.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBe(320);
  await page.keyboard.press("Escape");
  await expect(imageDialog).toHaveCount(0);

  // 3. Clicking [Quarterly report] opens the in-ADE 2-page PDF viewer dialog.
  await page.getByRole("link", { name: "Quarterly report" }).click();
  const pdfDialog = page.getByRole("dialog", { name: "report.pdf" });
  await expect(pdfDialog).toBeVisible();
  const page1Canvas = pdfDialog.getByRole("img", { name: "report.pdf, page 1" });
  await expect(page1Canvas).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page1Canvas.evaluate((element) => (element as HTMLCanvasElement).width))
    .toBeGreaterThan(100);
  await expect(pdfDialog.getByText("1 / 2", { exact: true })).toBeVisible();

  const pdfScreenshot = testInfo.outputPath("agent-linked-media-pdf.png");
  await page.screenshot({ animations: "disabled", path: pdfScreenshot });
  await testInfo.attach("agent-linked-media-pdf", {
    path: pdfScreenshot,
    contentType: "image/png",
  });

  await pdfDialog.getByRole("button", { name: "Next PDF page" }).click();
  await expect(pdfDialog.getByText("2 / 2", { exact: true })).toBeVisible();
  const page2Canvas = pdfDialog.getByRole("img", { name: "report.pdf, page 2" });
  await expect(page2Canvas).toBeVisible();
  await expect.poll(() => page2Canvas.evaluate((element) => (element as HTMLCanvasElement).width))
    .toBeGreaterThan(100);
  await page.keyboard.press("Escape");
  await expect(pdfDialog).toHaveCount(0);

  // 4. Clicking [Budget workbook] opens the in-ADE multi-sheet Excel viewer dialog.
  await page.getByRole("link", { name: "Budget workbook" }).click();
  const excelDialog = page.getByRole("dialog", { name: "budget.xlsx" });
  await expect(excelDialog).toBeVisible();
  const sheetTabs = excelDialog.getByRole("group", { name: "Workbook sheets" });
  await expect(sheetTabs.getByRole("button", { name: "Summary", exact: true })).toBeVisible();
  await expect(sheetTabs.getByRole("button", { name: "Details", exact: true })).toBeVisible();
  await expect(excelDialog.getByRole("cell", { name: "Revenue", exact: true })).toBeVisible();
  await expect(excelDialog.getByRole("cell", { name: "125000", exact: true })).toBeVisible();

  const excelScreenshot = testInfo.outputPath("agent-linked-media-excel.png");
  await page.screenshot({ animations: "disabled", path: excelScreenshot });
  await testInfo.attach("agent-linked-media-excel", {
    path: excelScreenshot,
    contentType: "image/png",
  });

  await sheetTabs.getByRole("button", { name: "Details", exact: true }).click();
  await expect(sheetTabs.getByRole("button", { name: "Details", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(excelDialog.getByRole("cell", { name: "Cloud Hosting", exact: true })).toBeVisible();
  await expect(excelDialog.getByRole("cell", { name: "4200", exact: true })).toBeVisible();

  // 5. Clicking "Show in Files" renders budget.xlsx inside FilesPanel without any UTF-8 error.
  await excelDialog.getByRole("button", { name: "Show in Files" }).click();
  await expect(excelDialog).toHaveCount(0);
  const workspacePanel = page.locator(".workspace-panel:visible").first();
  await expect(workspacePanel).toBeVisible();
  await expect(workspacePanel.getByRole("tab", { name: "Files" }))
    .toHaveAttribute("aria-selected", "true");
  await expect(workspacePanel.getByText("This file does not appear to be UTF-8 text.")).toHaveCount(0);
  await expect(workspacePanel.getByRole("group", { name: "Workbook sheets" })).toBeVisible();
  await expect(workspacePanel.getByRole("cell", { name: "Revenue", exact: true })).toBeVisible();

  const filesPanelScreenshot = testInfo.outputPath("agent-linked-media-files-panel.png");
  await page.screenshot({ animations: "disabled", path: filesPanelScreenshot });
  await testInfo.attach("agent-linked-media-files-panel", {
    path: filesPanelScreenshot,
    contentType: "image/png",
  });

  // 6. Clicking [Architecture diagram] opens the SVG preview dialog.
  await page.getByRole("link", { name: "Architecture diagram" }).click();
  const svgDialog = page.getByRole("dialog", { name: "diagram.svg" });
  await expect(svgDialog).toBeVisible();
  const svgImage = svgDialog.getByRole("img", { name: "diagram.svg" });
  await expect(svgImage).toBeVisible();
  await expect.poll(() => svgImage.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(svgDialog).toHaveCount(0);

  // 7. Clicking the `data/metrics.csv` FileChip opens the CSV spreadsheet preview dialog.
  await page.locator('.response-file-chip[data-file-chip-text="data/metrics.csv"]').click();
  const csvDialog = page.getByRole("dialog", { name: "metrics.csv" });
  await expect(csvDialog).toBeVisible();
  await expect(csvDialog.getByRole("cell", { name: "Latency", exact: true })).toBeVisible();
  await expect(csvDialog.getByRole("cell", { name: "99.98", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(csvDialog).toHaveCount(0);

  expect(rendererErrors).toEqual([]);
});
