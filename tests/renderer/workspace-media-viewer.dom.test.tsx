import { StrictMode } from "react";
import * as XLSX from "xlsx";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildWorkspaceMediaPreviewTarget,
  MAX_WORKSPACE_MEDIA_PDF_BYTES,
  type WorkspaceMediaPreviewTarget,
} from "../../src/shared/workspace-media-preview";
import { FilesPanel } from "../../src/renderer/src/components/FilesPanel";
import { WorkspaceMediaPreviewDialog } from "../../src/renderer/src/components/media/WorkspaceMediaPreviewDialog";
import { WorkspaceMediaViewer } from "../../src/renderer/src/components/media/WorkspaceMediaViewer";
import { selectWorkspaceFile } from "../../src/renderer/src/hooks/workspace-tools/selectWorkspaceFile";

const pdfMocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
  workerSrc: "",
}));

vi.mock("pdfjs-dist", () => ({
  getDocument: (...args: unknown[]) => pdfMocks.getDocument(...args),
  GlobalWorkerOptions: {
    get workerSrc() {
      return pdfMocks.workerSrc;
    },
    set workerSrc(value: string) {
      pdfMocks.workerSrc = value;
    },
  },
}));

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ROOT = "/work/project";

function mediaTarget(relativePath: string): WorkspaceMediaPreviewTarget {
  const target = buildWorkspaceMediaPreviewTarget({
    projectId: PROJECT_ID,
    relativePath,
  });
  if (!target) throw new Error(`Expected media target for ${relativePath}`);
  return target;
}

function workbookBytes(): Uint8Array {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Region", "Revenue"],
      ["North", 1_200],
    ]),
    "Overview",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([["Owner"], ["Ada"]]),
    "Notes",
  );
  return XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
  }) as Uint8Array;
}

