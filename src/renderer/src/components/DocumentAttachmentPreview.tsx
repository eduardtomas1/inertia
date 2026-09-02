import {
  ExternalLink,
  FileSpreadsheet,
  FileText,
  LoaderCircle,
  X,
} from "lucide-react";
import {
  lazy,
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFPageProxy } from "pdfjs-dist";

import {
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
  chatAttachmentTypeLabel,
  isSpreadsheetAttachmentMimeType,
  type ChatAttachmentMimeType,
} from "@shared/attachments";
import type { ChatAttachment } from "@shared/contracts";
import {
  SPREADSHEET_PREVIEW_LIMITS,
  readSpreadsheetWorkbook,
  type SpreadsheetPreviewWorkbook,
} from "@shared/spreadsheet-workbook";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { useDocumentVisibility } from "../hooks/useDocumentPresence";
import {
  attachmentPreviewKind,
  attachmentPreviewUrl,
  formatAttachmentSize,
} from "../utils/composerAttachments";
import {
  focusModalOnAnimationFrame,
  trapModalFocus,
} from "../utils/modalFocus";
import { pdfCanvasLayout } from "../utils/pdfCanvasLayout";

export { pdfCanvasLayout };

export async function loadPdfAttachment(source: string) {
  const [{ getDocument, GlobalWorkerOptions }, response] = await Promise.all([
    import("pdfjs-dist"),
    fetch(source, { cache: "no-store", credentials: "omit" }),
  ]);
  if (!response.ok) throw new Error("The PDF preview is unavailable.");
  GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    getDocument,
  };
}

export function preparePdfCanvas(
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

const PdfAttachmentPreview = lazy(async () => ({
  default: (await import("./PdfAttachmentPreview")).PdfAttachmentPreview,
}));

type DocumentAttachmentPreviewProps = {
  source: string;
  title: string;
  mimeType: ChatAttachmentMimeType;
  onFailure: () => void;
};

type PreviewContent =
  | { readonly kind: "spreadsheet"; readonly workbook: SpreadsheetPreviewWorkbook }
  | { readonly kind: "text"; readonly text: string };

function isSpreadsheetPreview(mimeType: ChatAttachmentMimeType): boolean {
  return mimeType === "text/csv"
    || isSpreadsheetAttachmentMimeType(mimeType);
}

function boundedPrettyJson(text: string): string {
  try {
    const formatted = JSON.stringify(JSON.parse(text), null, 2);
    return formatted.length <= MAX_TEXT_ATTACHMENT_BYTES
      ? formatted
      : `${formatted.slice(0, MAX_TEXT_ATTACHMENT_BYTES - 1)}…`;
  } catch {
    return text;
  }
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

function SpreadsheetPreview({
  title,
  workbook,
}: {
  title: string;
  workbook: SpreadsheetPreviewWorkbook;
}): React.JSX.Element {
  const [activeIndex, setActiveIndex] = useState(0);
  const activeSheet = workbook.sheets[activeIndex] ?? workbook.sheets[0];
  const visibleColumns = useMemo(() => activeSheet
    ? Math.max(0, ...activeSheet.rows.map(({ cells }) => cells.length))
    : 0, [activeSheet]);

  useEffect(() => {
    if (activeIndex >= workbook.sheets.length) setActiveIndex(0);
  }, [activeIndex, workbook.sheets.length]);

  if (!activeSheet) {
    return (
      <div className="spreadsheet-attachment-empty">
        <strong>No readable worksheets</strong>
        <span>The workbook is attached, but it has no previewable cells.</span>
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
          {activeSheet.totalRows.toLocaleString()} rows
          {" · "}
          {activeSheet.totalColumns.toLocaleString()} columns
          {workbook.totalSheets > 1
            ? ` · ${workbook.totalSheets.toLocaleString()} sheets`
            : ""}
        </span>
      </div>
      <div
        className="spreadsheet-attachment-table-wrap"
        data-preview-truncated={truncated || workbook.sheetsTruncated}
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
                <caption>{title} · {activeSheet.name}</caption>
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
      {(truncated || workbook.sheetsTruncated) && (
        <p className="spreadsheet-attachment-limit-note">
          Preview is bounded for responsiveness. The original workbook remains attached.
        </p>
      )}
    </div>
  );
}

export function DocumentAttachmentPreview({
  source,
  title,
  mimeType,
  onFailure,
}: DocumentAttachmentPreviewProps): React.JSX.Element {
  const [content, setContent] = useState<PreviewContent | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setContent(null);
    void fetch(source, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error("Attachment preview is unavailable.");
      const responseMimeType = response.headers.get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLocaleLowerCase("en-US");
      if (responseMimeType !== mimeType) {
        throw new Error("Attachment preview type does not match the attachment.");
      }
      const maximumBytes = isSpreadsheetPreview(mimeType)
        ? MAX_CHAT_ATTACHMENT_BYTES
        : MAX_TEXT_ATTACHMENT_BYTES;
      const contentLength = response.headers.get("content-length");
      const declaredBytes = contentLength === null ? null : Number(contentLength);
      if (
        declaredBytes !== null
        && (
          !Number.isSafeInteger(declaredBytes)
          || declaredBytes < 1
          || declaredBytes > maximumBytes
        )
      ) throw new Error("Attachment preview exceeds the safe size limit.");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes) {
        throw new Error("Attachment preview exceeds the safe size limit.");
      }
      const next: PreviewContent = isSpreadsheetPreview(mimeType)
        ? {
            kind: "spreadsheet",
            workbook: await readSpreadsheetWorkbook(
              bytes,
              SPREADSHEET_PREVIEW_LIMITS,
            ),
          }
        : {
            kind: "text",
            text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          };
      if (controller.signal.aborted) return;
      startTransition(() => setContent(next.kind === "text" && mimeType === "application/json"
        ? { kind: "text", text: boundedPrettyJson(next.text) }
        : next));
    }).catch((error: unknown) => {
      if (
        controller.signal.aborted
        || (error instanceof DOMException && error.name === "AbortError")
      ) return;
      onFailure();
    });
    return () => controller.abort();
  }, [mimeType, onFailure, source]);

  if (!content) {
    return (
      <div className="document-attachment-preview-loading" role="status">
        <LoaderCircle size={18} aria-hidden="true" />
        <span>Preparing secure preview…</span>
      </div>
    );
  }
  return content.kind === "spreadsheet"
    ? <SpreadsheetPreview title={title} workbook={content.workbook} />
    : (
        <pre
          className="text-attachment-preview"
          tabIndex={0}
          aria-label={`Text preview of ${title}`}
        >
          {content.text}
        </pre>
      );
}

