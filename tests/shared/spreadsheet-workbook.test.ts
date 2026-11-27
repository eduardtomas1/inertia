import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import {
  readDelimitedSpreadsheetWorkbook,
  readSpreadsheetWorkbook,
  spreadsheetWorkbookToText,
  type SpreadsheetWorkbookLimits,
} from "../../src/shared/spreadsheet-workbook";

function workbookBytes(
  sheets: readonly { name: string; rows: readonly (readonly unknown[])[] }[],
  bookType: "xlsx" | "xls" = "xlsx",
): Uint8Array {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(sheet.rows as unknown[][]),
      sheet.name,
    );
  }
  return XLSX.write(workbook, { type: "buffer", bookType }) as Uint8Array;
}

const smallLimits: SpreadsheetWorkbookLimits = {
  maxSheets: 2,
  maxRowsPerSheet: 2,
  maxColumnsPerSheet: 2,
  maxCellCharacters: 12,
  maxWorkbookCharacters: 1_024,
};

describe("bounded spreadsheet workbook projection", () => {
  it.each(["xlsx", "xls"] as const)(
    "reads formatted cells from a verified %s workbook without evaluating formulas",
    async (bookType) => {
      const workbook = XLSX.utils.book_new();
      const sheet = XLSX.utils.aoa_to_sheet([
        ["Name", "Value"],
        ["Alpha", 42],
        ["Cached formula", { f: "B2*2", v: 84 }],
      ]);
      XLSX.utils.book_append_sheet(workbook, sheet, "Overview");
      const bytes = XLSX.write(workbook, {
        type: "buffer",
        bookType,
      }) as Uint8Array;

      const parsed = await readSpreadsheetWorkbook(bytes, {
        ...smallLimits,
        maxRowsPerSheet: 4,
      });

      expect(parsed.sheets[0]).toMatchObject({
        name: "Overview",
        totalColumns: 2,
        rowsTruncated: false,
      });
      expect(parsed.sheets[0]?.rows[1]?.cells).toEqual(["Alpha", "42"]);
      expect(parsed.sheets[0]?.rows[2]?.cells.join(" ")).not.toContain("B2*2");
    },
  );

  it("caps sheets, rows, columns, cells, and workbook output explicitly", async () => {
    const bytes = workbookBytes([
      {
        name: "Primary",
        rows: [
          ["very long heading", "B", "C"],
          ["row two", 2, 3],
          ["row three", 4, 5],
        ],
      },
      { name: "Secondary", rows: [["safe"]] },
      { name: "Hidden by bound", rows: [["not projected"]] },
    ]);

    const parsed = await readSpreadsheetWorkbook(bytes, smallLimits);

    expect(parsed).toMatchObject({
      totalSheets: 3,
      sheetsTruncated: true,
      contentTruncated: true,
    });
    expect(parsed.sheets).toHaveLength(2);
    expect(parsed.sheets[0]).toMatchObject({
      totalRows: 3,
      totalColumns: 3,
      rowsTruncated: true,
      columnsTruncated: true,
      contentTruncated: true,
    });
    expect(parsed.sheets[0]?.rows).toHaveLength(2);
    expect(parsed.sheets[0]?.rows[0]?.cells[0]).toBe("very long h…");
  });

  it("renders provider context with worksheet and coordinate provenance", async () => {
    const parsed = await readSpreadsheetWorkbook(workbookBytes([{
      name: "Quarter 1",
      rows: [["Region", "Revenue"], ["North", 1200]],
    }]), smallLimits);

    const context = spreadsheetWorkbookToText(parsed);

    expect(context).toContain("[Worksheet: Quarter 1]");
    expect(context).toContain("Row\tA\tB");
    expect(context).toContain("2\tNorth\t1200");
  });

  it("rejects malformed bytes instead of manufacturing an empty preview", async () => {
    await expect(readSpreadsheetWorkbook(
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
      smallLimits,
    )).rejects.toThrow();
  });

  it("respects explicit tab fieldSeparator for TSV with commas and marks truncated text row counts inexact", async () => {
    const tsv = [
      "Name\tTags",
      "Alpha\ta,b,c,d",
      "Beta\te,f,g,h",
      "Gamma\ti,j,k,l",
    ].join("\n");
    const parsed = await readSpreadsheetWorkbook(
      new TextEncoder().encode(`\uFEFF${tsv}`),
      smallLimits,
      { fieldSeparator: "\t" },
    );

    expect(parsed.sheets[0]).toMatchObject({
      totalColumns: 2,
      rowsTruncated: true,
      totalRowsExact: false,
    });
    expect(parsed.sheets[0]?.rows[1]?.cells).toEqual(["Alpha", "a,b,c,d"]);
  });

  it("bounds single-row high-column CSV during tokenization and preserves quoted newlines and quotes", () => {
    const hugeRow = `"a""b,c\nd",${"x,".repeat(500_000)}tail`;
    const parsed = readDelimitedSpreadsheetWorkbook(hugeRow, ",", smallLimits);

    expect(parsed.sheets[0]).toMatchObject({
      totalColumns: 500_002,
      columnsTruncated: true,
      rowsTruncated: false,
      totalRowsExact: true,
    });
    expect(parsed.sheets[0]?.rows).toHaveLength(1);
    expect(parsed.sheets[0]?.rows[0]?.cells).toEqual(['a"b,c ↵ d', "x"]);
  });

  it("auto-detects semicolon CSVs, honors sep= directives, and drops cut-off trailing rows when sourceTruncated", () => {
    const semi = readDelimitedSpreadsheetWorkbook("Name;Age\nAda;42\n", "auto", smallLimits);
    expect(semi.sheets[0]?.rows.map((row) => row.cells)).toEqual([
      ["Name", "Age"],
      ["Ada", "42"],
    ]);

    // Semicolon CSV with decimal commas (e.g. European locale) detects semicolon via consistent column counts
    const euroDecimal = readDelimitedSpreadsheetWorkbook(
      "Net;Gross\n1,25;2,50\n3,75;4,00\n",
      "auto",
      { ...smallLimits, maxRowsPerSheet: 10 },
    );
    expect(euroDecimal.sheets[0]?.rows.map((row) => row.cells)).toEqual([
      ["Net", "Gross"],
      ["1,25", "2,50"],
      ["3,75", "4,00"],
    ]);

    // Truncated semicolon CSV whose cut-off trailing record contains commas still picks semicolon
    const truncatedSemi = readDelimitedSpreadsheetWorkbook(
      'Net;Note\n1,25;ok\n"2,50,a,b,c\npartial',
      "auto",
      { ...smallLimits, maxRowsPerSheet: 10 },
      { sourceTruncated: true },
    );
    expect(truncatedSemi.sheets[0]?.rows.map((row) => row.cells)).toEqual([
      ["Net", "Note"],
      ["1,25", "ok"],
    ]);

    const sepDirective = readDelimitedSpreadsheetWorkbook("sep=;\nName;Age\nAda;42\n", "auto", smallLimits);
    expect(sepDirective.sheets[0]?.rows.map((row) => row.cells)).toEqual([
      ["Name", "Age"],
      ["Ada", "42"],
    ]);

    const truncated = readDelimitedSpreadsheetWorkbook(
      "Name,City\nAda,Tokyo\nBob,Par",
      "auto",
      { ...smallLimits, maxRowsPerSheet: 10 },
      { sourceTruncated: true },
    );
    expect(truncated.sheets[0]).toMatchObject({
      rowsTruncated: true,
      totalRowsExact: false,
    });
    expect(truncated.sheets[0]?.rows.map((row) => row.cells)).toEqual([
      ["Name", "City"],
      ["Ada", "Tokyo"],
    ]);

    // Quoted semicolon CSV containing commas inside quoted values picks semicolon via quote-violation penalty
    const quotedSemi = readDelimitedSpreadsheetWorkbook(
      '"Net";"Amount, EUR"\n"Gross";"Total, EUR"\n',
      "auto",
      { ...smallLimits, maxRowsPerSheet: 10, maxColumnsPerSheet: 10 },
    );
    expect(quotedSemi.sheets[0]?.rows.map((row) => row.cells)).toEqual([
      ["Net", "Amount, EUR"],
      ["Gross", "Total, EUR"],
    ]);

    // Mixed unquoted + quoted semicolon CSV with internal commas picks semicolon via mid-field quote violation
    const mixedSemi = readDelimitedSpreadsheetWorkbook(
      'Region;"City, State, Country";Notes\nWest;"Portland, Oregon, US";OK\n',
      "auto",
      { ...smallLimits, maxRowsPerSheet: 10, maxColumnsPerSheet: 10, maxCellCharacters: 64 },
    );
    expect(mixedSemi.sheets[0]?.rows.map((row) => row.cells)).toEqual([
      ["Region", "City, State, Country", "Notes"],
      ["West", "Portland, Oregon, US", "OK"],
    ]);

    // Ragged semicolon CSV prefers quote-clean semicolon over consistent-but-invalid comma
    const raggedSemi = readDelimitedSpreadsheetWorkbook(
      'Region;"City, State, Country";Notes\nWest;"Portland, Oregon, US"\n',
      "auto",
      { ...smallLimits, maxRowsPerSheet: 10, maxColumnsPerSheet: 10, maxCellCharacters: 64 },
    );
    expect(raggedSemi.sheets[0]?.rows.map((row) => row.cells)).toEqual([
      ["Region", "City, State, Country", "Notes"],
      ["West", "Portland, Oregon, US"],
    ]);

    // Semicolon CSV whose first record exceeds the 16 KiB detection sample still detects semicolon
    const longFirstRowSemi = `Name;${"x".repeat(20_000)}\nAda;42\n`;
    const parsedLongSemi = readDelimitedSpreadsheetWorkbook(
      longFirstRowSemi,
      "auto",
      { ...smallLimits, maxRowsPerSheet: 10, maxColumnsPerSheet: 10 },
    );
    expect(parsedLongSemi.sheets[0]?.rows[1]?.cells).toEqual(["Ada", "42"]);

    // Discarded cut-off trailing row does not inflate totalColumns or columnsTruncated
    const wideCutOff = readDelimitedSpreadsheetWorkbook(
      "A,B\n1,2\npartial,a,b,c,",
      "auto",
      { ...smallLimits, maxRowsPerSheet: 10, maxColumnsPerSheet: 2 },
      { sourceTruncated: true },
    );
    expect(wideCutOff.sheets[0]).toMatchObject({
      totalColumns: 2,
      columnsTruncated: false,
      rowsTruncated: true,
      totalRowsExact: false,
    });
  });
});
