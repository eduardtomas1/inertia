import * as XLSX from "xlsx";

function endOfCentralDirectory(bytes: Buffer): number {
  for (
    let offset = bytes.length - 22;
    offset >= Math.max(0, bytes.length - 65_557);
    offset -= 1
  ) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("The XLSX fixture has no central directory.");
}

export function validXlsxFixture(): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Name", "Value"],
      ["safe", 1],
    ]),
    "Sheet1",
  );
  return Buffer.from(XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
    compression: true,
  }));
}

export function truncatedXlsxFixture(): Buffer {
  const valid = validXlsxFixture();
  return valid.subarray(0, Math.floor(valid.length / 2));
}

export function overlappingXlsxFixture(): Buffer {
  const bytes = validXlsxFixture();
  const end = endOfCentralDirectory(bytes);
  const first = bytes.readUInt32LE(end + 16);
  const second = first
    + 46
    + bytes.readUInt16LE(first + 28)
    + bytes.readUInt16LE(first + 30)
    + bytes.readUInt16LE(first + 32);
  bytes.writeUInt32LE(bytes.readUInt32LE(first + 42), second + 42);
  return bytes;
}

export function truncatedPdfFixture(): Buffer {
  return Buffer.from(
    "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n"
      + "startxref\n999999\n%%EOF\n",
    "ascii",
  );
}
