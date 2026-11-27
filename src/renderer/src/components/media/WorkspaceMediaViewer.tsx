import clsx from "clsx";
import { ExternalLink, Music } from "lucide-react";
import {
  lazy,
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFPageProxy } from "pdfjs-dist";

import {
  MAX_WORKSPACE_MEDIA_PDF_BYTES,
  MAX_WORKSPACE_MEDIA_SPREADSHEET_BYTES,
  MAX_WORKSPACE_MEDIA_TEXT_SPREADSHEET_BYTES,
  classifyWorkspaceMediaPath,
  type WorkspaceMediaPreviewTarget,
} from "@shared/workspace-media-preview";
import {
  SPREADSHEET_PREVIEW_LIMITS,
  readSpreadsheetWorkbook,
  type SpreadsheetPreviewWorkbook,
} from "@shared/spreadsheet-workbook";
import { decodeTextAttachment } from "@shared/text-attachment";
import { INTERFACE_LOCALE } from "../../lib/locale";
import { pdfCanvasLayout } from "../../utils/pdfCanvasLayout";
import { ZoomableAttachmentImage } from "../ZoomableAttachmentImage";
import { LoadingMark } from "../ui";
import "./WorkspaceMediaPreview.css";

const PdfAttachmentPreview = lazy(async () => ({
  default: (await import("../PdfAttachmentPreview")).PdfAttachmentPreview,
}));

export interface WorkspaceMediaViewerProps {
  readonly target: WorkspaceMediaPreviewTarget;
  readonly compact?: boolean;
  readonly onOpenExternally?: (target: WorkspaceMediaPreviewTarget) => void;
  readonly onMetadata?: (meta: string) => void;
}

function formatMediaDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const secs = total % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

function columnName(column: number): string {
  let value = column + 1;
  let output = "";
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output;
}

function trimIncompleteText(bytes: Uint8Array): Uint8Array {
  for (let omitted = 0; omitted <= 4; omitted += 1) {
    const prefix = bytes.subarray(0, bytes.length - omitted);
    try {
      decodeTextAttachment(prefix);
      return prefix;
    } catch {
      continue;
    }
  }
  return bytes;
}

async function loadWorkspacePdf(source: string) {
  const [{ getDocument, GlobalWorkerOptions }, response] = await Promise.all([
    import("pdfjs-dist"),
    fetch(source, { cache: "no-store", credentials: "omit" }),
  ]);
  if (!response.ok) throw new Error("The PDF preview is unavailable.");
  const contentLength = response.headers.get("content-length");
  const declaredBytes = contentLength === null ? null : Number(contentLength);
  if (
    declaredBytes !== null
    && (
      !Number.isSafeInteger(declaredBytes)
      || declaredBytes < 1
      || declaredBytes > MAX_WORKSPACE_MEDIA_PDF_BYTES
    )
  ) {
    throw new Error("The PDF exceeds the 50 MiB preview limit.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_WORKSPACE_MEDIA_PDF_BYTES) {
    throw new Error("The PDF exceeds the 50 MiB preview limit.");
  }
  GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  return { bytes, getDocument };
}

function prepareWorkspacePdfCanvas(
  canvas: HTMLCanvasElement,
  page: PDFPageProxy,
  stageWidth: number,
) {
  const baseline = page.getViewport({ scale: 1 });
  const layout = pdfCanvasLayout({
    pageWidth: baseline.width,
    pageHeight: baseline.height,
    stageWidth,
    pixelRatio: window.devicePixelRatio,
  });
  const viewport = page.getViewport({ scale: layout.renderScale });
  canvas.width = layout.canvasWidth;
  canvas.height = layout.canvasHeight;
  canvas.style.width = `${layout.displayWidth}px`;
  canvas.style.height = `${layout.displayHeight}px`;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Canvas is unavailable.");
  return { context, viewport };
}

function MediaErrorFallback({
  title,
  detail,
  target,
  onOpenExternally,
}: {
  title: string;
  detail: string;
  target: WorkspaceMediaPreviewTarget;
  onOpenExternally?: (target: WorkspaceMediaPreviewTarget) => void;
}): React.JSX.Element {
  return (
    <div className="workspace-media-error" role="alert">
      <strong>{title}</strong>
      <span>{detail}</span>
      {onOpenExternally && (
        <div className="workspace-media-error-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => onOpenExternally(target)}
          >
            <ExternalLink size={14} aria-hidden="true" />
            <span>Open externally</span>
          </button>
        </div>
      )}
    </div>
  );
}

function WorkspaceVideoViewer({
  target,
  onOpenExternally,
  onMetadata,
}: {
  target: WorkspaceMediaPreviewTarget;
  onOpenExternally?: (target: WorkspaceMediaPreviewTarget) => void;
  onMetadata?: (meta: string) => void;
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [target.url]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || failed) return;
    video.src = target.url;
    return () => {
      try {
        video.pause();
      } catch {
        // Non-media DOM environments may not implement pause().
      }
      video.removeAttribute("src");
      try {
        video.load();
      } catch {
        // Non-media DOM environments may not implement load().
      }
    };
  }, [target.url, failed]);

  if (failed) {
    return (
      <MediaErrorFallback
        title="Video playback unavailable"
        detail="This video codec or format cannot be played in the embedded viewer."
        target={target}
        onOpenExternally={onOpenExternally}
      />
    );
  }

  return (
    <div className="workspace-media-video-wrap">
      <video
        ref={videoRef}
        className="workspace-media-video"
        controls
        preload="metadata"
        playsInline
        aria-label={target.name}
        onLoadedMetadata={(event) => {
          const element = event.currentTarget;
          const parts: string[] = [];
          if (element.videoWidth > 0 && element.videoHeight > 0) {
            parts.push(`${element.videoWidth} × ${element.videoHeight}`);
          }
          const duration = formatMediaDuration(element.duration);
          if (duration) parts.push(duration);
          if (parts.length > 0) onMetadata?.(parts.join(" · "));
        }}
        onError={() => setFailed(true)}
      />
    </div>
  );
}