function binaryResponse(
  bytes: Uint8Array,
  mimeType: string,
  extraHeaders: Record<string, string> = {},
): Response {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, {
    status: 200,
    headers: {
      "content-length": String(bytes.byteLength),
      "content-type": mimeType,
      ...extraHeaders,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  pdfMocks.getDocument.mockReset();
  pdfMocks.workerSrc = "";
});

describe("WorkspaceMediaPreviewDialog and WorkspaceMediaViewer", () => {
  it("renders zoomable image preview, captures dimensions, fires actions, and closes on Escape", async () => {
    const target = mediaTarget("assets/screenshot.png");
    const onClose = vi.fn();
    const onShowInFiles = vi.fn();
    const onOpenExternally = vi.fn();
    const user = userEvent.setup();

    render(
      <>
        <button type="button">Trigger</button>
        <WorkspaceMediaPreviewDialog
          target={target}
          onClose={onClose}
          onShowInFiles={onShowInFiles}
          onOpenExternally={onOpenExternally}
        />
      </>,
    );

    const dialog = screen.getByRole("dialog", { name: "screenshot.png" });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveTextContent("PNG image");
    const image = screen.getByRole("img", { name: "screenshot.png" });
    expect(image).toHaveAttribute("src", target.url);

    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 800 });
    Object.defineProperty(image, "naturalHeight", { configurable: true, value: 600 });
    fireEvent.load(image);
    expect(dialog).toHaveTextContent("800 × 600");

    await user.click(screen.getByRole("button", { name: "Show in Files" }));
    expect(onShowInFiles).toHaveBeenCalledWith("assets/screenshot.png");

    await user.click(screen.getByRole("button", { name: "Open externally" }));
    expect(onOpenExternally).toHaveBeenCalledWith(target);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders video with metadata, shows error fallback, and cleans up media element on unmount", async () => {
    const target = mediaTarget("demos/walkthrough.mp4");
    const onMetadata = vi.fn();
    const onOpenExternally = vi.fn();
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const loadSpy = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);

    const { container, unmount } = render(
      <WorkspaceMediaViewer
        target={target}
        onMetadata={onMetadata}
        onOpenExternally={onOpenExternally}
      />,
    );

    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("src", target.url);

    Object.defineProperty(video!, "videoWidth", { configurable: true, value: 1920 });
    Object.defineProperty(video!, "videoHeight", { configurable: true, value: 1080 });
    Object.defineProperty(video!, "duration", { configurable: true, value: 95 });
    fireEvent.loadedMetadata(video!);
    expect(onMetadata).toHaveBeenCalledWith("1920 × 1080 · 1:35");

    unmount();
    expect(pauseSpy).toHaveBeenCalledOnce();
    expect(loadSpy).toHaveBeenCalledOnce();
    expect(video!.hasAttribute("src")).toBe(false);

    const user = userEvent.setup();
    const errorRender = render(
      <WorkspaceMediaViewer
        target={target}
        onOpenExternally={onOpenExternally}
      />,
    );
    const errorVideo = errorRender.container.querySelector("video")!;
    fireEvent.error(errorVideo);
    expect(screen.getByRole("alert")).toHaveTextContent("Video playback unavailable");
    await user.click(screen.getByRole("button", { name: "Open externally" }));
    expect(onOpenExternally).toHaveBeenCalledWith(target);
  });

  it("renders audio controls, captures duration, and cleans up on unmount", () => {
    const target = mediaTarget("audio/briefing.mp3");
    const onMetadata = vi.fn();
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const loadSpy = vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);

    const { container, unmount } = render(
      <WorkspaceMediaViewer target={target} onMetadata={onMetadata} />,
    );

    const audio = container.querySelector("audio");
    expect(audio).not.toBeNull();
    expect(audio).toHaveAttribute("controls");
    expect(audio).toHaveAttribute("src", target.url);

    Object.defineProperty(audio!, "duration", { configurable: true, value: 125 });
    fireEvent.loadedMetadata(audio!);
    expect(onMetadata).toHaveBeenCalledWith("2:05");

    unmount();
    expect(pauseSpy).toHaveBeenCalledOnce();
    expect(loadSpy).toHaveBeenCalledOnce();
    expect(audio!.hasAttribute("src")).toBe(false);
  });

  it("renders PDF pages via pdfjs-dist and navigates with ArrowRight/ArrowLeft", async () => {
    const target = mediaTarget("docs/spec.pdf");
    const onMetadata = vi.fn();
    const pdfDoc = {
      numPages: 3,
      getPage: vi.fn(() => new Promise(() => undefined)),
    };
    pdfMocks.getDocument.mockReturnValue({
      promise: Promise.resolve(pdfDoc),
      destroy: vi.fn(async () => undefined),
    });
    const fetchMock = vi.fn(async () => binaryResponse(
      new TextEncoder().encode("%PDF-1.7"),
      "application/pdf",
    ));
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <WorkspaceMediaViewer target={target} onMetadata={onMetadata} />,
    );

    expect(await screen.findByText("1 / 3")).toBeInTheDocument();
    expect(onMetadata).toHaveBeenCalledWith("3 pages");
    expect(fetchMock).toHaveBeenCalledWith(target.url, expect.objectContaining({
      cache: "no-store",
      credentials: "omit",
      signal: expect.any(AbortSignal),
    }));

    const preview = container.querySelector(".pdf-attachment-preview") as HTMLElement;
    await act(async () => {
      fireEvent.keyDown(preview, { key: "ArrowRight" });
    });
    expect(screen.getByText("2 / 3")).toBeInTheDocument();

    await act(async () => {
      fireEvent.keyDown(preview, { key: "ArrowLeft" });
    });
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
  });

  it("enforces the 50 MiB PDF size guard before decoding", async () => {
    const target = mediaTarget("docs/huge.pdf");
    const onOpenExternally = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-length": String(MAX_WORKSPACE_MEDIA_PDF_BYTES + 1),
      },
    })));

    render(
      <WorkspaceMediaViewer
        target={target}
        onOpenExternally={onOpenExternally}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("PDF preview unavailable");
    expect(pdfMocks.getDocument).not.toHaveBeenCalled();
  });

  it("renders real Excel .xlsx workbook sheets and switches tabs", async () => {
    const target = mediaTarget("reports/forecast.xlsx");
    const bytes = workbookBytes();
    const fetchMock = vi.fn(async () => binaryResponse(bytes, target.mimeType));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<WorkspaceMediaViewer target={target} />);

    const table = await screen.findByRole("table", { name: "forecast.xlsx · Overview" });
    expect(table).toHaveTextContent("Region");
    expect(table).toHaveTextContent("North");
    expect(table).toHaveTextContent("1200");

    await user.click(screen.getByRole("button", { name: "Notes" }));
    const notesTable = await screen.findByRole("table", { name: "forecast.xlsx · Notes" });
    expect(notesTable).toHaveTextContent("Ada");
    expect(fetchMock).toHaveBeenCalledWith(
      target.url,
      expect.objectContaining({ cache: "no-store", credentials: "omit" }),
    );
  });

  it("renders non-ASCII CSV spreadsheet and displays truncation notice", async () => {
    const target = mediaTarget("data/cities.csv");
    const bytes = new TextEncoder().encode("Name,City\nAda,Tōkyō\n");
    vi.stubGlobal("fetch", vi.fn(async () => binaryResponse(
      bytes,
      "text/csv",
      { "x-workspace-media-truncated": "true" },
    )));

    render(<WorkspaceMediaViewer target={target} />);

    const table = await screen.findByRole("table");
    expect(table).toHaveTextContent("Tōkyō");
    expect(screen.getByRole("status")).toHaveTextContent("truncated preview");
  });

  it("renders 0-byte and whitespace-only CSV as empty worksheet, parses TSV with commas, and reports 120+ rows", async () => {
    const emptyTarget = mediaTarget("data/empty.csv");
    vi.stubGlobal("fetch", vi.fn(async () => binaryResponse(new Uint8Array(0), "text/csv")));
    const { unmount } = render(<WorkspaceMediaViewer target={emptyTarget} />);
    expect(await screen.findByText("Empty worksheet")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    unmount();

    const tsvTarget = mediaTarget("data/items.tsv");
    const tsvLines = ["Item\tTags", ...Array.from({ length: 130 }, (_, index) => `Row${index}\ta,b,c`)];
    vi.stubGlobal("fetch", vi.fn(async () => binaryResponse(
      new TextEncoder().encode(tsvLines.join("\n")),
      "text/tab-separated-values",
    )));
    render(<WorkspaceMediaViewer target={tsvTarget} />);
    const table = await screen.findByRole("table");
    expect(table).toHaveTextContent("a,b,c");
    expect(screen.getByText(/120\+ rows/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy CSV" })).toBeInTheDocument();
  });

  it("keeps dialog open when Escape exits fullscreen, shows external-open errors, and exposes Copy path & Reload", async () => {
    const target = mediaTarget("demos/clip.mp4");
    const onClose = vi.fn();
    const onOpenExternally = vi.fn(async () => {
      throw new Error("OS opener failed");
    });
    const user = userEvent.setup();

    render(
      <WorkspaceMediaPreviewDialog
        target={target}
        onClose={onClose}
        onOpenExternally={onOpenExternally}
      />,
    );

    expect(screen.getByRole("button", { name: "Copy path" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();

    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      value: document.body,
    });
    try {
      await user.keyboard("{Escape}");
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        value: null,
      });
    }

    await user.click(screen.getByRole("button", { name: "Open externally" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not open clip.mp4 externally.");
  });

  it("neutralizes formula-leading cells in Copy CSV and keeps focus trapped inside dialog on keyboard Retry", async () => {
    const copyText = vi.fn(async () => true);
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: { copyText },
    });
    const paddedFullWidth = `${" ".repeat(40)}＝1+1`;
    const csvTarget = mediaTarget("data/formulas.csv");
    vi.stubGlobal("fetch", vi.fn(async () => binaryResponse(
      new TextEncoder().encode(`Safe,Formula,Tabbed,FullWidth\nhello,"=1+1","\t+SUM(A1)","${paddedFullWidth}"\nBob,cut`),
      "text/csv",
      { "x-workspace-media-truncated": "true" },
    )));
    const user = userEvent.setup();
    const { unmount } = render(<WorkspaceMediaViewer target={csvTarget} />);

    const copyButton = await screen.findByRole("button", { name: "Copy CSV" });
    expect(screen.getByText(/2\+ rows/u)).toBeInTheDocument();
    await user.click(copyButton);
    expect(copyText).toHaveBeenCalledWith(`Safe,Formula,Tabbed,FullWidth\nhello,'=1+1,'\t+SUM(A1),'${paddedFullWidth}`);
    unmount();

    // Whitespace-only truncated CSV still reports lower-bound 0+ rows
    vi.stubGlobal("fetch", vi.fn(async () => binaryResponse(
      new TextEncoder().encode("   \n  "),
      "text/csv",
      { "x-workspace-media-truncated": "true" },
    )));
    const emptyTruncated = render(<WorkspaceMediaViewer target={mediaTarget("data/ws-trunc.csv")} />);
    expect(await emptyTruncated.findByText(/0\+ rows/u)).toBeInTheDocument();
    emptyTruncated.unmount();

    // Tab-only TSV preserves empty grid rows instead of collapsing into Empty worksheet
    vi.stubGlobal("fetch", vi.fn(async () => binaryResponse(
      new TextEncoder().encode("\t\t\n\t\t\n"),
      "text/tab-separated-values",
    )));
    const tabOnlyTsv = render(<WorkspaceMediaViewer target={mediaTarget("data/grid.tsv")} />);
    expect(await tabOnlyTsv.findByText(/2 rows · 3 columns/u)).toBeInTheDocument();
    tabOnlyTsv.unmount();

    // Keyboard Retry in dialog preserves focus inside dialog so Tab stays trapped
    let attempts = 0;
    const pdfTarget = mediaTarget("docs/retry.pdf");
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempts += 1;
      return new Response("missing", { status: 404 });
    }));
    render(
      <WorkspaceMediaPreviewDialog
        target={pdfTarget}
        onClose={vi.fn()}
        onOpenExternally={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "retry.pdf" });
    const retryButton = await screen.findByRole("button", { name: "Retry" });
    retryButton.focus();
    await user.keyboard("{Enter}");
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

describe("selectWorkspaceFile binary media short-circuit", () => {
  it.each([
    "demos/clip.mp4",
    "docs/manual.pdf",
    "sheets/budget.xlsx",
    "images/banner.png",
  ])("skips workspace.file.read and clears errors for %s", async (path) => {
    const request = vi.fn();
    const authorityRef = { current: "auth-1" };
    const generationRef = { current: 4 };
    const setSelectedFile = vi.fn();
    const setSelectedFileLocation = vi.fn();
    const setSelectedMarkdownHeading = vi.fn();
    const setFilePreview = vi.fn();
    const setFilePreviewError = vi.fn();
    const setFilePreviewLoading = vi.fn();
    const setActionError = vi.fn();

    await selectWorkspaceFile([
      path,
      undefined,
      false,
      undefined,
      request,
      PROJECT_ID,
      undefined,
      authorityRef,
      "auth-1",
      generationRef,
      setSelectedFile,
      setSelectedFileLocation,
      setSelectedMarkdownHeading,
      setFilePreview,
      setFilePreviewError,
      setFilePreviewLoading,
      setActionError,
    ]);

    expect(request).not.toHaveBeenCalled();
    expect(generationRef.current).toBe(5);
    expect(setSelectedFile).toHaveBeenCalledWith(path);
    expect(setFilePreview).toHaveBeenCalledWith(null);
    expect(setFilePreviewError).toHaveBeenCalledWith(null);
    expect(setFilePreviewLoading).toHaveBeenCalledWith(false);
    expect(setActionError).toHaveBeenCalledWith(null);
  });

  it("defers text source read for dual-view .csv/.tsv until Source is requested and keeps UTF-16 read errors out of app-level actionError", async () => {
    const request = vi.fn(async () => ({
      type: "request.result" as const,
      requestId: "req-1",
      result: {
        kind: "workspace.file" as const,
        file: {
          path: "data/report.csv",
          content: "a,b\n1,2\n",
          truncated: false,
          language: "csv",
          contentDigest: "a".repeat(64),
          modifiedAt: "2026-11-26T00:00:00.000Z",
        },
      },
    }));
    const setFilePreview = vi.fn();
    const setFilePreviewError = vi.fn();
    const setActionError = vi.fn();

    // Default Preview selection skips workspace.file.read (so UTF-16 CSVs do not trigger UTF-8 errors).
    await selectWorkspaceFile([
      "data/utf16.csv",
      undefined,
      false,
      undefined,
      request as never,
      PROJECT_ID,
      undefined,
      { current: "auth-1" },
      "auth-1",
      { current: 0 },
      vi.fn(),
      vi.fn(),
      vi.fn(),
      setFilePreview,
      setFilePreviewError,
      vi.fn(),
      setActionError,
    ]);
    expect(request).not.toHaveBeenCalled();
    expect(setActionError).toHaveBeenLastCalledWith(null);

    // Explicitly requesting Source loads the text preview on demand.
    await selectWorkspaceFile([
      "data/report.csv",
      undefined,
      true,
      undefined,
      request as never,
      PROJECT_ID,
      undefined,
      { current: "auth-1" },
      "auth-1",
      { current: 1 },
      vi.fn(),
      vi.fn(),
      vi.fn(),
      setFilePreview,
      setFilePreviewError,
      vi.fn(),
      setActionError,
      true,
    ]);
    expect(request).toHaveBeenCalledOnce();
    expect(setFilePreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "data/report.csv" }),
    );

    // If Source read fails on a UTF-16 CSV, the error stays in previewError without surfacing actionError.
    const failingRequest = vi.fn(async () => {
      throw new Error("This file does not appear to be UTF-8 text.");
    });
    setActionError.mockClear();
    await selectWorkspaceFile([
      "data/utf16.tsv",
      undefined,
      true,
      undefined,
      failingRequest as never,
      PROJECT_ID,
      undefined,
      { current: "auth-1" },
      "auth-1",
      { current: 2 },
      vi.fn(),
      vi.fn(),
      vi.fn(),
      setFilePreview,
      setFilePreviewError,
      vi.fn(),
      setActionError,
      true,
    ]);
    expect(setFilePreviewError).toHaveBeenLastCalledWith("This file does not appear to be UTF-8 text.");
    expect(setActionError).not.toHaveBeenCalled();
  });
});

