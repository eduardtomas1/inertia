import type {
  CellObject,
  WorkSheet,
} from "xlsx";

export interface SpreadsheetWorkbookLimits {
  readonly maxSheets: number;
  readonly maxRowsPerSheet: number;
  readonly maxColumnsPerSheet: number;
  readonly maxCellCharacters: number;
  readonly maxWorkbookCharacters: number;
}

export interface SpreadsheetPreviewRow {
  readonly rowNumber: number;
  readonly cells: readonly string[];
}

export interface SpreadsheetPreviewSheet {
  readonly name: string;
  readonly startColumn: number;
  readonly rows: readonly SpreadsheetPreviewRow[];
  readonly totalRows: number;
  readonly totalColumns: number;
  readonly rowsTruncated: boolean;
  readonly columnsTruncated: boolean;
  readonly contentTruncated: boolean;
}

export interface SpreadsheetPreviewWorkbook {
  readonly sheets: readonly SpreadsheetPreviewSheet[];
  readonly totalSheets: number;
  readonly sheetsTruncated: boolean;
  readonly contentTruncated: boolean;
}

export const SPREADSHEET_PREVIEW_LIMITS: SpreadsheetWorkbookLimits = {
  maxSheets: 16,
  maxRowsPerSheet: 120,
  maxColumnsPerSheet: 48,
  maxCellCharacters: 2_048,
  maxWorkbookCharacters: 512 * 1_024,
};

export const SPREADSHEET_PROVIDER_LIMITS: SpreadsheetWorkbookLimits = {
  maxSheets: 16,
  maxRowsPerSheet: 240,
  maxColumnsPerSheet: 64,
  maxCellCharacters: 2_048,
  maxWorkbookCharacters: 768 * 1_024,
};

let spreadsheetModule: Promise<typeof import("xlsx")> | null = null;

function loadSpreadsheetModule(): Promise<typeof import("xlsx")> {
  spreadsheetModule ??= import("xlsx");
  return spreadsheetModule;
}

const ABSOLUTE_SPREADSHEET_LIMITS: SpreadsheetWorkbookLimits = {
  maxSheets: 32,
  maxRowsPerSheet: 1_000,
  maxColumnsPerSheet: 256,
  maxCellCharacters: 8_192,
  maxWorkbookCharacters: 2 * 1024 * 1024,
};