function WorkspaceAudioViewer({
  target,
  descriptorLabel,
  onOpenExternally,
  onMetadata,
}: {
  target: WorkspaceMediaPreviewTarget;
  descriptorLabel: string;
  onOpenExternally?: (target: WorkspaceMediaPreviewTarget) => void;
  onMetadata?: (meta: string) => void;
}): React.JSX.Element {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [target.url]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || failed) return;
    audio.src = target.url;
    return () => {
      try {
        audio.pause();
      } catch {
        // Non-media DOM environments may not implement pause().
      }
      audio.removeAttribute("src");
      try {
        audio.load();
      } catch {
        // Non-media DOM environments may not implement load().
      }
    };
  }, [target.url, failed]);

  if (failed) {
    return (
      <MediaErrorFallback
        title="Audio playback unavailable"
        detail="This audio format cannot be played in the embedded viewer."
        target={target}
        onOpenExternally={onOpenExternally}
      />
    );
  }

  return (
    <div className="workspace-media-audio-wrap">
      <div className="workspace-media-audio-icon" aria-hidden="true">
        <Music size={16} />
      </div>
      <div className="workspace-media-audio-meta">
        <strong title={target.name}>{target.name}</strong>
        <span>{descriptorLabel}</span>
      </div>
      <audio
        ref={audioRef}
        className="workspace-media-audio"
        controls
        preload="metadata"
        aria-label={target.name}
        onLoadedMetadata={(event) => {
          const duration = formatMediaDuration(event.currentTarget.duration);
          if (duration) onMetadata?.(duration);
        }}
        onError={() => setFailed(true)}
      />
    </div>
  );
}

