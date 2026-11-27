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
  readonly totalRowsExact: boolean;
  readonly totalColumns: number;
  readonly rowsTruncated: boolean;
  readonly columnsTruncated: boolean;
  readonly contentTruncated: boolean;
}

export interface ReadSpreadsheetWorkbookOptions {
  readonly fieldSeparator?: string;
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

export interface ReadDelimitedSpreadsheetOptions {
  readonly sourceTruncated?: boolean;
  readonly sheetName?: string;
}

const DELIMITED_DETECTION_SAMPLE_CHARS = 16_384;
const DELIMITED_DETECTION_MAX_LINES = 8;

function sampleDelimiterColumnCounts(
  sample: string,
  delimiter: "," | ";",
  sourceTruncated: boolean,
): { readonly counts: readonly number[]; readonly quoteViolations: number } {
  const counts: number[] = [];
  let quoteViolations = 0;
  let rowQuoteViolations = 0;
  let columns = 1;
  let inQuotes = false;
  let justClosedQuote = false;
  let atFieldStart = true;
  let rowHasContent = false;
  for (let index = 0; index < sample.length; index += 1) {
    const ch = sample[index]!;
    if (inQuotes) {
      if (ch === "\"") {
        if (index + 1 < sample.length && sample[index + 1] === "\"") {
          index += 1;
        } else {
          inQuotes = false;
          justClosedQuote = true;
        }
      }
      continue;
    }
    if (atFieldStart && ch === "\"") {
      inQuotes = true;
      atFieldStart = false;
      rowHasContent = true;
      continue;
    }
    if (ch === delimiter) {
      columns += 1;
      justClosedQuote = false;
      atFieldStart = true;
      rowHasContent = true;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && index + 1 < sample.length && sample[index + 1] === "\n") {
        index += 1;
      }
      if (rowHasContent) {
        counts.push(columns);
        quoteViolations += rowQuoteViolations;
        if (counts.length >= DELIMITED_DETECTION_MAX_LINES) break;
      }
      columns = 1;
      rowQuoteViolations = 0;
      justClosedQuote = false;
      atFieldStart = true;
      rowHasContent = false;
      continue;
    }
    if (justClosedQuote && ch !== " " && ch !== "\t") {
      rowQuoteViolations += 1;
      justClosedQuote = false;
    } else if (!atFieldStart && ch === "\"") {
      rowQuoteViolations += 1;
    }
    atFieldStart = false;
    rowHasContent = true;
  }
  if (
    rowHasContent
    && counts.length < DELIMITED_DETECTION_MAX_LINES
    && ((!sourceTruncated && !inQuotes) || counts.length === 0)
  ) {
    counts.push(columns);
    quoteViolations += rowQuoteViolations;
  }
  return { counts, quoteViolations };
}

function detectCsvDelimiterAndBody(
  text: string,
  sourceTruncated: boolean,
): { readonly delimiter: "," | ";" | "\t" | "|"; readonly body: string } {
  const sepMatch = /^sep=(,|;|\t|\|)(?:\r\n|\r|\n|$)/iu.exec(text);
  if (sepMatch) {
    const sep = sepMatch[1] as "," | ";" | "\t" | "|";
    return { delimiter: sep, body: text.slice(sepMatch[0].length) };
  }
  const sample = text.slice(0, DELIMITED_DETECTION_SAMPLE_CHARS);
  const sampleTruncated = sourceTruncated || text.length > DELIMITED_DETECTION_SAMPLE_CHARS;
  const comma = sampleDelimiterColumnCounts(sample, ",", sampleTruncated);
  const semi = sampleDelimiterColumnCounts(sample, ";", sampleTruncated);
  const isConsistent = (counts: readonly number[]): boolean => (
    counts.length > 0 && counts[0]! >= 2 && counts.every((count) => count === counts[0])
  );
  const commaClean = comma.quoteViolations === 0;
  const semiClean = semi.quoteViolations === 0;
  const commaMultiRows = comma.counts.filter((count) => count >= 2).length;
  const semiMultiRows = semi.counts.filter((count) => count >= 2).length;
  const commaCleanMulti = commaClean && commaMultiRows > 0;
  const semiCleanMulti = semiClean && semiMultiRows > 0;
  if (semiCleanMulti && !commaCleanMulti) return { delimiter: ";", body: text };
  if (commaCleanMulti && !semiCleanMulti) return { delimiter: ",", body: text };
  const commaConsistent = isConsistent(comma.counts);
  const semiConsistent = isConsistent(semi.counts);
  if (semiConsistent && !commaConsistent) return { delimiter: ";", body: text };
  if (commaConsistent && !semiConsistent) return { delimiter: ",", body: text };
  if (semiConsistent && commaConsistent) {
    if (semi.quoteViolations !== comma.quoteViolations) {
      return { delimiter: semi.quoteViolations < comma.quoteViolations ? ";" : ",", body: text };
    }
    return {
      delimiter: semi.counts[0]! > comma.counts[0]! ? ";" : ",",
      body: text,
    };
  }
  if (semiMultiRows > commaMultiRows) return { delimiter: ";", body: text };
  if (commaMultiRows > semiMultiRows) return { delimiter: ",", body: text };
  if (semiMultiRows > 0 && semi.quoteViolations !== comma.quoteViolations) {
    return { delimiter: semi.quoteViolations < comma.quoteViolations ? ";" : ",", body: text };
  }
  const semiExtra = semi.counts.reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const commaExtra = comma.counts.reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  return { delimiter: semiExtra > commaExtra ? ";" : ",", body: text };
}

