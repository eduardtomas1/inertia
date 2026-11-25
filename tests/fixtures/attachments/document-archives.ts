import { crc32, deflateRawSync } from "node:zlib";

export interface DocumentArchiveEntry {
  readonly data: Buffer;
  readonly method?: 0 | 8;
  readonly flags?: number;
}

export function documentArchive(
  parts: Readonly<Record<string, string | Buffer | DocumentArchiveEntry | undefined>>,
): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, part] of Object.entries(parts)) {
    if (part === undefined) continue;
    const entry: DocumentArchiveEntry = typeof part === "string" || Buffer.isBuffer(part)
      ? {
          data: typeof part === "string" ? Buffer.from(part) : part,
          method: /\.(bmp|bin)$/u.test(name) ? 8 : 0,
        }
      : part;
    const method = entry.method ?? 0;
    const data = entry.data;
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const filename = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entry.flags ?? 0, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(entry.flags ?? 0, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(crc32(data), 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, filename, compressed);
    central.push(directory, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const directoryBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directoryBytes, end]);
}

export interface DocumentStructureCase {
  readonly ext: string;
  readonly bounded?: boolean;
  readonly parts: Readonly<Record<string, string | Buffer | undefined>>;
  readonly expected: readonly string[];
  readonly absent?: readonly string[];
  readonly occurrences?: { readonly text: string; readonly count: number };
}