describe("FilesPanel media integration", () => {
  it("renders binary media preview with Expand and header Open file when preview is null", async () => {
    const onPreviewMedia = vi.fn();
    const onOpenFile = vi.fn();
    const user = userEvent.setup();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);

    const { container } = render(
      <FilesPanel
        projectRoot={PROJECT_ROOT}
        projectId={PROJECT_ID}
        entries={[{ path: "demos/clip.mp4", kind: "file" }]}
        preview={null}
        selectedPath="demos/clip.mp4"
        onSelectFile={vi.fn()}
        onLoadEntries={vi.fn()}
        onPreviewMedia={onPreviewMedia}
        onOpenFile={onOpenFile}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).not.toBeNull();
    });
    expect(container.querySelector("video")).toHaveAttribute(
      "src",
      mediaTarget("demos/clip.mp4").url,
    );

    await user.click(screen.getByRole("button", { name: "Expand" }));
    expect(onPreviewMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePath: "demos/clip.mp4",
        kind: "video",
      }),
    );

    await user.click(screen.getByRole("button", { name: "Open file" }));
    expect(onOpenFile).toHaveBeenCalledWith("demos/clip.mp4");
  });

  it("renders Preview | Source toggle for .csv and handles oversized source errors in Preview mode", async () => {
    const bytes = new TextEncoder().encode("Item,Qty\nBolt,42\n");
    vi.stubGlobal("fetch", vi.fn(async () => binaryResponse(bytes, "text/csv")));
    const user = userEvent.setup();

    const { rerender } = render(
      <FilesPanel
        projectRoot={PROJECT_ROOT}
        projectId={PROJECT_ID}
        entries={[{ path: "data/inventory.csv", kind: "file" }]}
        preview={{
          path: "data/inventory.csv",
          content: "Item,Qty\nBolt,42\n",
          truncated: false,
          language: "csv",
          contentDigest: "b".repeat(64),
          modifiedAt: "2026-11-26T00:00:00.000Z",
        }}
        selectedPath="data/inventory.csv"
        onSelectFile={vi.fn()}
        onLoadEntries={vi.fn()}
      />,
    );

    const toggle = screen.getByRole("group", { name: "CSV spreadsheet" });
    expect(within(toggle).getByRole("button", { name: "Preview" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByRole("table")).toHaveTextContent("Bolt");

    await user.click(within(toggle).getByRole("button", { name: "Source" }));
    expect(screen.getByLabelText("Contents of data/inventory.csv"))
      .toHaveTextContent("Item,Qty");

    // Re-selecting the same CSV clears preview back to null and resets cleanly to Preview (never "Select a file.")
    rerender(
      <FilesPanel
        projectRoot={PROJECT_ROOT}
        projectId={PROJECT_ID}
        entries={[{ path: "data/inventory.csv", kind: "file" }]}
        preview={null}
        selectedPath="data/inventory.csv"
        onSelectFile={vi.fn()}
        onLoadEntries={vi.fn()}
      />,
    );
    expect(await screen.findByRole("table")).toHaveTextContent("Bolt");
    expect(screen.queryByText("Select a file.")).toBeNull();

    // Switching from Source CSV to another file and returning to the same CSV also resets to Preview
    rerender(
      <FilesPanel
        projectRoot={PROJECT_ROOT}
        projectId={PROJECT_ID}
        entries={[
          { path: "data/inventory.csv", kind: "file" },
          { path: "src/app.ts", kind: "file" },
        ]}
        preview={{
          path: "data/inventory.csv",
          content: "Item,Qty\nBolt,42\n",
          truncated: false,
          language: "csv",
          contentDigest: "b".repeat(64),
          modifiedAt: "2026-11-26T00:00:00.000Z",
        }}
        selectedPath="data/inventory.csv"
        onSelectFile={vi.fn()}
        onLoadEntries={vi.fn()}
      />,
    );
    const roundTripToggle = screen.getByRole("group", { name: "CSV spreadsheet" });
    await user.click(within(roundTripToggle).getByRole("button", { name: "Source" }));
    expect(screen.getByLabelText("Contents of data/inventory.csv")).toHaveTextContent("Item,Qty");
    rerender(
      <FilesPanel
        projectRoot={PROJECT_ROOT}
        projectId={PROJECT_ID}
        entries={[
          { path: "data/inventory.csv", kind: "file" },
          { path: "src/app.ts", kind: "file" },
        ]}
        preview={{
          path: "src/app.ts",
          content: "export const ok = true;\n",
          truncated: false,
          language: "typescript",
          contentDigest: "d".repeat(64),
          modifiedAt: "2026-11-26T00:00:00.000Z",
        }}
        selectedPath="src/app.ts"
        onSelectFile={vi.fn()}
        onLoadEntries={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Contents of src/app.ts")).toHaveTextContent("export const ok");
    rerender(
      <FilesPanel
        projectRoot={PROJECT_ROOT}
        projectId={PROJECT_ID}
        entries={[
          { path: "data/inventory.csv", kind: "file" },
          { path: "src/app.ts", kind: "file" },
        ]}
        preview={null}
        selectedPath="data/inventory.csv"
        onSelectFile={vi.fn()}
        onLoadEntries={vi.fn()}
      />,
    );
    expect(await screen.findByRole("table")).toHaveTextContent("Bolt");
    expect(screen.queryByText("Select a file.")).toBeNull();

    // Large/UTF-16 CSV where source has not been loaded yet: Preview works and Source loads on demand
    const onSelectFile = vi.fn();
    rerender(
      <FilesPanel
        projectRoot={PROJECT_ROOT}
        projectId={PROJECT_ID}
        entries={[{ path: "data/utf16.csv", kind: "file" }]}
        preview={null}
        selectedPath="data/utf16.csv"
        onSelectFile={onSelectFile}
        onLoadEntries={vi.fn()}
      />,
    );

    expect(await screen.findByRole("table")).toHaveTextContent("Bolt");
    const utf16Toggle = screen.getByRole("group", { name: "CSV spreadsheet" });
    await user.click(within(utf16Toggle).getByRole("button", { name: "Source" }));
    expect(onSelectFile).toHaveBeenCalledWith("data/utf16.csv", undefined, true, undefined, true);
  });

  it("renders Preview | Source toggle for .svg files", async () => {
    const user = userEvent.setup();
    render(
      <FilesPanel
        projectRoot={PROJECT_ROOT}
        projectId={PROJECT_ID}
        entries={[{ path: "icons/logo.svg", kind: "file" }]}
        preview={{
          path: "icons/logo.svg",
          content: '<svg viewBox="0 0 10 10"><circle r="5" /></svg>',
          truncated: false,
          language: "xml",
          contentDigest: "c".repeat(64),
          modifiedAt: "2026-11-26T00:00:00.000Z",
        }}
        selectedPath="icons/logo.svg"
        onSelectFile={vi.fn()}
        onLoadEntries={vi.fn()}
      />,
    );

    const toggle = screen.getByRole("group", { name: "SVG image" });
    expect(within(toggle).getByRole("button", { name: "Preview" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByRole("img", { name: "logo.svg" }))
      .toHaveAttribute("src", mediaTarget("icons/logo.svg").url);

    await user.click(within(toggle).getByRole("button", { name: "Source" }));
    expect(screen.getByLabelText("Contents of icons/logo.svg"))
      .toHaveTextContent("<circle");
  });

  it("preserves video and audio src under React StrictMode and when switching between same-kind files", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);

    const firstVideo = mediaTarget("demos/first.mp4");
    const secondVideo = mediaTarget("demos/second.mp4");
    const { container, rerender } = render(
      <StrictMode>
        <WorkspaceMediaViewer target={firstVideo} />
      </StrictMode>,
    );

    expect(container.querySelector("video")).toHaveAttribute("src", firstVideo.url);

    rerender(
      <StrictMode>
        <WorkspaceMediaViewer target={secondVideo} />
      </StrictMode>,
    );
    expect(container.querySelector("video")).toHaveAttribute("src", secondVideo.url);

    const firstAudio = mediaTarget("audio/one.mp3");
    const secondAudio = mediaTarget("audio/two.mp3");
    rerender(
      <StrictMode>
        <WorkspaceMediaViewer target={firstAudio} />
      </StrictMode>,
    );
    expect(container.querySelector("audio")).toHaveAttribute("src", firstAudio.url);

    rerender(
      <StrictMode>
        <WorkspaceMediaViewer target={secondAudio} />
      </StrictMode>,
    );
    expect(container.querySelector("audio")).toHaveAttribute("src", secondAudio.url);
  });

  it("renders the new PDF when switching between two PDFs with the same page count on page 1", async () => {
    const renderedIds: string[] = [];
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    let callCount = 0;
    pdfMocks.getDocument.mockImplementation(() => {
      const id = `doc-${++callCount}`;
      return {
        promise: Promise.resolve({
          numPages: 2,
          getPage: async () => ({
            getViewport: () => ({ width: 200, height: 100 }),
            render: () => {
              renderedIds.push(id);
              return { promise: Promise.resolve(), cancel: vi.fn() };
            },
          }),
        }),
        destroy: vi.fn(async () => undefined),
      };
    });
    vi.stubGlobal("fetch", vi.fn(async () => binaryResponse(pdfBytes, "application/pdf")));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform: vi.fn(),
    } as never);
    const clientWidthSpy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);

    try {
      const { rerender } = render(
        <WorkspaceMediaViewer target={mediaTarget("docs/first.pdf")} />,
      );
      await waitFor(() => {
        expect(renderedIds).toEqual(["doc-1"]);
      });
      await waitFor(() => {
        expect(screen.queryByText(/Rendering page/u)).toBeNull();
      });

      rerender(
        <WorkspaceMediaViewer target={mediaTarget("docs/second.pdf")} />,
      );
      await waitFor(() => {
        expect(renderedIds).toEqual(["doc-1", "doc-2"]);
      });
      await waitFor(() => {
        expect(screen.queryByText(/Rendering page/u)).toBeNull();
      });
    } finally {
      clientWidthSpy.mockRestore();
    }
  });
});