export function readDelimitedSpreadsheetWorkbook(
  rawText: string,
  requestedDelimiter: "," | ";" | "\t" | "|" | "auto",
  requestedLimits: SpreadsheetWorkbookLimits = SPREADSHEET_PREVIEW_LIMITS,
  sheetNameOrOptions?: string | ReadDelimitedSpreadsheetOptions,
): SpreadsheetPreviewWorkbook {
  const limits = validatedLimits(requestedLimits);
  const options: ReadDelimitedSpreadsheetOptions = typeof sheetNameOrOptions === "string"
    ? { sheetName: sheetNameOrOptions }
    : (sheetNameOrOptions ?? {});
  const sheetName = options.sheetName ?? "Sheet1";
  const sourceTruncated = Boolean(options.sourceTruncated);
  const withoutBom = rawText.startsWith("\uFEFF") ? rawText.slice(1) : rawText;
  const { delimiter, body: text } = requestedDelimiter === "auto"
    ? detectCsvDelimiterAndBody(withoutBom, sourceTruncated)
    : { delimiter: requestedDelimiter, body: withoutBom };
  const rows: SpreadsheetPreviewRow[] = [];
  let remainingCharacters = limits.maxWorkbookCharacters;
  let rowsTruncated = sourceTruncated;
  let columnsTruncated = false;
  let contentTruncated = false;
  let totalColumns = 0;

  let index = 0;
  const length = text.length;
  let rowIndex = 0;
  let currentCells: string[] = [];
  let columnIndex = 0;
  let rowColumnsTruncated = false;
  let rowContentTruncated = false;
  let rowRemainingCharacters = remainingCharacters;
  let cellChars = "";
  let cellTruncated = false;
  let inQuotes = false;
  let atFieldStart = true;
  let rowHasData = false;

  const commitCell = (): void => {
    if (columnIndex < limits.maxColumnsPerSheet) {
      const bounded = safeCellText(cellChars, limits.maxCellCharacters);
      let value = bounded.value;
      if (cellTruncated || bounded.truncated) {
        rowContentTruncated = true;
      }
      if (value.length > rowRemainingCharacters) {
        value = rowRemainingCharacters > 1
          ? `${value.slice(0, rowRemainingCharacters - 1)}…`
          : "";
        rowContentTruncated = true;
      }
      rowRemainingCharacters = Math.max(0, rowRemainingCharacters - value.length);
      currentCells.push(value);
    } else {
      rowColumnsTruncated = true;
    }
    columnIndex += 1;
    cellChars = "";
    cellTruncated = false;
    atFieldStart = true;
  };

  const commitRow = (): boolean => {
    commitCell();
    totalColumns = Math.max(totalColumns, columnIndex);
    if (rowColumnsTruncated) columnsTruncated = true;
    if (rowContentTruncated) contentTruncated = true;
    remainingCharacters = rowRemainingCharacters;
    rows.push({ rowNumber: rowIndex + 1, cells: currentCells });
    rowIndex += 1;
    currentCells = [];
    columnIndex = 0;
    rowColumnsTruncated = false;
    rowContentTruncated = false;
    rowHasData = false;
    atFieldStart = true;
    if (rowIndex >= limits.maxRowsPerSheet) {
      return false;
    }
    return true;
  };

  let reachedRowLimit = false;
  while (index < length) {
    const ch = text[index]!;
    if (inQuotes) {
      if (ch === "\"") {
        if (index + 1 < length && text[index + 1] === "\"") {
          if (columnIndex < limits.maxColumnsPerSheet && cellChars.length <= limits.maxCellCharacters) {
            cellChars += "\"";
          } else if (columnIndex < limits.maxColumnsPerSheet) {
            cellTruncated = true;
          }
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      if (columnIndex < limits.maxColumnsPerSheet && cellChars.length <= limits.maxCellCharacters) {
        cellChars += ch;
      } else if (columnIndex < limits.maxColumnsPerSheet) {
        cellTruncated = true;
      }
      index += 1;
      continue;
    }

    if (atFieldStart && ch === "\"") {
      inQuotes = true;
      atFieldStart = false;
      rowHasData = true;
      index += 1;
      continue;
    }

    if (ch === delimiter) {
      rowHasData = true;
      commitCell();
      index += 1;
      continue;
    }

    if (ch === "\r" || ch === "\n") {
      const nextIndex = ch === "\r" && index + 1 < length && text[index + 1] === "\n"
        ? index + 2
        : index + 1;
      const canContinue = commitRow();
      index = nextIndex;
      if (!canContinue) {
        reachedRowLimit = true;
        if (index < length) rowsTruncated = true;
        break;
      }
      continue;
    }

    rowHasData = true;
    atFieldStart = false;
    if (columnIndex < limits.maxColumnsPerSheet && cellChars.length <= limits.maxCellCharacters) {
      cellChars += ch;
    } else if (columnIndex < limits.maxColumnsPerSheet) {
      cellTruncated = true;
    }
    index += 1;
  }

  // When the source byte stream was truncated at the transport cap, any trailing
  // unterminated record (or unclosed quoted field) may be cut mid-cell and must
  // be discarded rather than rendered or exported as a partial row.
  if (!reachedRowLimit && !sourceTruncated && (rowHasData || columnIndex > 0 || cellChars.length > 0)) {
    commitRow();
  }

  const totalRows = rowsTruncated ? rows.length + 1 : rows.length;
  const anyTruncated = rowsTruncated || columnsTruncated || contentTruncated;
  return {
    sheets: [{
      name: safeSheetName(sheetName),
      startColumn: 0,
      rows,
      totalRows,
      totalRowsExact: !rowsTruncated,
      totalColumns,
      rowsTruncated,
      columnsTruncated,
      contentTruncated,
    }],
    totalSheets: 1,
    sheetsTruncated: false,
    contentTruncated: anyTruncated,
  };
}

export async function readSpreadsheetWorkbook(
  bytes: Uint8Array,
  requestedLimits: SpreadsheetWorkbookLimits = SPREADSHEET_PREVIEW_LIMITS,
  options?: ReadSpreadsheetWorkbookOptions,
): Promise<SpreadsheetPreviewWorkbook> {
  if (bytes.byteLength < 1) throw new Error("The spreadsheet is empty.");
  if (options?.fieldSeparator === "," || options?.fieldSeparator === "\t") {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return readDelimitedSpreadsheetWorkbook(decoded, options.fieldSeparator, requestedLimits);
  }
  const limits = validatedLimits(requestedLimits);
  const spreadsheet = await loadSpreadsheetModule();
  const workbook = spreadsheet.read(bytes, {
    type: "array",
    dense: true,
    sheetRows: limits.maxRowsPerSheet + 1,
    ...(options?.fieldSeparator ? { FS: options.fieldSeparator } : {}),
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
    const totalRowsExact = typeof fullRangeValue === "string" || !rowsTruncated;
    const columnsTruncated = totalColumns > visibleColumns;
    if (rowsTruncated || columnsTruncated) workbookContentTruncated = true;
    return {
      name: safeSheetName(rawName),
      startColumn,
      rows,
      totalRows,
      totalRowsExact,
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