const t3DocumentStructureCases: readonly DocumentStructureCase[] = [
  {
    ext: "docx",
    bounded: true,
    parts: {
      "word/document.xml":
        '<w:document xmlns:w="urn:w" xmlns:wp="urn:wp" xmlns:wp14="urn:wp14" xmlns:mc="urn:mc"><w:body><w:p><w:r><w:t>Total cost is </w:t><w:drawing><wp:anchor><wp:positionH><wp:posOffset>1905000</wp:posOffset></wp:positionH><wp:positionV><wp:posOffset>-635</wp:posOffset></wp:positionV><wp14:sizeRelH><wp14:pctWidth>0</wp14:pctWidth></wp14:sizeRelH><wp14:sizeRelV><wp14:pctHeight>0</wp14:pctHeight></wp14:sizeRelV></wp:anchor></w:drawing><w:t>42 EUR.</w:t></w:r></w:p></w:body></w:document>',
    },
    expected: ["Total cost is 42 EUR."],
    absent: ["1905000", "-635", "0042"],
  },
  {
    ext: "docx",
    bounded: true,
    parts: {
      "word/document.xml":
        '<w:document xmlns:w="urn:w" xmlns:wp="urn:wp" xmlns:wp14="urn:wp14" xmlns:mc="urn:mc"><w:body><w:p><mc:AlternateContent><mc:Choice Requires="cx"><w:drawing><wp:anchor><wp:positionH><wp:posOffset>1905000</wp:posOffset></wp:positionH><wp:positionV><wp:posOffset>-635</wp:posOffset></wp:positionV><wp14:sizeRelH><wp14:pctWidth>0</wp14:pctWidth></wp14:sizeRelH><wp14:sizeRelV><wp14:pctHeight>0</wp14:pctHeight></wp14:sizeRelV></wp:anchor></w:drawing><cx:chart/></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>Chart caption</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:p></w:body></w:document>',
    },
    expected: ["Chart caption"],
    absent: ["1905000", "-635"],
  },
  {
    ext: "docx",
    bounded: true,
    parts: {
      "word/document.xml":
        '<w:document xmlns:w="urn:w" xmlns:wp="urn:wp" xmlns:wp14="urn:wp14" xmlns:mc="urn:mc"><w:body><w:p><w:r><w:t>As shown </w:t><w:fldChar><w:fldData>RU5ETk9URQ==</w:fldData></w:fldChar><w:t>(Smith 2020) earlier.</w:t></w:r></w:p></w:body></w:document>',
    },
    expected: ["As shown (Smith 2020) earlier."],
    absent: ["RU5ETk9URQ=="],
  },
  {
    ext: "docx",
    bounded: true,
    parts: {
      "word/document.xml": "<document><p>Readable despite embedded media</p></document>",
      "word/media/black.bmp": "\0".repeat(64 * 1024),
      "word/embeddings/unused.bin": "\0".repeat(33 * 1024 * 1024),
    },
    expected: ["Readable despite embedded media"],
    absent: ["[Extracted text truncated"],
  },
  ...["/word/../word/document2.xml", "word/document2.xml"].map((target) => ({
    ext: "docx",
    bounded: true,
    parts: {
      "_rels/.rels": `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`,
      "word/document.xml": "<document><p>Stale draft</p></document>",
      "word/document2.xml": "<document><p>Launch moves to 3 March.</p></document>",
    },
    expected: ["Launch moves to 3 March."],
    absent: ["Stale draft", "[Skipped document part"],
  })),
  {
    ext: "docx",
    bounded: true,
    parts: {
      "_rels/.rels":
        '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/WORD/DOCUMENT.XML"/></Relationships>',
      "word/document.xml": "<document><p>Launch moves to 3 March.</p></document>",
    },
    expected: ["Launch moves to 3 March."],
    absent: ["[Skipped document part"],
  },
  ...[false, true].map((deep) => ({
    ext: "docx",
    bounded: true,
    parts: {
      "word/document.xml": `<document>${deep ? "<div>".repeat(129) + "Lost" + "</div>".repeat(129) : "<p/>".repeat(200_001)}</document>`,
    },
    expected: ["[Extracted text truncated at document extraction limits.]"],
    absent: ["Lost"],
  })),
  ...["ods", "odt", "odp", "docx"].flatMap((ext) =>
    [false, true].map((rows) => ({
      ext,
      bounded: true,
      parts: {
        [ext === "docx" ? "word/document.xml" : "content.xml"]:
          `<document><page><table><table-row${rows ? ' number-rows-repeated="10001"' : ""}><table-cell${rows ? "" : ' number-columns-repeated="513"'}><p>Repeated value</p></table-cell></table-row></table></page></document>`,
      },
      expected: [
        "Repeated value",
        "[Extracted text truncated at document extraction limits.]",
      ],
      occurrences: { text: "Repeated value", count: rows ? 10_000 : 512 },
    })),
  ),
  ...["ods", "odt", "odp", "docx"].map((ext) => ({
    ext,
    bounded: true,
    parts: {
      [ext === "docx" ? "word/document.xml" : "content.xml"]:
        `<document><page><table><table-row><table-cell><p>Kept</p></table-cell><table-cell number-columns-repeated="16383"> \n <p> \t </p> <s c="1048575"/> </table-cell></table-row><table-row number-rows-repeated="1048575"><table-cell> \n <p> \t </p> </table-cell></table-row></table></page></document>`,
    },
    expected: ["Kept"],
    absent: ["[Extracted text truncated", "\t"],
  })),
  ...["ods", "odt", "odp"].map((ext) => ({
    ext,
    bounded: true,
    parts: {
      "content.xml": `<document><page><table><table-row>
        <table-cell office:value-type="string" office:string-value="Harbor"/>
        <table-cell office:value-type="boolean" office:boolean-value="false"/>
        <table-cell office:value-type="date" office:date-value="2026-10-20"/>
        <table-cell office:value-type="time" office:time-value="PT2H30M"/>
        <table-cell office:value-type="currency" office:value="125.50" office:currency="USD"/>
        <table-cell office:value-type="percentage" office:value="0.25"/>
        <table-cell office:value-type="float" office:value="0"/>
        <table-cell office:value-type="string" office:string-value="Fallback"><p> \n </p></table-cell>
        <table-cell office:value-type="string" office:string-value="Unshown"><p>Displayed</p></table-cell>
        <table-cell office:value-type="void" office:value="Unshown"/>
        <table-cell office:value-type="currency" office:value=" " office:currency="Unshown"/>
        <table-cell office:value-type="percentage" office:value=" "/>
      </table-row></table></page></document>`,
    },
    expected: [
      "Harbor\tfalse\t2026-10-20\tPT2H30M\t125.50 USD\t0.25 [ODF value-type=percentage]\t0\tFallback\tDisplayed",
    ],
    absent: ["Unshown", "[Extracted text truncated"],
  })),
  ...[false, true].map((rows) => ({
    ext: "xlsx",
    bounded: true,
    parts: {
      "xl/workbook.xml": '<workbook><sheet name="Limited" r:id="a"/></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="a" Target="worksheets/a.xml"/></Relationships>',
      "xl/worksheets/a.xml": `<worksheet>${rows ? "<row><c><v>7</v></c></row>".repeat(10_001) : '<row><c r="A1"><v>7</v></c><c r="SS1"><v>Beyond</v></c></row>'}</worksheet>`,
    },
    expected: ["7", "[Extracted text truncated at document extraction limits.]"],
    absent: ["Beyond"],
  })),
  {
    ext: "xlsx",
    bounded: true,
    parts: {
      "xl/workbook.xml": '<workbook><sheet name="Padding" r:id="a"/></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="a" Target="worksheets/a.xml"/></Relationships>',
      "xl/sharedStrings.xml": "<sst><si><t> \n </t></si><si><t>Present</t></si></sst>",
      "xl/worksheets/a.xml": `<worksheet>${'<row><c t="s"><v>0</v></c><c r="XFD1" t="inlineStr"><is><t> \t </t></is></c></row>'.repeat(10_001)}<row><c t="s"><v>0</v></c><c t="s"><v>1</v></c><c r="XFD2"><v> \n </v></c></row></worksheet>`,
    },
    expected: ["Present"],
    absent: ["[Extracted text truncated"],
  },
  {
    ext: "epub",
    parts: {
      "META-INF/container.xml": '<container><rootfile full-path="book.opf"/></container>',
      "book.opf":
        '<package><item id="bad" href="ch%ZZ.xhtml"/><item id="good" href="good.svg"/><itemref idref="bad"/><itemref idref="good"/></package>',
      "good.svg":
        '<svg xmlns="http://www.w3.org/2000/svg"><text>Readable SVG chapter</text></svg>',
    },
    expected: [
      "Readable SVG chapter",
      "[Skipped document part: chapter 1 (missing or invalid XML).]",
    ],
    absent: ["[Extracted text truncated"],
  },
  ...[false, true].flatMap((bom) =>
    [false, true].map((bigEndian) => {
      const encode = (source: string) => {
        const data = Buffer.from(`${bom ? "\ufeff" : ""}${source}`, "utf16le");
        return bigEndian ? data.swap16() : data;
      };
      return {
        ext: "epub",
        parts: {
          "META-INF/container.xml": encode(
            '<?xml version="1.0" encoding="UTF-16"?><container><rootfile full-path="book.opf"/></container>',
          ),
          "book.opf": encode(
            '<?xml version="1.0" encoding="UTF-16"?><package><item id="a" href="a.xhtml"/><itemref idref="a"/></package>',
          ),
          "a.xhtml": encode(
            '<?xml version="1.0" encoding="UTF-16"?><html><p>UTF-16 chapter: café 日本語</p></html>',
          ),
        },
        expected: ["UTF-16 chapter: café 日本語"],
        absent: ["[Skipped document part", "[Extracted text truncated"],
      };
    }),
  ),
  {
    ext: "epub",
    bounded: true,
    parts: {
      "META-INF/container.xml": '<container><rootfile full-path="book.opf"/></container>',
      "book.opf":
        '<package><item id="bad" href="bad.xhtml"/><item id="good" href="good.xhtml"/><itemref idref="bad"/><itemref idref="good"/></package>',
      "bad.xhtml": "<html><p>Discard this broken chapter</html>",
      "good.xhtml":
        '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html><p>North&nbsp;Harbor &NotEqualTilde; &CounterClockwiseContourIntegral; &amp; &lt;tag&gt; &quot;quoted&quot;</p><p><![CDATA[Literal &nbsp;]]></p><table><tr><td>&nbsp; </td></tr><tr><td>Kept&nbsp;cell</td></tr></table></html>',
    },
    expected: [
      "## Chapter 2",
      'North\u00a0Harbor ≂̸ ∳ & <tag> "quoted"',
      "Literal &nbsp;",
      "Kept cell",
      "[Skipped document part: bad.xhtml (missing or invalid XML).]",
    ],
    absent: ["Discard this broken chapter", "[Extracted text truncated"],
  },
  ...["pptx", "xlsx"].map((ext) => ({
    ext,
    bounded: true,
    parts:
      ext === "pptx"
        ? {
            "ppt/presentation.xml":
              '<presentation><sldIdLst><sldId r:id="bad"/><sldId r:id="good"/></sldIdLst></presentation>',
            "ppt/_rels/presentation.xml.rels":
              '<Relationships><Relationship Id="bad" Target="bad.xml"/><Relationship Id="good" Target="good.xml"/></Relationships>',
            "ppt/bad.xml": "<slide><p>Discard</slide>",
            "ppt/good.xml": "<slide><p>Healthy part</p></slide>",
          }
        : {
            "xl/workbook.xml":
              '<workbook><sheet name="Bad" r:id="bad"/><sheet name="Good" r:id="good"/></workbook>',
            "xl/_rels/workbook.xml.rels":
              '<Relationships><Relationship Id="bad" Target="bad.xml"/><Relationship Id="good" Target="good.xml"/></Relationships>',
            "xl/bad.xml": "<worksheet><row>Discard</worksheet>",
            "xl/good.xml":
              '<worksheet><row><c t="inlineStr"><is><t>Healthy part</t></is></c></row></worksheet>',
          },
    expected: [
      "Healthy part",
      `[Skipped document part: ${ext === "pptx" ? "ppt" : "xl"}/bad.xml (missing or invalid XML).]`,
    ],
    absent: ["Discard", "[Extracted text truncated"],
  })),
  {
    ext: "odt",
    bounded: true,
    parts: { "content.xml": '<document><p>Start<s c="1000001"/>Unneeded</p></document>' },
    expected: ["Start", "[Extracted text truncated at document extraction limits.]"],
    absent: ["Unneeded"],
  },
  {
    ext: "docx",
    bounded: true,
    parts: {
      "word/document.xml":
        '<w:document xmlns:w="urn:w" xmlns:mc="urn:mc"><w:body><w:p><w:r><w:t>Body</w:t></w:r></w:p><w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>Callout box</w:t></w:r></w:p><w:p><w:r><w:t>Second line</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>Callout box</w:t></w:r></w:p><w:p><w:r><w:t>Second line</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p></w:body></w:document>',
    },
    expected: ["Body\nCallout box\nSecond line"],
    occurrences: { text: "Callout box", count: 1 },
  },
  {
    ext: "docx",
    bounded: true,
    parts: {
      "word/document.xml":
        '<w:document xmlns:w="urn:w" xmlns:mc="urn:mc"><w:body><w:p><w:r><mc:AlternateContent><mc:Choice Requires="cx"><w:drawing><cx:chart/></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>Chart caption</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p></w:body></w:document>',
    },
    expected: ["Chart caption"],
  },
  {
    ext: "docx",
    bounded: true,
    parts: {
      "word/document.xml":
        '<w:document xmlns:w="urn:w"><w:body><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Report &amp; totals</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>North</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12</w:t></w:r></w:p><w:p><w:r><w:t>34</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:sdt><w:sdtPr><w:alias w:val="Title"/></w:sdtPr><w:sdtContent><w:tc><w:p><w:r><w:t>Annual report</w:t></w:r></w:p></w:tc></w:sdtContent></w:sdt><w:tc><w:p><w:r><w:t>Draft</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Before</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Inner</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>After</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Neighbor</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:noBreakHyphen/></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:noBreakHyphen/></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
    },
    expected: [
      "## Report & totals",
      "North\t12 34",
      "Annual report\tDraft",
      "Before Inner After\tNeighbor\t\u2011\n\u2011",
    ],
  },
  {
    ext: "docx",
    bounded: true,
    parts: {
      "word/document.xml": [
        '<w:document xmlns:w="urn:w" xmlns:mc="urn:mc"><w:body>',
        '<w:p><w:r><w:t>First</w:t><w:cr/><w:t>Second</w:t><w:br/><w:t>Third</w:t><w:noBreakHyphen/><w:t>party</w:t><mc:AlternateContent><mc:Choice Requires="w"><w:noBreakHyphen/></mc:Choice><mc:Fallback><w:t>‑</w:t></mc:Fallback></mc:AlternateContent><w:t>End</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>Invoice 104</w:t><w:ptab w:alignment="right" w:relativeTo="margin" w:leader="none"/><w:t>$700.00</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>Invoice 105</w:t><mc:AlternateContent><mc:Choice Requires="w"><w:ptab w:alignment="right" w:relativeTo="margin" w:leader="none"/></mc:Choice><mc:Fallback><w:tab/></mc:Fallback></mc:AlternateContent><w:t>$800.00</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>Invoice 106</w:t><mc:AlternateContent><mc:Choice Requires="w"><w:ptab w:alignment="right" w:relativeTo="margin" w:leader="none"/></mc:Choice><mc:Fallback><w:t xml:space="preserve"> total </w:t></mc:Fallback></mc:AlternateContent><w:t>$900.00</w:t></w:r></w:p>',
        "</w:body></w:document>",
      ].join(""),
    },
    expected: [
      "First\nSecond\nThird\u2011party\u2011End\nInvoice 104\t$700.00\nInvoice 105\t$800.00\nInvoice 106 total $900.00",
    ],
  },
  {
    ext: "docx",
    bounded: true,
    parts: {
      "word/document.xml":
        '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Intro</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGEREF _Toc1 \\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t> 3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p><w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="9350"/></w:tabs></w:pPr><w:r><w:t xml:space="preserve">Fee </w:t></w:r><w:del><w:r><w:delText>$500</w:delText><w:noBreakHyphen/></w:r></w:del><w:ins><w:r><w:t>$700</w:t></w:r></w:ins><w:moveFrom><w:r><w:t>Moved</w:t></w:r></w:moveFrom><w:r><w:tab/><w:t>due</w:t></w:r></w:p></w:body></w:document>',
    },
    expected: ["Intro 3\nFee $700\tdue"],
    absent: ["PAGEREF", "$500", "Moved", "\u2011"],
  },
  {
    ext: "docx",
    bounded: true,
    parts: {
      "word/document.xml":
        '<w:document xmlns:w="urn:w" xmlns:m="urn:m"><w:body><w:p><w:r><w:t xml:space="preserve">Opening </w:t></w:r><m:oMath><m:r><m:rPr><m:sty m:val="p"/></m:rPr><w:rPr><w:vanish/></w:rPr><m:t>Formula</m:t></m:r></m:oMath><w:r><w:rPr><w:vanish/></w:rPr><w:t>Omitted</w:t></w:r><w:r><w:rPr><w:vanish w:val="0"/></w:rPr><w:t xml:space="preserve">Zero </w:t></w:r><w:r><w:rPr><w:vanish w:val="false"/></w:rPr><w:t xml:space="preserve">False </w:t></w:r><w:r><w:rPr><w:vanish w:val="off"/></w:rPr><w:t xml:space="preserve">Off </w:t></w:r><w:r><w:rPr><w:vanish w:val="true"/></w:rPr><w:t>Draft</w:t></w:r><w:r><w:rPr><w:vanish w:val="1"/></w:rPr><w:t>Note</w:t></w:r><w:r><w:rPr><w:vanish w:val="on"/></w:rPr><w:t>Aside</w:t></w:r><w:r><w:rPr><w:rPrChange><w:rPr><w:vanish/></w:rPr></w:rPrChange></w:rPr><w:t>Shown</w:t></w:r></w:p></w:body></w:document>',
    },
    expected: ["Opening Zero False Off Shown"],
    absent: ["Omitted", "Draft", "Note", "Aside", "Formula"],
  },
  {
    ext: "odt",
    bounded: true,
    parts: {
      "content.xml":
        "<document><text><tracked-changes><changed-region><deletion><change-info><creator>Reviewer</creator></change-info><p>$500</p></deletion></changed-region></tracked-changes><p>Fee <change/>$700</p></text></document>",
    },
    expected: ["Fee $700"],
    absent: ["Reviewer", "$500"],
  },
  {
    ext: "odt",
    bounded: true,
    parts: {
      "content.xml":
        '<document><text><p>Fee <office:annotation><dc:creator>Reviewer</dc:creator><dc:date>2026-01-01T00:00:00</dc:date><initials>JR</initials><p>Check</p></office:annotation>$700</p><table><table-row><table-cell office:value-type="float" office:value="150"><office:annotation><p>was 120</p></office:annotation></table-cell></table-row></table><p>Formula <math:math><math:semantics><math:mrow>x+y</math:mrow><math:annotation encoding="application/x-tex">x+y</math:annotation></math:semantics></math:math></p></text></document>',
    },
    expected: ["Fee $700\n150\nFormula x+yx+y"],
    absent: ["Reviewer", "2026-01-01", "JR", "Check", "was 120"],
  },
  {
    ext: "docx",
    bounded: true,
    parts: {
      "word/document.xml": `<w:document><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>${"A".repeat(1_000_000)}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Later cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`,
    },
    expected: ["A".repeat(32), "[Extracted text truncated at document extraction limits.]"],
  },
  {
    ext: "xlsx",
    bounded: true,
    parts: {
      "xl/workbook.xml": '<workbook><sheet name="Formulas" r:id="a"/></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="a" Target="worksheets/a.xml"/></Relationships>',
      "xl/styles.xml": '<styleSheet><cellXfs><xf numFmtId="9"/></cellXfs></styleSheet>',
      "xl/worksheets/a.xml":
        "<worksheet><row><c><f>SUM(11,22)</f><v/></c></row><row><c><f>SUM(33,44)</f><v> \n </v></c></row><row><c><f>SUM(55,66)</f></c></row><row><c><f>SUM(11,22)</f><v>33</v></c><c><f>SUM(0,0)</f><v>0</v></c></row></worksheet>",
    },
    expected: [
      "SUM(11,22)\nSUM(33,44)\nSUM(55,66)",
      "33 [Excel numFmtId=9; date system 1900]\t0 [Excel numFmtId=9; date system 1900]",
    ],
    absent: ["SUM(0,0)", "[Extracted text truncated"],
  },
  {
    ext: "xlsx",
    bounded: true,
    parts: {
      "xl/workbook.xml": '<workbook><sheet name="Flags" r:id="a"/></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="a" Target="worksheets/a.xml"/></Relationships>',
      "xl/worksheets/a.xml":
        '<worksheet><row><c r="A1" t="b"><v>1</v></c><c r="B1" t="b"><v>0</v></c><c r="C1" t="n"><v>1</v></c><c r="D1" t="b"><v>2</v></c></row></worksheet>',
    },
    expected: ["true\tfalse\t1\t2"],
  },
  {
    ext: "xlsx",
    parts: {
      "xl/workbook.xml":
        '<workbook><sheets><sheet name="Inventory" r:id="a"/><sheet name="Budget" r:id="b"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="a" Target="worksheets/second.xml"/><Relationship Id="b" Target="worksheets/first.xml"/><Relationship Id="strings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="../catalog/items.xml"/></Relationships>',
      "catalog/items.xml": "<sst><si><t>Lantern</t></si></sst>",
      "xl/styles.xml":
        '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="9"/><xf numFmtId="164"/></cellXfs></styleSheet>',
      "xl/worksheets/second.xml":
        '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="C1"><v>37</v></c></row></sheetData></worksheet>',
      "xl/worksheets/first.xml":
        '<worksheet><sheetData><row><c t="inlineStr"><is><t>Ferry</t></is></c><c><v>628</v></c><c s="1"><v>45292</v></c><c s="2"><v>0.25</v></c><c s="3"><v>45293</v></c></row></sheetData></worksheet>',
    },
    expected: [
      "## Sheet: Inventory",
      "Lantern\t\t37",
      "## Sheet: Budget",
      "Ferry\t628",
      "45292 [Excel numFmtId=14; date system 1900]",
      "0.25 [Excel numFmtId=9; date system 1900]",
      "45293 [Excel numFmtId=164; format=yyyy-mm-dd; date system 1900]",
    ],
  },
  {
    ext: "xlsx",
    bounded: true,
    parts: {
      "xl/workbook.xml": '<workbook><sheet name="Phonetics" r:id="a"/></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="a" Target="worksheets/a.xml"/></Relationships>',
      "xl/sharedStrings.xml":
        '<sst><si><t>東京</t><rPh sb="0" eb="2"><t>とうきょう</t></rPh></si></sst>',
      "xl/worksheets/a.xml":
        '<worksheet><row><c t="s"><v>0</v></c><c t="inlineStr"><is><t>東京</t><rPh sb="0" eb="2"><t>とうきょう</t></rPh></is></c></row></worksheet>',
    },
    expected: ["## Sheet: Phonetics", "東京\t東京"],
    absent: ["とうきょう"],
  },
  {
    ext: "xlsx",
    bounded: true,
    parts: {
      "xl/workbook.xml": '<workbook><sheet name="Escapes" r:id="a"/></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="a" Target="worksheets/a.xml"/></Relationships>',
      "xl/sharedStrings.xml":
        "<sst><si><t>first_x000D_\nsecond</t></si><si><t>_x005F_x0041_</t></si><si><t>_x005F_x005F_x0041_</t></si><si><r><t>Bold_x000D_</t></r><r><t>_x005F_x000D_</t></r></si><si><t>&amp;_xnothex_ cap_X0041_ _x000d_ tail</t></si></sst>",
      "xl/worksheets/a.xml":
        '<worksheet><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c><c t="s"><v>2</v></c><c t="s"><v>3</v></c><c t="s"><v>4</v></c></row><row><c t="inlineStr"><is><t>_x005F_x005F_</t></is></c><c t="inlineStr"><is><t>first_x000D_second</t></is></c><c t="str"><f>A1</f><v>Total_x000D_due</v></c></row></worksheet>',
    },
    expected: [
      "## Sheet: Escapes\nfirst second\t_x0041_\t_x005F_x0041_\tBold _x000D_\t&_xnothex_ cap_X0041_ tail\n_x005F_\tfirst second\tTotal due",
    ],
  },
  {
    ext: "xlsx",
    bounded: true,
    parts: {
      "xl/workbook.xml":
        '<workbook><workbookPr date1904="true"/><sheets><sheet name="Dates" r:id="a"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="a" Target="worksheets/dates.xml"/></Relationships>',
      "xl/styles.xml": '<styleSheet><cellXfs><xf numFmtId="14"/></cellXfs></styleSheet>',
      "xl/worksheets/dates.xml":
        "<worksheet><sheetData><row><c><v>1</v></c></row></sheetData></worksheet>",
    },
    expected: ["## Sheet: Dates", "1 [Excel numFmtId=14; date system 1904]"],
  },
  {
    ext: "xlsx",
    bounded: true,
    parts: {
      "xl/workbook.xml":
        '<workbook><sheets><sheet name="Repeated" r:id="a"/><sheet name="Unneeded" r:id="missing"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="a" Target="worksheets/repeated.xml"/></Relationships>',
      "xl/sharedStrings.xml": `<sst><si><t>${"A".repeat(1_000_000 - "## Sheet: Repeated\n".length)}</t></si></sst>`,
      "xl/worksheets/repeated.xml": `<worksheet><sheetData>${'<row><c t="s"><v>0</v></c><c t="s"><v>0</v></c></row>'.repeat(1_500)}</sheetData></worksheet>`,
    },
    expected: [
      "## Sheet: Repeated",
      "A".repeat(32),
      "[Extracted text truncated at document extraction limits.]",
    ],
  },
  {
    ext: "pptx",
    bounded: true,
    parts: {
      "ppt/presentation.xml": `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
        xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
        xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">
        <p:sldIdLst xmlns:links="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <p:sldId r:id="b" id="256"/><p:sldId links:id="a" id="257"/>
        </p:sldIdLst>
        <p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst>
          <p14:section name="Schedule" id="{01F07B81-39E6-4BBB-9B89-66EA253FBD29}">
            <p14:sldIdLst><p14:sldId id="256"/><p14:sldId id="257"/></p14:sldIdLst>
          </p14:section>
        </p14:sectionLst></p:ext></p:extLst>
      </p:presentation>`,
      "ppt/_rels/presentation.xml.rels":
        '<Relationships><Relationship Id="a" Target="slides/slide1.xml"/><Relationship Id="b" Target="slides/slide2.xml"/></Relationships>',
      "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>Departure</a:t></a:r></a:p></p:sld>",
      "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Juniper Pier</a:t></a:r></a:p></p:sld>",
      "ppt/slides/_rels/slide2.xml.rels":
        '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../notesSlides/ignored.xml"/><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" TargetMode="External" Target="https://example.com/notes.xml"/><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notes7.xml"/></Relationships>',
      "ppt/slides/_rels/slide1.xml.rels":
        '<Relationships><Relationship Type="http://purl.oclc.org/ooxml/officeDocument/relationships/notesSlide" Target="/ppt/notesSlides/notes3.xml"/></Relationships>',
      "ppt/notesSlides/notes7.xml":
        '<p:notes><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>evacuation code ORCHID-81</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="hdr" sz="quarter"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Harbor briefing</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="dt" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:fld type="datetime1"><a:t>11/21/2026</a:t></a:fld></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="ftr" sz="quarter" idx="4"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Crew only</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum" sz="quarter" idx="5"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:fld type="slidenum"><a:t>57</a:t></a:fld></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>',
      "ppt/notesSlides/notes3.xml":
        "<p:notes><a:p><a:r><a:t>Board at gate 4</a:t></a:r></a:p></p:notes>",
      "ppt/notesSlides/ignored.xml": "<p:notes><a:p>Unrelated notes</a:p></p:notes>",
    },
    expected: [
      "## Slide 1",
      "Juniper Pier\nNotes:\nevacuation code ORCHID-81",
      "## Slide 2",
      "Departure\nNotes:\nBoard at gate 4",
    ],
    occurrences: { text: "## Slide ", count: 2 },
    absent: [
      "Unrelated notes",
      "Harbor briefing",
      "11/21/2026",
      "Crew only",
      "57",
      "[Skipped document part",
      "[Extracted text truncated",
    ],
  },
  {
    ext: "pptx",
    bounded: true,
    parts: {
      "ppt/presentation.xml":
        '<presentation><sldIdLst><sldId r:id="a"/></sldIdLst></presentation>',
      "ppt/_rels/presentation.xml.rels":
        '<Relationships><Relationship Id="a" Target="slides/a.xml"/></Relationships>',
      "ppt/slides/a.xml": "<slide><p>Slide text</p></slide>",
      "ppt/slides/_rels/a.xml.rels":
        '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/empty.xml"/></Relationships>',
      "ppt/notesSlides/empty.xml":
        '<p:notes><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:endParaRPr/></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum" idx="5"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:fld type="slidenum"><a:t>57</a:t></a:fld></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>',
    },
    expected: ["Slide text"],
    absent: ["Notes:", "57"],
  },
  ...[false, true].map((missing) => ({
    ext: "pptx",
    bounded: true,
    parts: {
      "ppt/presentation.xml":
        '<presentation><sldIdLst><sldId r:id="a"/></sldIdLst></presentation>',
      "ppt/_rels/presentation.xml.rels":
        '<Relationships><Relationship Id="a" Target="slides/a.xml"/></Relationships>',
      "ppt/slides/a.xml": "<slide><p>Slide text</p></slide>",
      "ppt/slides/_rels/a.xml.rels": `<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/${missing ? "missing" : "bad"}.xml"/></Relationships>`,
      "ppt/notesSlides/bad.xml": "<notes><p>Discard broken notes</notes>",
    },
    expected: [
      "Slide text",
      `[Skipped document part: ppt/notesSlides/${missing ? "missing" : "bad"}.xml (missing or invalid XML).]`,
    ],
    absent: ["Discard broken notes", "[Extracted text truncated"],
  })),
  {
    ext: "pptx",
    bounded: true,
    parts: {
      "ppt/presentation.xml":
        '<presentation><sldIdLst><sldId r:id="a"/><sldId r:id="b"/></sldIdLst></presentation>',
      "ppt/_rels/presentation.xml.rels":
        '<Relationships><Relationship Id="a" Target="slides/a.xml"/><Relationship Id="b" Target="slides/b.xml"/></Relationships>',
      "ppt/slides/a.xml": `<slide><p>${"A".repeat(600_000)}</p></slide>`,
      "ppt/slides/b.xml": "<slide><p>Unneeded slide</p></slide>",
      "ppt/slides/_rels/a.xml.rels":
        '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/a.xml"/></Relationships>',
      "ppt/notesSlides/a.xml": `<notes><p>evacuation code ORCHID-81 ${"B".repeat(600_000)} Unneeded notes</p></notes>`,
    },
    expected: [
      "## Slide 1",
      "A".repeat(32),
      "Notes:\nevacuation code ORCHID-81",
      "B".repeat(32),
      "[Extracted text truncated at document extraction limits.]",
    ],
    absent: ["Unneeded notes", "Unneeded slide", "## Slide 2"],
  },
  {
    ext: "odt",
    parts: {
      "content.xml":
        '<office:document><text:h text:outline-level="2">\n  Orchard\n</text:h><text:p>19<text:s text:c="3"/>violet<text:s/>crates <text:span>\n\t  shipped</text:span>   today<text:tab/>Dock<text:line-break/>Gate\u00a0B </text:p><text:p>Second</text:p><text:p>A<text:span><text:script>console.log(1);\n</text:script></text:span> B</text:p>' +
        [
          "table-of-content",
          "illustration-index",
          "table-index",
          "object-index",
          "user-index",
          "alphabetical-index",
          "bibliography",
        ]
          .map(
            (name) =>
              `<text:${name}><text:${name}-source><text:index-title-template>Contents</text:index-title-template><text:${name}-entry-template><text:index-entry-span>: </text:index-entry-span></text:${name}-entry-template></text:${name}-source><text:index-body><text:index-title><text:p>Contents</text:p></text:index-title><text:p>Orchard 1</text:p></text:index-body></text:${name}>`,
          )
          .join("") +
        "</office:document>",
    },
    expected: [
      `## Orchard\n19   violet crates shipped today\tDock\nGate\u00a0B\nSecond\nA B${"\nContents\nOrchard 1".repeat(7)}`,
    ],
  },
  {
    ext: "ods",
    parts: {
      "content.xml":
        '<office:document><table:table table:name="Cargo"><table:table-row><table:table-cell><text:p>Violet</text:p></table:table-cell><table:table-cell office:value="19"/><table:table-cell office:value="27"><text:p/></table:table-cell></table:table-row></table:table></office:document>',
    },
    expected: ["## Sheet: Cargo", "Violet\t19\t27"],
  },
  {
    ext: "ods",
    bounded: true,
    parts: {
      "content.xml":
        '<office:document><table:table table:name="Padded rows"><table:table-row><table:table-cell><text:p>Left</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"/><table:table-cell><text:p>Right</text:p></table:table-cell></table:table-row><table:table-row table:number-rows-repeated="1048575"><table:table-cell/></table:table-row></table:table></office:document>',
    },
    expected: ["## Sheet: Padded rows", "Left\t\t\tRight"],
    absent: ["[Extracted text truncated"],
  },
  {
    ext: "ods",
    bounded: true,
    parts: {
      "content.xml":
        '<office:document><table:table table:name="Padded"><table:table-row><table:table-cell><text:p>Populated</text:p></table:table-cell><table:table-cell table:number-columns-repeated="16383"/></table:table-row><table:table-row table:number-rows-repeated="1048575"><table:table-cell table:number-columns-repeated="16384"><text:p/></table:table-cell></table:table-row></table:table></office:document>',
    },
    expected: ["## Sheet: Padded", "Populated"],
    absent: ["[Extracted text truncated", "\t"],
  },
  {
    ext: "ods",
    bounded: true,
    parts: {
      "content.xml": `<office:document><table:table table:name="Repeated"><table:table-row><table:table-cell table:number-columns-repeated="512"><text:p>Lead ${"a".repeat(600_000)} Tail</text:p></table:table-cell></table:table-row></table:table></office:document>`,
    },
    expected: [
      "## Sheet: Repeated",
      "Lead ",
      " Tail\tLead ",
      "[Extracted text truncated at document extraction limits.]",
    ],
  },
  {
    ext: "odp",
    parts: {
      "content.xml":
        "<office:document>" +
        "<draw:page><draw:frame><draw:text-box><text:p>\n  First\n\t  slide </text:p></draw:text-box></draw:frame>" +
        "<svg:title>Overview</svg:title>" +
        "<presentation:notes><draw:frame><draw:text-box><text:p>Speaker only</text:p></draw:text-box></draw:frame></presentation:notes></draw:page>" +
        "<draw:page><text:p>Second</text:p><presentation:notes><draw:g><draw:page-thumbnail>" +
        "<svg:title>Slide preview</svg:title><svg:desc>Thumbnail metadata</svg:desc>" +
        "</draw:page-thumbnail></draw:g></presentation:notes></draw:page>" +
        "<draw:page><text:p>Third</text:p><presentation:notes><draw:frame><draw:text-box>" +
        '<table:table><table:table-column/><table:table-row><table:table-cell office:value-type="float" office:value="42"/></table:table-row></table:table>' +
        "</draw:text-box></draw:frame></presentation:notes></draw:page></office:document>",
    },
    expected: [
      "## Slide 1\nFirst slide\nOverview\nNotes:\nSpeaker only\n\n## Slide 2\nSecond\n\n## Slide 3\nThird\n\nNotes:\n42",
    ],
  },
  {
    ext: "ods",
    bounded: true,
    parts: {
      "content.xml": `<office:document>${Array.from(
        { length: 256 },
        (_, index) =>
          `<table:table table:name="${index === 0 ? "Shared" : "Unneeded"}"><table:table-row><table:table-cell table:number-columns-repeated="512"><text:p>${"B".repeat(4096)}</text:p></table:table-cell></table:table-row></table:table>`,
      ).join("")}</office:document>`,
    },
    expected: [
      "## Sheet: Shared",
      "B".repeat(32),
      "[Extracted text truncated at document extraction limits.]",
    ],
    absent: ["## Sheet: Unneeded"],
  },
  {
    ext: "odt",
    bounded: true,
    parts: {
      "content.xml": `<office:document><text:p>Before whitespace</text:p><table:table><table:table-row table:number-rows-repeated="10000"><table:table-cell table:number-columns-repeated="512"><text:p>${" ".repeat(10_000)}</text:p></table:table-cell></table:table-row></table:table><text:p>Unneeded</text:p></office:document>`,
    },
    expected: ["Before whitespace", "Unneeded"],
    absent: ["[Extracted text truncated"],
  },
  ...["odt", "odp", "ods"].flatMap((ext) =>
    [false, true].map((rows) => ({
      ext,
      bounded: true,
      parts: {
        "content.xml": `<office:document><draw:page>${Array.from(
          { length: 256 },
          () =>
            `<table:table><table:table-row${rows ? ' table:number-rows-repeated="10000"' : ""}><table:table-cell table:number-columns-repeated="512"><text:p>${"Budget ".repeat(rows ? 160 : 585)}</text:p></table:table-cell></table:table-row></table:table>`,
        ).join(
          "",
        )}</draw:page><draw:page><text:p>Unneeded</text:p></draw:page></office:document>`,
      },
      expected: ["Budget ", "[Extracted text truncated at document extraction limits.]"],
      absent: ["Unneeded"],
    })),
  ),
  {
    ext: "docx",
    bounded: true,
    parts: {
      "word/document.xml": `<w:document><w:p><w:t>${"A".repeat(1_000_100)}</w:t></w:p><w:p><w:t>Unneeded</w:t></w:p></w:document>`,
    },
    expected: ["A".repeat(32), "[Extracted text truncated at document extraction limits.]"],
    absent: ["Unneeded"],
  },
  {
    ext: "pptx",
    bounded: true,
    parts: {
      "ppt/presentation.xml":
        '<p:presentation><p:sldIdLst><p:sldId r:id="a"/><p:sldId r:id="missing"/></p:sldIdLst></p:presentation>',
      "ppt/_rels/presentation.xml.rels":
        '<Relationships><Relationship Id="a" Target="slides/slide.xml"/></Relationships>',
      "ppt/slides/slide.xml": `<p:sld><a:p><a:t>${"A".repeat(1_000_100)}</a:t></a:p></p:sld>`,
    },
    expected: [
      "## Slide 1",
      "A".repeat(32),
      "[Extracted text truncated at document extraction limits.]",
    ],
    absent: ["## Slide 2"],
  },
  {
    ext: "epub",
    bounded: true,
    parts: {
      "META-INF/container.xml": '<container><rootfile full-path="book.opf"/></container>',
      "book.opf":
        '<package><item id="a" href="a.xhtml"/><itemref idref="a"/><itemref idref="missing"/></package>',
      "a.xhtml": `<html><body><p>${"A".repeat(1_000_100)}</p></body></html>`,
    },
    expected: [
      "## Chapter 1",
      "A".repeat(32),
      "[Extracted text truncated at document extraction limits.]",
    ],
    absent: ["## Chapter 2"],
  },
  {
    ext: "epub",
    parts: {
      "META-INF/container.xml":
        '<container><rootfile full-path="OEBPS/book.opf"/></container>',
      "OEBPS/book.opf":
        '<package><manifest><item id="a" href="a.xhtml"/><item id="b" href="b.xhtml"/></manifest><spine><itemref idref="b"/><itemref idref="a"/></spine></package>',
      "OEBPS/a.xhtml":
        '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html><body><p>Last chapter</p><p>Price <s>10</s> 8 <del>old</del></p></body></html>',
      "OEBPS/b.xhtml":
        '<!DOCTYPE html><html><head><title>My Novel</title><meta name="author" content="Hidden Author"/></head><body><h1>First chapter</h1><p>Larkspur</p><div>Direct div<section>Direct section<li>Direct item <em>emphasis</em> trailing</li></section></div><div>Account: A<br/>Balance: 731<line-break/>Currency: USD</div><table><thead><tr><th>Heading</th><th>Total</th></tr></thead><tbody><tr><td>Important value</td><td>731</td></tr><tr><td>Before<table><tr><td>Inner</td></tr></table>After</td><td>Neighbor</td></tr></tbody></table></body></html>',
    },
    expected: [
      "## Chapter 1",
      "\n# First chapter",
      "Larkspur",
      "Direct div",
      "Direct section",
      "Direct item emphasis trailing",
      "Account: A\nBalance: 731\nCurrency: USD",
      "Heading\tTotal",
      "Important value\t731",
      "Before Inner After\tNeighbor",
      "## Chapter 2",
      "Last chapter",
      "Price 10 8 old",
    ],
    absent: ["My Novel", "Hidden Author"],
  },
];

export const T3_DOCUMENT_STRUCTURE_CASES = t3DocumentStructureCases.filter(
  ({ ext }) => ext !== "xlsx",
);
