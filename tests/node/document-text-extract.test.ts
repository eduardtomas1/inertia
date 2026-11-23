import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { ExtractedDocumentAttachmentMimeType } from "../../src/shared/attachments";
import {
  DOCUMENT_TEXT_TRUNCATED_NOTICE,
  DocumentExtractionError,
} from "../../src/node/document-text-errors";
import { extractStructuredDocumentText } from "../../src/node/document-text-extract";
import {
  T3_DOCUMENT_STRUCTURE_CASES,
  documentArchive,
} from "../fixtures/attachments/document-archives";

const MIME: Readonly<Record<string, ExtractedDocumentAttachmentMimeType>> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rtf: "application/rtf",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  ipynb: "application/x-ipynb+json",
  epub: "application/epub+zip",
};

function extract(ext: string, bytes: Uint8Array | string) {
  return extractStructuredDocumentText(
    typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes,
    MIME[ext]!,
  );
}

function failure(ext: string, bytes: Uint8Array | string): string {
  try {
    extract(ext, bytes);
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentExtractionError);
    return (error as DocumentExtractionError).code;
  }
  throw new Error("Extraction unexpectedly succeeded.");
}

const docx = (body: string, extra: Record<string, string | Buffer> = {}) =>
  documentArchive({ "word/document.xml": body, ...extra });

