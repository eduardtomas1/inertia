import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import {
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
});
