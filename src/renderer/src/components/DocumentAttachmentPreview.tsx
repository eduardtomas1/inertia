import { LoaderCircle } from "lucide-react";
import {
  startTransition,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
  isSpreadsheetAttachmentMimeType,
  type ChatAttachmentMimeType,
} from "@shared/attachments";
import {
  SPREADSHEET_PREVIEW_LIMITS,
  readSpreadsheetWorkbook,
  type SpreadsheetPreviewWorkbook,
} from "@shared/spreadsheet-workbook";

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
