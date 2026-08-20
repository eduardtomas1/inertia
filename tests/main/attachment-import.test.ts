import { describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import * as XLSX from "xlsx";

import {
  attachmentPickerConfiguration,
  validateAttachmentImport,
  validateSelectedAttachmentCount,
  validateSelectedAttachmentOpen,
  validateSelectedAttachmentRead,
  validateSelectedAttachmentStats,
  validateAttachmentPickerName,
} from "../../src/main/attachment-import";
import {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES,
  MAX_SPREADSHEET_ATTACHMENT_EXPANDED_BYTES,
} from "../../src/shared/attachments";

function encodedImage(format: "gif" | "jpeg" | "png" | "webp"): Buffer {
  const canvas = createCanvas(1, 1);
  const context = canvas.getContext("2d");
  context.fillStyle = "#2563eb";
  context.fillRect(0, 0, 1, 1);
  if (format === "jpeg") return canvas.encodeSync("jpeg", 90);
  if (format === "webp") return canvas.encodeSync("webp", 90);
  if (format === "gif") return canvas.encodeSync("gif");
  return canvas.encodeSync("png");
}

const png = encodedImage("png");
const jpeg = encodedImage("jpeg");
const gif = encodedImage("gif");
const webp = encodedImage("webp");

function readablePdf(): Buffer {
  const stream = "BT /F1 12 Tf 72 720 Td (Safe attachment) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
      + "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let source = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source, "ascii"));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(source, "ascii");
  source += `xref\n0 ${objects.length + 1}\n`;
  source += "0000000000 65535 f \n";
  source += offsets.map((offset) =>
    `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  source += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(source, "ascii");
}

const pdf = readablePdf();

function xrefStreamPdf(): Buffer {
  let prefix = Buffer.from("%PDF-1.5\n%\xe2\xe3\xcf\xd3\n", "binary");
  const offsets: number[] = [];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
  ];
  for (const [index, object] of objects.entries()) {
    offsets.push(prefix.byteLength);
    prefix = Buffer.concat([
      prefix,
      Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, "ascii"),
    ]);
  }
  const xrefOffset = prefix.byteLength;
  const row = (type: number, field1: number, field2: number): Buffer => {
    const bytes = Buffer.alloc(7);
    bytes.writeUInt8(type, 0);
    bytes.writeUInt32BE(field1, 1);
    bytes.writeUInt16BE(field2, 5);
    return bytes;
  };
  const xref = Buffer.concat([
    row(0, 0, 65_535),
    ...offsets.map((offset) => row(1, offset, 0)),
    row(1, xrefOffset, 0),
  ]);
  return Buffer.concat([
    prefix,
    Buffer.from(
      `4 0 obj\n<< /Type /XRef /Size 5 /Root 1 0 R /W [1 4 2] /Length ${xref.byteLength} >>\nstream\n`,
      "ascii",
    ),
    xref,
    Buffer.from(
      `\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`,
      "ascii",
    ),
  ]);
}

const modernPdf = xrefStreamPdf();

function spreadsheet(bookType: "xlsx" | "xls"): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Name", "Value"],
      ["Alpha", 42],
    ]),
    "Overview",
  );
  return XLSX.write(workbook, {
    type: "buffer",
    bookType,
    compression: bookType === "xlsx",
  }) as Buffer;
}

function xlsxEntryLocation(bytes: Buffer, expectedName: string): {
  centralOffset: number;
  localOffset: number;
  localNameOffset: number;
} {
  const endOffset = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(endOffset).toBeGreaterThanOrEqual(0);
  const totalEntries = bytes.readUInt16LE(endOffset + 10);
  let centralOffset = bytes.readUInt32LE(endOffset + 16);
  for (let index = 0; index < totalEntries; index += 1) {
    expect(bytes.readUInt32LE(centralOffset)).toBe(0x02014b50);
    const nameLength = bytes.readUInt16LE(centralOffset + 28);
    const extraLength = bytes.readUInt16LE(centralOffset + 30);
    const commentLength = bytes.readUInt16LE(centralOffset + 32);
    const name = bytes.subarray(
      centralOffset + 46,
      centralOffset + 46 + nameLength,
    ).toString("utf8");
    if (name === expectedName) {
      const localOffset = bytes.readUInt32LE(centralOffset + 42);
      return {
        centralOffset,
        localOffset,
        localNameOffset: localOffset + 30,
      };
    }
    centralOffset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`Missing test XLSX entry ${expectedName}.`);
}

const xlsx = spreadsheet("xlsx");
const xls = spreadsheet("xls");

describe("privileged attachment import validation", () => {
  it("configures and enforces the image-only follow-up picker in main", () => {
    expect(attachmentPickerConfiguration("images")).toEqual({
      title: "Attach follow-up images",
      filterName: "Images",
      extensions: ["png", "jpg", "jpeg", "webp", "gif"],
    });
    expect(() => validateAttachmentPickerName("images", "reference.webp"))
      .not.toThrow();
    expect(() => validateAttachmentPickerName("images", "notes.pdf"))
      .toThrow("Follow-up attachments must be images.");
    expect(() => validateAttachmentPickerName("all", "notes.pdf"))
      .not.toThrow();
    expect(attachmentPickerConfiguration("all")).toEqual({
      title: "Attach images, documents, or spreadsheets",
      filterName: "Images, documents, and spreadsheets",
      extensions: [
        "png", "jpg", "jpeg", "webp", "gif",
        "pdf", "txt", "md", "markdown", "csv", "json", "xlsx", "xls",
      ],
    });
  });
  it("rejects an oversized selection instead of silently truncating it", () => {
    expect(() => validateSelectedAttachmentCount(MAX_CHAT_ATTACHMENTS + 1))
      .toThrow(`Select at most ${MAX_CHAT_ATTACHMENTS} attachments.`);
    expect(() => validateSelectedAttachmentCount(MAX_CHAT_ATTACHMENTS))
      .not.toThrow();
  });

  it("rejects unsafe or oversized chosen-file stats before selected bytes are read", () => {
    expect(() => validateSelectedAttachmentStats([{
      size: 10,
      isFile: false,
      isSymbolicLink: true,
    }])).toThrow(/safe regular file/u);
    expect(() => validateSelectedAttachmentStats([{
      size: MAX_CHAT_ATTACHMENT_BYTES + 1,
      isFile: true,
      isSymbolicLink: false,
    }])).toThrow(/10 MB file limit/u);
    expect(() => validateSelectedAttachmentStats([
      {
        size: MAX_CHAT_ATTACHMENT_TOTAL_BYTES / 2,
        isFile: true,
        isSymbolicLink: false,
      },
      {
        size: MAX_CHAT_ATTACHMENT_TOTAL_BYTES / 2,
        isFile: true,
        isSymbolicLink: false,
      },
      {
        size: 1,
        isFile: true,
        isSymbolicLink: false,
      },
    ])).toThrow(/20 MB turn limit/u);
    expect(() => validateSelectedAttachmentStats([{
      size: 128,
      isFile: true,
      isSymbolicLink: false,
    }])).not.toThrow();
  });

  it("rejects a regular-file replacement between selection and open", () => {
    const selected = {
      dev: 1n,
      ino: 2n,
      isFile: true,
      isSymbolicLink: false,
    };

    expect(() => validateSelectedAttachmentOpen(selected, {
      ...selected,
      ino: 3n,
    })).toThrow(/changed while it was being opened/u);
    expect(() => validateSelectedAttachmentOpen(selected, selected))
      .not.toThrow();
  });

  it("rejects same-size content changes while a selected file is read", () => {
    const before = {
      dev: 1n,
      ino: 2n,
      size: 128n,
      mtimeNs: 3n,
      ctimeNs: 4n,
      isFile: true,
      isSymbolicLink: false,
    };

    expect(() => validateSelectedAttachmentRead(before, {
      ...before,
      mtimeNs: before.mtimeNs + 1n,
      ctimeNs: before.ctimeNs + 1n,
    })).toThrow(/changed while it was being read/u);
    expect(() => validateSelectedAttachmentRead(before, before)).not.toThrow();
  });

  it.each([
    ["preview.png", "image/png", png],
    ["preview.jpg", "image/jpeg", jpeg],
    ["preview.jpeg", "image/jpeg", jpeg],
    ["preview.gif", "image/gif", gif],
    ["preview.webp", "image/webp", webp],
    ["notes.pdf", "application/pdf", pdf],
    ["modern.pdf", "application/pdf", modernPdf],
    ["notes.txt", "text/plain", Buffer.from("Safe notes\n", "utf8")],
    ["notes.md", "text/markdown", Buffer.from("# Safe notes\n", "utf8")],
    ["notes.markdown", "text/plain", Buffer.from("# Safe notes\n", "utf8")],
    ["rows.csv", "text/csv", Buffer.from("name,value\nsafe,1\n", "utf8")],
    ["data.json", "application/json", Buffer.from('{"safe":true}', "utf8")],
    [
      "forecast.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      xlsx,
    ],
    ["forecast.xls", "application/vnd.ms-excel", xls],
  ])("accepts verified %s content", (name, mimeType, data) => {
    const result = validateAttachmentImport({ name, mimeType, data });

    expect(result).toMatchObject({
      displayName: name,
      mimeType: name.endsWith(".markdown") ? "text/markdown" : mimeType,
      size: data.length,
    });
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.bytes).not.toBe(data);
  });

  it("sanitizes display names without retaining a supplied local path", () => {
    expect(validateAttachmentImport({
      name: "/Users/person/private/preview.png",
      mimeType: "image/png",
      data: png,
    }).displayName).toBe("preview.png");
    expect(validateAttachmentImport({
      name: "unsafe\n.png",
      mimeType: "image/png",
      data: png,
    }).displayName).toBe("image.png");
  });

  it("accepts a Linux clipboard PDF with an empty declared MIME after byte verification", () => {
    expect(validateAttachmentImport({
      name: "linux-clipboard.pdf",
      mimeType: "",
      data: pdf,
    })).toMatchObject({
      displayName: "linux-clipboard.pdf",
      mimeType: "application/pdf",
      size: pdf.length,
    });
  });

  it.each([
    ["preview.png", "image/x-png", png],
    ["preview.webp", "image/x-webp", webp],
    ["preview.gif", "image/x-gif", gif],
    ["notes.pdf", "application/acrobat", pdf],
    ["notes.txt", "text/plain; charset=utf-8", Buffer.from("safe\n")],
    ["rows.csv", "application/vnd.ms-excel", Buffer.from("name,value\nsafe,1\n")],
    ["notes.md", "application/x-markdown", Buffer.from("# Safe notes\n")],
    ["forecast.xlsx", "application/zip", xlsx],
    ["forecast.xlsx", "application/x-xlsx", xlsx],
    ["forecast.xlsx", "application/octet-stream", xlsx],
    ["forecast.xls", "application/x-msexcel", xls],
    ["forecast.xls", "application/x-ms-excel", xls],
    ["forecast.xls", "application/octet-stream", xls],
  ])("accepts verified %s content with platform MIME %s", (
    name,
    mimeType,
    data,
  ) => {
    expect(validateAttachmentImport({ name, mimeType, data })).toMatchObject({
      displayName: name,
      size: data.length,
    });
  });

  it("rejects an XLSX container whose directory advertises an unsafe expansion", () => {
    const expanded = Buffer.from(xlsx);
    const centralDirectory = expanded.indexOf(Buffer.from([
      0x50, 0x4b, 0x01, 0x02,
    ]));
    expect(centralDirectory).toBeGreaterThanOrEqual(0);
    expanded.writeUInt32LE(
      MAX_SPREADSHEET_ATTACHMENT_EXPANDED_BYTES + 1,
      centralDirectory + 24,
    );

    expect(() => validateAttachmentImport({
      name: "expanded.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      data: expanded,
    })).toThrow(/content does not match/u);
  });

  it("rejects XLSX entries that inflate beyond their claimed size", () => {
    const deceptive = Buffer.from(xlsx);
    const entry = xlsxEntryLocation(deceptive, "xl/theme/theme1.xml");
    expect(deceptive.readUInt16LE(entry.centralOffset + 10)).toBe(8);
    deceptive.writeUInt32LE(1, entry.centralOffset + 24);
    deceptive.writeUInt32LE(1, entry.localOffset + 22);

    expect(() => validateAttachmentImport({
      name: "deceptive.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      data: deceptive,
    })).toThrow(/content does not match/u);
  });

  it("rejects XLSX entries whose local and central names disagree", () => {
    const mismatched = Buffer.from(xlsx);
    const entry = xlsxEntryLocation(mismatched, "xl/workbook.xml");
    mismatched[entry.localNameOffset] = "y".charCodeAt(0);

    expect(() => validateAttachmentImport({
      name: "mismatched.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      data: mismatched,
    })).toThrow(/content does not match/u);
  });

  it("rejects an XLSX archive containing a VBA project part", () => {
    const macro = Buffer.from(xlsx);
    const originalName = "docProps/core.xml";
    const macroName = "xl/vbaProject.bin";
    expect(Buffer.byteLength(originalName)).toBe(Buffer.byteLength(macroName));
    const entry = xlsxEntryLocation(macro, originalName);
    macro.write(macroName, entry.centralOffset + 46, "utf8");
    macro.write(macroName, entry.localNameOffset, "utf8");

    expect(() => validateAttachmentImport({
      name: "macro.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      data: macro,
    })).toThrow(/content does not match/u);
  });

  it("rejects image headers, truncation, corrupt checksums, and trailing payloads", () => {
    const corruptPng = Buffer.from(png);
    const idat = corruptPng.indexOf(Buffer.from("IDAT", "ascii"));
    expect(idat).toBeGreaterThanOrEqual(0);
    corruptPng[idat + 4] ^= 0x01;

    const malformed = [
      { name: "header.png", data: png.subarray(0, 8) },
      { name: "truncated.jpg", data: jpeg.subarray(0, -2) },
      { name: "header.gif", data: Buffer.from("GIF89a;", "ascii") },
      { name: "bad-length.webp", data: webp.subarray(0, -1) },
      { name: "bad-crc.png", data: corruptPng },
      { name: "trailing.png", data: Buffer.concat([png, Buffer.from("x")]) },
    ];
    for (const candidate of malformed) {
      expect(() => validateAttachmentImport({
        ...candidate,
        mimeType: chatMimeForTestName(candidate.name),
      }), candidate.name).toThrow(/content does not match/u);
    }
  });

  it("rejects an image whose decoded canvas exceeds the safe dimension bound", () => {
    const oversizedGif = Buffer.from(gif);
    oversizedGif.writeUInt16LE(8_193, 6);

    expect(() => validateAttachmentImport({
      name: "oversized.gif",
      mimeType: "image/gif",
      data: oversizedGif,
    })).toThrow(/content does not match/u);
  });

  it("rejects PDFs with deceptive cross-references, trailers, or page trees", () => {
    const source = pdf.toString("ascii");
    const malformed = [
      Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "ascii"),
      Buffer.from(source.replace(
        /startxref\n\d+/u,
        `startxref\n${pdf.byteLength + 1}`,
      ), "ascii"),
      Buffer.from(source.replace(
        /\d{10} 00000 n/u,
        "9999999999 00000 n",
      ), "ascii"),
      Buffer.from(source.replace("/Root", "/R00t"), "ascii"),
      Buffer.from(source.replace("/Size 6", "/Size 100001"), "ascii"),
      Buffer.from(source.replace(
        "/Root 1 0 R >>",
        "/Root 1 0 R /Encrypt 5 0 R >>",
      ), "ascii"),
      Buffer.from(source.replace("/Count 1", "/Count 0"), "ascii"),
      Buffer.concat([pdf, Buffer.from("payload", "ascii")]),
    ];
    for (const data of malformed) {
      expect(() => validateAttachmentImport({
        name: "unsafe.pdf",
        mimeType: "application/pdf",
        data,
      })).toThrow(/content does not match/u);
    }
  });

  it.each([
    { name: "script.svg", mimeType: "image/svg+xml", data: Buffer.from("<svg/>") },
    { name: "archive.zip", mimeType: "application/zip", data: Buffer.from("PK") },
    { name: "preview.png", mimeType: "application/pdf", data: png },
    { name: "notes.pdf", mimeType: "application/pdf", data: png },
    { name: "notes.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF-1.7\n") },
    { name: "notes.json", mimeType: "application/json", data: Buffer.from("{bad}") },
    { name: "notes.txt", mimeType: "text/plain", data: Buffer.from([0xff, 0xfe]) },
    { name: "notes.txt", mimeType: "text/plain", data: Buffer.from("safe\0unsafe") },
    { name: "blank.txt", mimeType: "text/plain", data: Buffer.from(" \n\t") },
    { name: "blank.md", mimeType: "text/markdown", data: Buffer.from("\uFEFF\n") },
    { name: "empty.txt", mimeType: "text/plain", data: Buffer.alloc(0) },
    {
      name: "renamed.xlsx",
      mimeType: "application/zip",
      data: Buffer.from("PK\u0003\u0004not-a-workbook", "binary"),
    },
    {
      name: "renamed.xls",
      mimeType: "application/vnd.ms-excel",
      data: Buffer.concat([Buffer.from([
        0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
      ]), Buffer.alloc(1_016)]),
    },
    {
      name: "large.png",
      mimeType: "image/png",
      data: Buffer.alloc(MAX_CHAT_ATTACHMENT_BYTES + 1),
    },
  ])("rejects malformed or unsupported imports %#", (candidate) => {
    expect(() => validateAttachmentImport(candidate)).toThrow();
  });
});

function chatMimeForTestName(name: string): string {
  if (name.endsWith(".jpg")) return "image/jpeg";
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".webp")) return "image/webp";
  return "image/png";
}