function WorkspaceSpreadsheetViewer({
  target,
  onOpenExternally,
  onMetadata,
}: {
  target: WorkspaceMediaPreviewTarget;
  onOpenExternally?: (target: WorkspaceMediaPreviewTarget) => void;
  onMetadata?: (meta: string) => void;
}): React.JSX.Element {
  const [workbook, setWorkbook] = useState<SpreadsheetPreviewWorkbook | null>(null);
  const [sourceTruncated, setSourceTruncated] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setWorkbook(null);
    setSourceTruncated(false);
    setErrorMessage(null);
    setActiveIndex(0);

    const isTextSpreadsheet = target.extension === "csv" || target.extension === "tsv";
    const maxBytes = isTextSpreadsheet
      ? MAX_WORKSPACE_MEDIA_TEXT_SPREADSHEET_BYTES
      : MAX_WORKSPACE_MEDIA_SPREADSHEET_BYTES;

    void fetch(target.url, {
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error("Spreadsheet preview is unavailable.");
      const contentLength = response.headers.get("content-length");
      const declaredBytes = contentLength === null ? null : Number(contentLength);
      if (
        declaredBytes !== null
        && (
          !Number.isSafeInteger(declaredBytes)
          || declaredBytes < 1
          || declaredBytes > maxBytes
        )
      ) {
        throw new Error("Spreadsheet exceeds the preview size limit.");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength < 1 || bytes.byteLength > maxBytes) {
        throw new Error("Spreadsheet exceeds the preview size limit.");
      }
      const truncated = response.headers.get("x-workspace-media-truncated") === "true";
      const previewBytes = truncated && isTextSpreadsheet ? trimIncompleteText(bytes) : bytes;
      const workbookBytes = isTextSpreadsheet
        ? new TextEncoder().encode(`\uFEFF${decodeTextAttachment(previewBytes)}`)
        : bytes;
      const parsed = await readSpreadsheetWorkbook(
        workbookBytes,
        SPREADSHEET_PREVIEW_LIMITS,
      );
      if (controller.signal.aborted) return;
      startTransition(() => {
        setSourceTruncated(truncated);
        setWorkbook(parsed);
      });
      const first = parsed.sheets[0];
      if (parsed.totalSheets > 1) {
        onMetadata?.(`${parsed.totalSheets.toLocaleString(INTERFACE_LOCALE)} sheets`);
      } else if (first) {
        onMetadata?.(
          `${first.totalRows.toLocaleString(INTERFACE_LOCALE)} ${first.totalRows === 1 ? "row" : "rows"} · ${first.totalColumns.toLocaleString(INTERFACE_LOCALE)} ${first.totalColumns === 1 ? "column" : "columns"}`,
        );
      }
    }).catch((error: unknown) => {
      if (
        controller.signal.aborted
        || (error instanceof DOMException && error.name === "AbortError")
      ) return;
      setErrorMessage(
        error instanceof Error && error.message.trim()
          ? error.message
          : "Spreadsheet preview is unavailable.",
      );
    });

    return () => controller.abort();
  }, [onMetadata, target.extension, target.url]);

  const activeSheet = workbook?.sheets[activeIndex] ?? workbook?.sheets[0] ?? null;
  const visibleColumns = useMemo(
    () => (activeSheet
      ? Math.max(0, ...activeSheet.rows.map(({ cells }) => cells.length))
      : 0),
    [activeSheet],
  );

  if (errorMessage) {
    return (
      <MediaErrorFallback
        title="Spreadsheet preview unavailable"
        detail={errorMessage}
        target={target}
        onOpenExternally={onOpenExternally}
      />
    );
  }

  if (!workbook) {
    return (
      <div className="document-attachment-preview-loading" role="status">
        <LoadingMark size={16} aria-hidden="true" />
        <span>Loading spreadsheet…</span>
      </div>
    );
  }

  if (!activeSheet) {
    return (
      <div className="spreadsheet-attachment-empty">
        <strong>No readable worksheets</strong>
        <span>The workbook has no previewable cells.</span>
      </div>
    );
  }

  const truncated = activeSheet.rowsTruncated
    || activeSheet.columnsTruncated
    || activeSheet.contentTruncated;

  return (
    <div className="spreadsheet-attachment-preview">
      <div className="spreadsheet-attachment-toolbar">
        <div
          className="spreadsheet-attachment-tabs"
          role="group"
          aria-label="Workbook sheets"
        >
          {workbook.sheets.map((sheet, index) => (
            <button
              type="button"
              aria-pressed={index === activeIndex}
              key={`${sheet.name}-${index}`}
              onClick={() => setActiveIndex(index)}
            >
              {sheet.name}
            </button>
          ))}
        </div>
        <span className="spreadsheet-attachment-summary">
          {activeSheet.totalRows.toLocaleString(INTERFACE_LOCALE)}{" "}
          {activeSheet.totalRows === 1 ? "row" : "rows"}
          {" · "}
          {activeSheet.totalColumns.toLocaleString(INTERFACE_LOCALE)}{" "}
          {activeSheet.totalColumns === 1 ? "column" : "columns"}
          {workbook.totalSheets > 1
            ? ` · ${workbook.totalSheets.toLocaleString(INTERFACE_LOCALE)} sheets`
            : ""}
        </span>
      </div>
      <div
        className="spreadsheet-attachment-table-wrap"
        data-preview-truncated={truncated || workbook.sheetsTruncated || sourceTruncated}
        tabIndex={0}
        aria-label={`Scrollable worksheet preview for ${activeSheet.name}`}
      >
        {activeSheet.rows.length === 0 || visibleColumns === 0
          ? (
              <div className="spreadsheet-attachment-empty">
                <strong>Empty worksheet</strong>
                <span>{activeSheet.name} has no populated cells.</span>
              </div>
            )
          : (
              <table>
                <caption>{target.name} · {activeSheet.name}</caption>
                <thead>
                  <tr>
                    <th scope="col" aria-label="Row number" />
                    {Array.from({ length: visibleColumns }, (_, column) => (
                      <th scope="col" key={column}>
                        {columnName(activeSheet.startColumn + column)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {activeSheet.rows.map((row) => (
                    <tr key={row.rowNumber}>
                      <th scope="row">{row.rowNumber}</th>
                      {Array.from({ length: visibleColumns }, (_, column) => (
                        <td key={column} title={row.cells[column] ?? undefined}>
                          {row.cells[column] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
      </div>
      {sourceTruncated
        ? (
            <p className="spreadsheet-attachment-limit-note" role="status">
              Showing a truncated preview of a large spreadsheet. Open externally to inspect the full file.
            </p>
          )
        : (truncated || workbook.sheetsTruncated) && (
            <p className="spreadsheet-attachment-limit-note" role="status">
              Preview is bounded for responsiveness. Open externally to inspect the complete workbook.
            </p>
          )}
    </div>
  );
}

export function WorkspaceMediaViewer({
  target,
  compact = false,
  onOpenExternally,
  onMetadata,
}: WorkspaceMediaViewerProps): React.JSX.Element {
  const [loadFailed, setLoadFailed] = useState(false);
  const descriptor = useMemo(
    () => classifyWorkspaceMediaPath(target.relativePath),
    [target.relativePath],
  );
  const descriptorLabel = descriptor?.label ?? target.kind;

  useEffect(() => {
    setLoadFailed(false);
  }, [target.kind, target.url]);

  const markLoadFailed = useCallback(() => setLoadFailed(true), []);

  const handleImageLoadCapture = useCallback((event: SyntheticEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLImageElement)) return;
    const { naturalWidth, naturalHeight } = event.target;
    if (naturalWidth > 0 && naturalHeight > 0) {
      onMetadata?.(`${naturalWidth} × ${naturalHeight}`);
    }
  }, [onMetadata]);

  const handlePdfPageCount = useCallback((count: number) => {
    if (count > 0) {
      onMetadata?.(`${count.toLocaleString(INTERFACE_LOCALE)} ${count === 1 ? "page" : "pages"}`);
    }
  }, [onMetadata]);

  return (
    <div
      className={clsx("workspace-media-viewer", compact && "is-compact")}
      data-media-kind={target.kind}
    >
      {target.kind === "image" ? (
        loadFailed ? (
          <MediaErrorFallback
            title="Image preview unavailable"
            detail="This image could not be loaded in the workspace preview."
            target={target}
            onOpenExternally={onOpenExternally}
          />
        ) : (
          <div
            className="workspace-media-image-stage"
            onLoadCapture={handleImageLoadCapture}
          >
            <ZoomableAttachmentImage
              source={target.url}
              alt={target.name}
              onFailure={markLoadFailed}
            />
          </div>
        )
      ) : target.kind === "video" ? (
        <WorkspaceVideoViewer
          target={target}
          onOpenExternally={onOpenExternally}
          onMetadata={onMetadata}
        />
      ) : target.kind === "audio" ? (
        <WorkspaceAudioViewer
          target={target}
          descriptorLabel={descriptorLabel}
          onOpenExternally={onOpenExternally}
          onMetadata={onMetadata}
        />
      ) : target.kind === "pdf" ? (
        loadFailed ? (
          <MediaErrorFallback
            title="PDF preview unavailable"
            detail="This PDF could not be rendered in the embedded viewer."
            target={target}
            onOpenExternally={onOpenExternally}
          />
        ) : (
          <Suspense
            fallback={(
              <div className="document-attachment-preview-loading" role="status">
                <LoadingMark size={16} aria-hidden="true" />
                <span>Preparing PDF preview…</span>
              </div>
            )}
          >
            <PdfAttachmentPreview
              key={target.url}
              source={target.url}
              title={target.name}
              onFailure={markLoadFailed}
              loadAttachment={loadWorkspacePdf}
              prepareCanvas={prepareWorkspacePdfCanvas}
              onPageCount={handlePdfPageCount}
            />
          </Suspense>
        )
      ) : (
        <WorkspaceSpreadsheetViewer
          target={target}
          onOpenExternally={onOpenExternally}
          onMetadata={onMetadata}
        />
      )}
    </div>
  );
}

export default WorkspaceMediaViewer;