function positiveLimit(
  value: number,
  name: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid spreadsheet ${name} limit.`);
  }
  return Math.min(value, maximum);
}

function validatedLimits(
  limits: SpreadsheetWorkbookLimits,
): SpreadsheetWorkbookLimits {
  return {
    maxSheets: positiveLimit(
      limits.maxSheets,
      "sheet",
      ABSOLUTE_SPREADSHEET_LIMITS.maxSheets,
    ),
    maxRowsPerSheet: positiveLimit(
      limits.maxRowsPerSheet,
      "row",
      ABSOLUTE_SPREADSHEET_LIMITS.maxRowsPerSheet,
    ),
    maxColumnsPerSheet: positiveLimit(
      limits.maxColumnsPerSheet,
      "column",
      ABSOLUTE_SPREADSHEET_LIMITS.maxColumnsPerSheet,
    ),
    maxCellCharacters: positiveLimit(
      limits.maxCellCharacters,
      "cell",
      ABSOLUTE_SPREADSHEET_LIMITS.maxCellCharacters,
    ),
    maxWorkbookCharacters: positiveLimit(
      limits.maxWorkbookCharacters,
      "workbook text",
      ABSOLUTE_SPREADSHEET_LIMITS.maxWorkbookCharacters,
    ),
  };
}

function safeSheetName(value: string): string {
  const normalized = value.normalize("NFC")
    .replace(/[\0-\x1f\x7f]/gu, " ")
    .trim();
  if (!normalized) return "Untitled sheet";
  return normalized.length <= 128
    ? normalized
    : `${normalized.slice(0, 127)}…`;
}

function safeCellText(
  value: string,
  maximum: number,
): { value: string; truncated: boolean } {
  const normalized = value
    .replace(/\r\n?/gu, "\n")
    .replace(/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, "�")
    .replace(/\n/gu, " ↵ ");
  if (normalized.length <= maximum) {
    return { value: normalized, truncated: false };
  }
  return {
    value: `${normalized.slice(0, Math.max(0, maximum - 1))}…`,
    truncated: true,
  };
}

function cellAt(
  sheet: WorkSheet,
  row: number,
  column: number,
  encodeCell: (cell: { r: number; c: number }) => string,
): CellObject | undefined {
  const dense = sheet["!data"];
  if (Array.isArray(dense)) return dense[row]?.[column];
  const candidate = sheet[encodeCell({ r: row, c: column })];
  return typeof candidate === "object" && candidate !== null
    ? candidate as CellObject
    : undefined;
}

function formattedCell(
  cell: CellObject | undefined,
  formatCell: (cell: CellObject) => string,
): string {
  if (!cell) return "";
  try {
    return formatCell(cell);
  } catch {
    const value = cell.v;
    return value instanceof Date
      ? value.toISOString()
      : value === undefined
        ? ""
        : String(value);
  }
}

function safeRangeExtent(start: number, end: number): number {
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end)
    || start < 0
    || end < start
  ) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, end - start + 1);
}

export async function readSpreadsheetWorkbook(
  bytes: Uint8Array,
  requestedLimits: SpreadsheetWorkbookLimits = SPREADSHEET_PREVIEW_LIMITS,
): Promise<SpreadsheetPreviewWorkbook> {
  if (bytes.byteLength < 1) throw new Error("The spreadsheet is empty.");
  const limits = validatedLimits(requestedLimits);
  const spreadsheet = await loadSpreadsheetModule();
  const workbook = spreadsheet.read(bytes, {
    type: "array",
    dense: true,
    sheetRows: limits.maxRowsPerSheet + 1,
    cellDates: true,
    cellFormula: false,
    cellHTML: false,
    cellNF: false,
    cellStyles: false,
    bookVBA: false,
    WTF: false,
  });
  if (!Array.isArray(workbook.SheetNames) || workbook.SheetNames.length === 0) {
    throw new Error("The spreadsheet has no worksheets.");
  }

  let remainingCharacters = limits.maxWorkbookCharacters;
  let workbookContentTruncated = false;
  const selectedNames = workbook.SheetNames.slice(0, limits.maxSheets);
  const sheets = selectedNames.map((rawName): SpreadsheetPreviewSheet => {
    const sheet = workbook.Sheets[rawName];
    if (!sheet) throw new Error("A spreadsheet worksheet is unavailable.");
    const parsedRange = typeof sheet["!ref"] === "string"
      ? spreadsheet.utils.decode_range(sheet["!ref"])
      : null;
    const fullRangeValue = sheet["!fullref"];
    const fullRange = typeof fullRangeValue === "string"
      ? spreadsheet.utils.decode_range(fullRangeValue)
      : parsedRange;
    const startRow = parsedRange?.s.r ?? 0;
    const startColumn = parsedRange?.s.c ?? 0;
    const parsedRows = parsedRange
      ? safeRangeExtent(startRow, parsedRange.e.r)
      : 0;
    const parsedColumns = parsedRange
      ? safeRangeExtent(startColumn, parsedRange.e.c)
      : 0;
    const totalRows = fullRange
      ? safeRangeExtent(fullRange.s.r, fullRange.e.r)
      : parsedRows;
    const totalColumns = fullRange
      ? safeRangeExtent(fullRange.s.c, fullRange.e.c)
      : parsedColumns;
    const visibleRows = Math.min(parsedRows, limits.maxRowsPerSheet);
    const visibleColumns = Math.min(parsedColumns, limits.maxColumnsPerSheet);
    let contentTruncated = false;
    const rows: SpreadsheetPreviewRow[] = [];

    for (let rowOffset = 0; rowOffset < visibleRows; rowOffset += 1) {
      const rowNumber = startRow + rowOffset;
      const cells: string[] = [];
      for (
        let columnOffset = 0;
        columnOffset < visibleColumns;
        columnOffset += 1
      ) {
        const cell = cellAt(
          sheet,
          rowNumber,
          startColumn + columnOffset,
          spreadsheet.utils.encode_cell,
        );
        const bounded = safeCellText(
          formattedCell(cell, spreadsheet.utils.format_cell),
          limits.maxCellCharacters,
        );
        let value = bounded.value;
        if (value.length > remainingCharacters) {
          value = remainingCharacters > 1
            ? `${value.slice(0, remainingCharacters - 1)}…`
            : "";
          contentTruncated = true;
          workbookContentTruncated = true;
        }
        remainingCharacters = Math.max(0, remainingCharacters - value.length);
        if (bounded.truncated) {
          contentTruncated = true;
          workbookContentTruncated = true;
        }
        cells.push(value);
        if (remainingCharacters === 0) break;
      }
      rows.push({ rowNumber: rowNumber + 1, cells });
      if (remainingCharacters === 0) break;
    }
    const rowsTruncated = totalRows > rows.length;
    const columnsTruncated = totalColumns > visibleColumns;
    if (rowsTruncated || columnsTruncated) workbookContentTruncated = true;
    return {
      name: safeSheetName(rawName),
      startColumn,
      rows,
      totalRows,
      totalColumns,
      rowsTruncated,
      columnsTruncated,
      contentTruncated,
    };
  });
  const sheetsTruncated = workbook.SheetNames.length > sheets.length;
  return {
    sheets,
    totalSheets: workbook.SheetNames.length,
    sheetsTruncated,
    contentTruncated: workbookContentTruncated || sheetsTruncated,
  };
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

function contextCell(value: string): string {
  return value.replace(/\t/gu, " ").trimEnd();
}

export function spreadsheetWorkbookToText(
  workbook: SpreadsheetPreviewWorkbook,
): string {
  const sections = workbook.sheets.map((sheet) => {
    const headings = Array.from(
      { length: Math.max(0, ...sheet.rows.map(({ cells }) => cells.length)) },
      (_, index) => columnName(sheet.startColumn + index),
    );
    const lines = [
      `[Worksheet: ${sheet.name}]`,
      ["Row", ...headings].join("\t"),
      ...sheet.rows.map(({ rowNumber, cells }) => [
        String(rowNumber),
        ...cells.map(contextCell),
      ].join("\t")),
    ];
    if (
      sheet.rowsTruncated
      || sheet.columnsTruncated
      || sheet.contentTruncated
    ) lines.push("[Worksheet preview truncated by the attachment safety limits]");
    return lines.join("\n");
  });
  if (workbook.sheetsTruncated) {
    sections.push(
      `[Workbook contains ${workbook.totalSheets.toLocaleString("en-US")} worksheets; only the first ${workbook.sheets.length.toLocaleString("en-US")} were extracted]`,
    );
  }
  return sections.join("\n\n");
}