type AttachmentPreviewDialogProps = {
  attachment: ChatAttachment;
  onClose: () => void;
};

export function AttachmentPreviewDialog({
  attachment,
  onClose,
}: AttachmentPreviewDialogProps): React.JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const previewKind = attachmentPreviewKind(attachment);
  const previewUrl = attachmentPreviewUrl(attachment);
  const documentVisible = useDocumentVisibility();
  const markLoadFailed = useCallback(() => setLoadFailed(true), []);
  useNativePreviewSuspension(true);

  useEffect(() => {
    const restoreFocus = focusModalOnAnimationFrame(
      () => closeRef.current?.focus(),
    );
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("keydown", closeOnEscape, true);
      restoreFocus();
    };
  }, [onClose]);

  return createPortal(
    <div
      className="attachment-preview-backdrop"
      data-document-visible={documentVisible}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="attachment-preview-dialog"
        data-preview-kind={previewKind}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={(event) => trapModalFocus(event, event.currentTarget)}
      >
        <header className="attachment-preview-header">
          <span className="attachment-preview-identity">
            {previewKind === "spreadsheet"
              ? <FileSpreadsheet size={16} aria-hidden="true" />
              : previewKind !== "image"
                ? <FileText size={16} aria-hidden="true" />
                : null}
            <span>
              <strong id={titleId}>{attachment.name}</strong>
              <small id={descriptionId}>
                {chatAttachmentTypeLabel(attachment.mimeType)}
                {" · "}
                {formatAttachmentSize(attachment.size)}
              </small>
            </span>
          </span>
          <button
            ref={closeRef}
            type="button"
            className="attachment-preview-close"
            aria-label={`Close preview of ${attachment.name}`}
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="attachment-preview-stage" data-load-failed={loadFailed}>
          {loadFailed
            ? (
                <div className="attachment-preview-unavailable" role="alert">
                  <FileText size={28} aria-hidden="true" />
                  <strong>Preview unavailable</strong>
                  <span>
                    The secure preview could not be displayed. Re-add the file
                    if it changed after upload.
                  </span>
                </div>
              )
            : previewKind === "image"
              ? (
                  <img
                    src={previewUrl}
                    alt={attachment.name}
                    onError={markLoadFailed}
                  />
                )
              : previewKind === "pdf"
                ? (
                    <Suspense fallback={(
                      <div className="document-attachment-preview-loading" role="status">
                        <span>Preparing secure preview…</span>
                      </div>
                    )}>
                      <PdfAttachmentPreview
                        source={previewUrl}
                        title={attachment.name}
                        onFailure={markLoadFailed}
                        loadAttachment={loadPdfAttachment}
                        prepareCanvas={preparePdfCanvas}
                      />
                    </Suspense>
                  )
                : (
                    <DocumentAttachmentPreview
                      source={previewUrl}
                      title={attachment.name}
                      mimeType={attachment.mimeType}
                      onFailure={markLoadFailed}
                    />
                  )}
        </div>
        {previewKind === "pdf" && (
          <footer className="attachment-preview-footer">
            <span>
              If the embedded viewer is unavailable, open this validated copy
              in your default PDF app.
            </span>
            <button
              type="button"
              className="secondary-button"
              disabled={opening}
              onClick={() => {
                if (opening) return;
                setOpenFailed(false);
                setOpening(true);
                void window.inertia.openAttachmentExternally(attachment.id)
                  .catch(() => setOpenFailed(true))
                  .finally(() => setOpening(false));
              }}
            >
              <ExternalLink size={14} aria-hidden="true" />
              <span>{opening ? "Opening…" : "Open in PDF app"}</span>
            </button>
            {openFailed && (
              <span className="attachment-preview-open-error" role="alert">
                The validated copy could not be opened.
              </span>
            )}
          </footer>
        )}
      </section>
    </div>,
    document.body,
  );
}