describe("structured document text extraction", () => {
  it.each(T3_DOCUMENT_STRUCTURE_CASES.map((item, index) => [index, item.ext, item] as const))(
    "ports T3 structure case %i (%s)",
    (_index, ext, item) => {
      const bytes = documentArchive(item.parts);
      if (item.expected.length === 1 && item.expected[0] === DOCUMENT_TEXT_TRUNCATED_NOTICE.trim()) {
        expect(failure(ext, bytes)).toBe("document-limit");
        return;
      }
      const { text, truncated } = extract(ext, bytes);
      let previous = -1;
      for (const expected of item.expected) {
        const index = text.indexOf(expected);
        expect(index, `${ext}: ${expected} in ${text.slice(0, 500)}`).toBeGreaterThan(previous);
        previous = index;
      }
      if (item.occurrences) {
        expect(text.split(item.occurrences.text).length - 1).toBe(item.occurrences.count);
      }
      for (const absent of item.absent ?? []) expect(text).not.toContain(absent);
      expect(truncated).toBe(text.endsWith(DOCUMENT_TEXT_TRUNCATED_NOTICE));
      if (item.bounded || ext === "epub") {
        expect(text.length).toBeLessThan(1_000_100);
        expect(text.match(/\[Extracted text truncated/gu)?.length ?? 0).toBeLessThanOrEqual(1);
      }
    },
  );

  it("keeps tracked insertions and drops tracked deletions, moves and hidden runs", () => {
    const { text, truncated } = extract("docx", docx(
      '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t xml:space="preserve">Fee </w:t></w:r>'
        + "<w:del><w:r><w:delText>$500</w:delText></w:r></w:del>"
        + "<w:ins><w:r><w:t>$700</w:t></w:r></w:ins>"
        + "<w:moveFrom><w:r><w:t>Moved away</w:t></w:r></w:moveFrom>"
        + "<w:moveTo><w:r><w:t xml:space=\"preserve\"> moved here</w:t></w:r></w:moveTo>"
        + "<w:r><w:rPr><w:vanish/></w:rPr><w:t>Secret note</w:t></w:r>"
        + "</w:p></w:body></w:document>",
    ));
    expect(text).toBe("Fee $700 moved here");
    expect(truncated).toBe(false);
  });

  it("follows the officeDocument relationship and refuses a workbook named as Word", () => {
    expect(failure("docx", documentArchive({
      "_rels/.rels": '<Relationships><Relationship Id="r" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      "xl/workbook.xml": '<workbook><sheets><sheet name="A" r:id="a"/></sheets></workbook>',
    }))).toBe("content");
    expect(failure("pptx", documentArchive({
      "ppt/presentation.xml": "<document><p>Not a deck</p></document>",
    }))).toBe("content");
  });

  it("reads slides in presentation order with their speaker notes", () => {
    const { text } = extract("pptx", documentArchive({
      "ppt/presentation.xml": '<p:presentation><p:sldIdLst><p:sldId r:id="b"/><p:sldId r:id="a"/></p:sldIdLst></p:presentation>',
      "ppt/_rels/presentation.xml.rels": '<Relationships><Relationship Id="a" Target="slides/slide1.xml"/><Relationship Id="b" Target="slides/slide2.xml"/></Relationships>',
      "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:sld>",
      "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>First slide</a:t></a:r></a:p></p:sld>",
      "ppt/slides/_rels/slide2.xml.rels": '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/n.xml"/></Relationships>',
      "ppt/notesSlides/n.xml": "<p:notes><a:p><a:r><a:t>Say hello</a:t></a:r></a:p></p:notes>",
    }));
    expect(text).toBe("## Slide 1\nFirst slide\nNotes:\nSay hello\n\n## Slide 2\nSecond slide");
  });

  it("reads EPUB chapters in spine order, not manifest order", () => {
    const { text } = extract("epub", documentArchive({
      mimetype: "application/epub+zip",
      "META-INF/container.xml": '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
      "OPS/book.opf": '<package><manifest><item id="one" href="one.xhtml"/><item id="two" href="two.xhtml"/></manifest><spine><itemref idref="two"/><itemref idref="one"/></spine></package>',
      "OPS/one.xhtml": "<html><body><p>Ending</p></body></html>",
      "OPS/two.xhtml": "<html><body><h1>Opening</h1></body></html>",
    }));
    expect(text).toBe("## Chapter 1\n# Opening\n\n## Chapter 2\nEnding");
  });

  it("refuses an ODF package whose mimetype names another format", () => {
    expect(failure("odt", documentArchive({
      mimetype: "application/vnd.oasis.opendocument.spreadsheet",
      "content.xml": "<office:document><text:p>Text</text:p></office:document>",
    }))).toBe("content");
  });
});

describe("hostile and unreadable documents", () => {
  it("refuses a compression-ratio bomb before inflating it", () => {
    const bomb = documentArchive({
      "word/document.xml": { data: Buffer.alloc(8 * 1024 * 1024, 0x20), method: 8 },
    });
    expect(bomb.byteLength).toBeLessThan(64 * 1024);
    expect(failure("docx", bomb)).toBe("document-limit");
  });

  it("refuses an entry whose stored size understates its inflated data", () => {
    const bytes = documentArchive({
      "word/document.xml": { data: Buffer.from(`<document><p>${"A".repeat(4096)}</p></document>`), method: 8 },
    });
    const directory = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(100, directory + 24);
    bytes.writeUInt32LE(100, 22);
    expect(["document-corrupt", "document-limit"]).toContain(failure("docx", bytes));
  });

  it("refuses archives whose XML parts expand beyond the total budget", () => {
    const filler = (seed: number) => Buffer.from(
      `<document><p>${randomBytes(9 * 1024 * 1024).toString("base64")}${seed}</p></document>`,
    );
    expect(failure("docx", documentArchive({
      "word/document.xml": { data: filler(1), method: 8 },
      "word/a.xml": { data: filler(2), method: 8 },
      "word/b.xml": { data: filler(3), method: 8 },
    }))).toBe("document-limit");
  });

  it("refuses archives with too many entries", () => {
    const parts: Record<string, string> = { "word/document.xml": "<document><p>Kept</p></document>" };
    for (let index = 0; index < 2_048; index += 1) parts[`word/media/${index}.png`] = "x";
    expect(failure("docx", documentArchive(parts))).toBe("document-limit");
    const archive = docx("<document><p>Kept</p></document>");
    archive.writeUInt16LE(2_049, archive.length - 22 + 8);
    archive.writeUInt16LE(2_049, archive.length - 22 + 10);
    expect(failure("docx", archive)).toBe("document-limit");
  });

  it("turns excessive XML depth and node counts into a clear limit failure", () => {
    expect(failure("docx", docx(`<document>${"<div>".repeat(200)}Lost${"</div>".repeat(200)}</document>`)))
      .toBe("document-limit");
    expect(failure("docx", docx(`<document>${"<p/>".repeat(200_001)}</document>`))).toBe("document-limit");
    const { text, truncated } = extract("pptx", documentArchive({
      "ppt/presentation.xml": '<presentation><sldIdLst><sldId r:id="a"/><sldId r:id="b"/></sldIdLst></presentation>',
      "ppt/_rels/presentation.xml.rels": '<Relationships><Relationship Id="a" Target="slides/a.xml"/><Relationship Id="b" Target="slides/b.xml"/></Relationships>',
      "ppt/slides/a.xml": "<sld><p>Readable slide</p></sld>",
      "ppt/slides/b.xml": `<sld>${"<g>".repeat(200)}Deep${"</g>".repeat(200)}</sld>`,
    }));
    expect(truncated).toBe(true);
    expect(text).toBe(`## Slide 1\nReadable slide\n\n## Slide 2${DOCUMENT_TEXT_TRUNCATED_NOTICE}`);
  });

  it.each([
    ["internal entity", '<!DOCTYPE d [<!ENTITY x "expanded">]><document><p>&x;</p></document>'],
    ["entity expansion", `<!DOCTYPE d [<!ENTITY a "aaaaaaaaaa">${Array.from({ length: 9 }, (_, index) => `<!ENTITY ${String.fromCharCode(98 + index)} "${`&${String.fromCharCode(97 + index)};`.repeat(10)}">`).join("")}]><document><p>&j;</p></document>`],
    ["external entity", '<!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><document><p>&x;</p></document>'],
    ["external DTD", '<!DOCTYPE d SYSTEM "http://example.com/a.dtd"><document><p>Text</p></document>'],
    ["stray entity declaration", '<document><!ENTITY x "y"><p>Text</p></document>'],
  ])("refuses a DTD carrying %s in Word XML", (_name, xml) => {
    expect(failure("docx", docx(xml))).toBe("document-corrupt");
  });

  it("refuses entity declarations in EPUB chapters while allowing a bare XHTML doctype", () => {
    const book = (chapter: string) => documentArchive({
      "META-INF/container.xml": '<container><rootfile full-path="book.opf"/></container>',
      "book.opf": '<package><item id="a" href="a.xhtml"/><itemref idref="a"/></package>',
      "a.xhtml": chapter,
    });
    expect(failure("epub", book('<!DOCTYPE html [<!ENTITY x SYSTEM "file:///etc/passwd">]><html><p>&x;</p></html>')))
      .toBe("document-corrupt");
    expect(extract("epub", book("<!DOCTYPE html><html><p>Plain&nbsp;chapter</p></html>")).text)
      .toBe("## Chapter 1\nPlain chapter");
  });

  it("distinguishes truncated archives, renamed non-archives and empty files", () => {
    const archive = docx("<document><p>Complete</p></document>");
    expect(failure("docx", archive.subarray(0, archive.length - 10))).toBe("document-corrupt");
    expect(failure("docx", archive.subarray(0, Math.floor(archive.length / 2)))).toBe("document-corrupt");
    expect(failure("docx", "This is plain text renamed to .docx")).toBe("content");
    expect(failure("epub", Buffer.from("%PDF-1.7\n"))).toBe("content");
    expect(failure("docx", new Uint8Array())).toBe("document-empty");
    expect(failure("docx", docx("<document><p>   </p></document>"))).toBe("document-empty");
  });

  it("reports encrypted packages specifically", () => {
    expect(failure("docx", documentArchive({
      "word/document.xml": { data: Buffer.from("<document><p>Secret</p></document>"), flags: 1 },
    }))).toBe("document-encrypted");
    const ole = Buffer.alloc(4096);
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(ole);
    Buffer.from("EncryptionInfo", "utf16le").copy(ole, 1024);
    Buffer.from("EncryptedPackage", "utf16le").copy(ole, 1152);
    expect(failure("docx", ole)).toBe("document-encrypted");
    expect(failure("pptx", ole)).toBe("document-encrypted");
    expect(failure("odt", documentArchive({
      mimetype: "application/vnd.oasis.opendocument.text",
      "content.xml": "<office:document><text:p>x</text:p></office:document>",
      "META-INF/manifest.xml": '<manifest:manifest><manifest:file-entry manifest:full-path="content.xml"><manifest:encryption-data/></manifest:file-entry></manifest:manifest>',
    }))).toBe("document-encrypted");
    expect(failure("epub", documentArchive({
      "META-INF/container.xml": '<container><rootfile full-path="book.opf"/></container>',
      "META-INF/encryption.xml": "<encryption/>",
      "book.opf": "<package/>",
    }))).toBe("document-encrypted");
  });

  it("refuses unsafe archive entry names", () => {
    expect(failure("docx", documentArchive({
      "word/document.xml": "<document><p>Text</p></document>",
      "../evil.xml": "<x/>",
    }))).toBe("document-corrupt");
  });
});

describe("notebook and RTF extraction", () => {
  it("extracts notebook cells and outputs as T3 does", () => {
    const rawSource = String.raw`\begin{tabular}{lr} North & 120 \\ \end{tabular}`;
    const { text } = extract("ipynb", JSON.stringify({
      cells: [
        { cell_type: "markdown", source: ["# Survey\n", "Vessel: Larkspur"] },
        {
          cell_type: "code",
          source: ["print(43 * 7)"],
          outputs: [
            { output_type: "stream", name: "stdout", text: "\u001b[32m301\u001b[0m\n" },
            { output_type: "display_data", data: { "text/plain": ["\u001b[", "33m42\u001b[0m\n", "Next line"] }, metadata: {} },
            {
              output_type: "error",
              ename: "ZeroDivisionError",
              evalue: "division by zero",
              traceback: ["\u001b[32mCell In[1], line 1\u001b[0m", "\u001b[31m----> 1 1 / 0\u001b[0m", "ZeroDivisionError: division by zero"],
            },
          ],
        },
        { cell_type: "raw", source: [rawSource] },
        { cell_type: "code", source: "x = 1", outputs: [] },
      ],
    }));
    expect(text).toContain("Vessel: Larkspur");
    expect(text).toContain("Output:\n301\n");
    expect(text).toContain("42\nNext line");
    expect(text).toContain(`## Cell 3 (raw)\n${rawSource}`);
    expect(text).toContain("ZeroDivisionError: division by zero\nCell In[1], line 1\n----> 1 1 / 0\nZeroDivisionError: division by zero");
    expect(text).toContain("## Cell 4 (code)\nx = 1\nOutput:");
    expect(text).not.toContain("\u001b");
  });

  it("bounds notebook cells and runaway tracebacks", () => {
    const limited = extract("ipynb", JSON.stringify({ cells: Array.from({ length: 10_001 }, () => ({ source: "Kept" })) }));
    expect(limited.text).toContain("## Cell 10000");
    expect(limited.text).not.toContain("## Cell 10001");
    expect(limited.text.match(/\[Extracted text truncated/gu)).toHaveLength(1);
    const traced = extract("ipynb", JSON.stringify({
      cells: [{
        cell_type: "code",
        source: "1 / 0",
        outputs: [{ output_type: "error", ename: "ZeroDivisionError", evalue: "division by zero", traceback: [`\u001b[31m${"trace".repeat(250_000)}\u001b[0m`, "After limit"] }],
      }],
    }));
    expect(traced.text).toContain("ZeroDivisionError: division by zero\ntrace");
    expect(traced.text.length).toBeLessThan(1_000_100);
    expect(traced.text).not.toContain("After limit");
    expect(traced.text).not.toContain("\u001b");
  });

  it("rejects notebooks that are not JSON notebooks", () => {
    expect(failure("ipynb", "{not json")).toBe("document-corrupt");
    expect(failure("ipynb", JSON.stringify({ metadata: {} }))).toBe("content");
  });

  it("ports T3's RTF cases", () => {
    expect(extract("rtf", String.raw`{\rtf1\ansi{\fonttbl hidden}Hello\tab world\par Unicode \u945?{\*\secret hidden}}`).text)
      .toBe("Hello\tworld\nUnicode α");
    expect(extract("rtf", String.raw`{\rtf1\ansi\ansicpg1251 \'cf\'f0\'e8\'e2\'e5\'f2 {\ansicpg1252 \'e9} \'cc\'ee\'f1\'ea\'e2\'e0}`).text)
      .toBe("Привет é Москва");
    expect(extract("rtf", Buffer.concat([
      Buffer.from(String.raw`{\rtf1\ansi\ansicpg1251 `),
      Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]),
      Buffer.from("}"),
    ])).text).toBe("Привет");
    expect(extract("rtf", String.raw`{\rtf1 Kept` + "{".repeat(128) + "Lost" + "}".repeat(129)).text)
      .toBe(`Kept${DOCUMENT_TEXT_TRUNCATED_NOTICE}`);
    expect(failure("rtf", String.raw`{\rtf1\ansi\ansicpg932 \'82\'a0}`)).toBe("document-corrupt");
    const surrogate = extract("rtf", String.raw`{\rtf1 ` + "x".repeat(999_999) + String.raw`\u-10179?\u-8576? After}`).text;
    expect(surrogate).toContain("[Extracted text truncated");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(surrogate)).toBe(false);
    expect(surrogate.startsWith("x".repeat(999_999))).toBe(true);
    expect(extract("rtf", String.raw`{\rtf1 First` + " ".repeat(1_000_100) + "Last}").text)
      .toBe(`First${DOCUMENT_TEXT_TRUNCATED_NOTICE}`);
  });

  it("excludes RTF tracked deletions and hidden text but keeps table structure", () => {
    expect(extract("rtf", String.raw`{\rtf1 Fee {\deleted $500}$700 {\v secret}visible\cell next\row}`).text)
      .toBe("Fee $700 visible\tnext");
    expect(failure("rtf", "Plain text renamed to rtf")).toBe("content");
  });
});
