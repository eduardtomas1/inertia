import { posix } from "node:path";
import { stripVTControlCharacters } from "node:util";

import {
  MAX_ATTACHMENT_BYTES,
  type ExtractedDocumentAttachmentMimeType,
} from "../shared/attachments.js";
import {
  DOCUMENT_TEXT_TRUNCATED_NOTICE,
  DocumentExtractionError,
  DocumentExtractionTruncation,
  MAX_DOCUMENT_NOTEBOOK_CELLS,
  MAX_DOCUMENT_TABLE_COLUMNS,
  MAX_DOCUMENT_TABLE_ROWS,
  MAX_DOCUMENT_TEXT_OUTPUT_CHARS,
  MAX_DOCUMENT_XML_NODES,
} from "./document-text-errors.js";
import { extractRtfParts } from "./document-text-rtf.js";
import {
  HIDDEN_XML_ELEMENTS,
  parseDocumentXml,
  parseRepeatCount,
  xmlElementChildren,
  type XmlElementNode,
} from "./document-text-xml.js";
import { readBoundedDocumentArchive } from "./document-text-zip.js";

const CELL_START = Symbol("cell-start");
const CELL_END = Symbol("cell-end");
type DocumentTextPart = string | typeof CELL_START | typeof CELL_END | { readonly fallback: string };

const NOTES_PLACEHOLDERS = new Set(["sldImg", "sldNum", "dt", "hdr", "ftr"]);
const NOTEBOOK_CELL_KINDS = ["code", "markdown", "raw"] as const;
const UNSAFE_CONTROL_CHARS = /[\0-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/gu;

export interface ExtractedStructuredDocument {
  readonly text: string;
  readonly truncated: boolean;
}

function* findAllElements(
  node: XmlElementNode,
  target: string | readonly string[],
): Generator<XmlElementNode, void> {
  for (const child of xmlElementChildren(node)) {
    const matched = typeof target === "string"
      ? child.name === target
      : target.includes(child.name);
    if (matched) yield child;
    else yield* findAllElements(child, target);
  }
}

function resolveSlideRelationshipId(
  slide: XmlElementNode,
  inheritedAttrs: Readonly<Record<string, string>>,
): string | undefined {
  for (const [key, value] of Object.entries(slide.attrs)) {
    if (!key.endsWith(":id")) continue;
    const binding = `xmlns:${key.slice(0, -3)}`;
    const namespace = slide.attrs[binding] ?? inheritedAttrs[binding];
    if (
      namespace === "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
      || namespace === "http://purl.oclc.org/ooxml/officeDocument/relationships"
    ) {
      return value;
    }
  }
  return slide.attrs["r:id"] ?? slide.attrs.id;
}

function isNotesPlaceholder(node: XmlElementNode): boolean {
  if (node.name !== "sp") return false;
  const placeholder = findAllElements(node, "ph").next().value;
  return NOTES_PLACEHOLDERS.has(placeholder?.attrs.type ?? "");
}

function stripNotesPlaceholders(node: XmlElementNode): XmlElementNode {
  return {
    ...node,
    children: node.children
      .filter((child) => typeof child === "string" || !isNotesPlaceholder(child))
      .map((child) => (typeof child === "string" ? child : stripNotesPlaceholders(child))),
  };
}

function odfCellFallbackValue(cell: XmlElementNode): string {
  const valueType = cell.attrs["office:value-type"] ?? cell.attrs["value-type"];
  const readAttr = (name: string): string => cell.attrs[`office:${name}`] ?? cell.attrs[name] ?? "";
  switch (valueType) {
    case "void":
      return "";
    case "string":
      return readAttr("string-value");
    case "boolean":
      return readAttr("boolean-value");
    case "date":
      return readAttr("date-value");
    case "time":
      return readAttr("time-value");
    case "currency": {
      const amount = readAttr("value");
      return amount.trim() ? `${amount} ${readAttr("currency")}`.trim() : "";
    }
    case "percentage": {
      const amount = readAttr("value");
      return amount.trim() ? `${amount} [ODF value-type=percentage]` : "";
    }
    default:
      return readAttr("value");
  }
}

function nodeHasCellContent(node: XmlElementNode): boolean {
  if (odfCellFallbackValue(node).trim() || node.name === "noBreakHyphen") return true;
  if (HIDDEN_XML_ELEMENTS.has(node.name) || node.spaceCount !== undefined) return false;
  return node.children.some((child) =>
    typeof child === "string" ? child.trim().length > 0 : nodeHasCellContent(child));
}

function* emitInlineText(node: XmlElementNode): Generator<DocumentTextPart, void> {
  if (HIDDEN_XML_ELEMENTS.has(node.name)) return;
  if (node.name === "txbxContent") {
    yield* emitParagraphs(node);
    return;
  }
  if (node.name === "tab" || node.name === "ptab" || node.name === "cell") {
    yield "\t";
    return;
  }
  if (node.name === "br" || node.name === "line-break" || node.name === "cr") {
    yield "\n";
    return;
  }
  if (node.name === "noBreakHyphen") {
    yield "\u2011";
    return;
  }
  if (node.spaceCount !== undefined) {
    yield " ".repeat(Math.min(MAX_DOCUMENT_TEXT_OUTPUT_CHARS, node.spaceCount));
    if (node.spaceCount > MAX_DOCUMENT_TEXT_OUTPUT_CHARS) {
      throw new DocumentExtractionTruncation("Space repeat limit");
    }
    return;
  }
  for (const child of node.children) {
    if (typeof child === "string") yield child;
    else yield* emitInlineText(child);
  }
}

function* emitTable(node: XmlElementNode): Generator<DocumentTextPart, void> {
  let rowCount = 0;
  for (const row of findAllElements(node, ["tr", "table-row"])) {
    const cells = [...findAllElements(row, ["tc", "table-cell", "covered-table-cell", "td", "th"])];
    while (cells.length > 0 && !nodeHasCellContent(cells[cells.length - 1]!)) {
      cells.pop();
    }
    if (cells.length === 0) continue;
    const rowRepeat = parseRepeatCount(row.attrs["number-rows-repeated"]);
    for (let rowIndex = 0; rowIndex < rowRepeat; rowIndex += 1) {
      rowCount += 1;
      if (rowCount > MAX_DOCUMENT_TABLE_ROWS) {
        throw new DocumentExtractionTruncation("Table row limit");
      }
      let column = 0;
      for (const cell of cells) {
        const colRepeat = parseRepeatCount(cell.attrs["number-columns-repeated"]);
        for (let colIndex = 0; colIndex < colRepeat; colIndex += 1) {
          if (column >= MAX_DOCUMENT_TABLE_COLUMNS) {
            throw new DocumentExtractionTruncation("Table column limit");
          }
          if (column > 0) yield "\t";
          column += 1;
          yield CELL_START;
          yield* emitParagraphs(cell);
          yield { fallback: odfCellFallbackValue(cell) };
          yield CELL_END;
        }
      }
      yield "\n";
    }
  }
}

function* emitParagraphs(node: XmlElementNode): Generator<DocumentTextPart, void> {
  if (HIDDEN_XML_ELEMENTS.has(node.name)) return;
  for (const child of node.children) {
    if (typeof child === "string") {
      yield child;
      continue;
    }
    if (child.name === "br" || child.name === "line-break" || child.name === "cr") {
      yield "\n";
      continue;
    }
    if (child.name === "tbl" || child.name === "table") {
      yield* emitTable(child);
      continue;
    }
    if (child.name === "p" || child.name === "h" || /^h[1-6]$/u.test(child.name)) {
      const style = findAllElements(child, "pStyle").next().value?.attrs.val ?? "";
      const headingLevel = child.name === "h"
        ? Number(child.attrs["outline-level"]) || 1
        : /^h[1-6]$/u.test(child.name)
          ? Number(child.name[1])
          : Number(/^Heading([1-6])$/iu.exec(style)?.[1]) || 0;
      if (headingLevel > 0) {
        yield `${"#".repeat(Math.min(6, headingLevel))} `;
      }
      yield* emitInlineText(child);
      yield "\n";
      continue;
    }
    yield* emitParagraphs(child);
    if (child.name === "li" || child.name === "div" || child.name === "section") {
      yield "\n";
    }
  }
}

function* emitNotebookLines(value: unknown): Generator<string, void> {
  if (typeof value === "string") {
    yield value;
  } else if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string") yield entry;
    }
  }
}

function cleanNotebookOutput(value: unknown): string {
  return stripVTControlCharacters([...emitNotebookLines(value)].join(""));
}

function* extractNotebookParts(bytes: Uint8Array): Generator<string, void> {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DocumentExtractionError("document-corrupt");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.replace(/^\uFEFF/u, ""));
  } catch {
    throw new DocumentExtractionError("document-corrupt");
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || !("cells" in parsed)
    || !Array.isArray((parsed as { cells?: unknown }).cells)
  ) {
    throw new DocumentExtractionError("content");
  }
  const cells = (parsed as { cells: unknown[] }).cells;
  for (let index = 0; index < cells.length; index += 1) {
    if (index >= MAX_DOCUMENT_NOTEBOOK_CELLS) {
      throw new DocumentExtractionTruncation("Notebook cell limit");
    }
    const cell = cells[index];
    if (!cell || typeof cell !== "object") continue;
    const rawType = "cell_type" in cell ? (cell as { cell_type?: unknown }).cell_type : undefined;
    const kind = NOTEBOOK_CELL_KINDS.find((candidate) => candidate === rawType) ?? "markdown";
    yield `## Cell ${index + 1} (${kind})\n`;
    if ("source" in cell) {
      yield* emitNotebookLines((cell as { source?: unknown }).source);
    }
    if ("outputs" in cell && Array.isArray((cell as { outputs?: unknown }).outputs)) {
      const outputs = (cell as { outputs: unknown[] }).outputs;
      yield "\nOutput:\n";
      for (const output of outputs) {
        if (!output || typeof output !== "object") continue;
        const record = output as Record<string, unknown>;
        if ("text" in record) {
          yield cleanNotebookOutput(record.text);
        } else if (
          record.data
          && typeof record.data === "object"
          && "text/plain" in (record.data as Record<string, unknown>)
        ) {
          yield cleanNotebookOutput((record.data as Record<string, unknown>)["text/plain"]);
        } else if (record.output_type === "error") {
          if ("ename" in record) yield* emitNotebookLines(record.ename);
          if ("evalue" in record) {
            yield ": ";
            yield* emitNotebookLines(record.evalue);
          }
          yield "\n";
          if ("traceback" in record) {
            for (const line of emitNotebookLines(record.traceback)) {
              yield stripVTControlCharacters(line);
              yield "\n";
            }
          }
        }
        yield "\n";
      }
    }
    yield "\n\n";
  }
}

function extensionForExtractedMime(mimeType: ExtractedDocumentAttachmentMimeType): string {
  switch (mimeType) {
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return ".docx";
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return ".pptx";
    case "application/rtf":
      return ".rtf";
    case "application/vnd.oasis.opendocument.text":
      return ".odt";
    case "application/vnd.oasis.opendocument.spreadsheet":
      return ".ods";
    case "application/vnd.oasis.opendocument.presentation":
      return ".odp";
    case "application/x-ipynb+json":
      return ".ipynb";
    case "application/epub+zip":
      return ".epub";
  }
}

function assertArchiveContainerMatches(
  files: ReadonlyMap<string, string>,
  mimeType: ExtractedDocumentAttachmentMimeType,
): void {
  const mimeEntry = files.get("mimetype")?.trim();
  if (mimeType === "application/epub+zip") {
    if (files.has("META-INF/encryption.xml")) {
      throw new DocumentExtractionError("document-encrypted");
    }
    if ((mimeEntry && mimeEntry !== "application/epub+zip") || !files.has("META-INF/container.xml")) {
      throw new DocumentExtractionError("content");
    }
    return;
  }
  if (
    mimeType === "application/vnd.oasis.opendocument.text"
    || mimeType === "application/vnd.oasis.opendocument.spreadsheet"
    || mimeType === "application/vnd.oasis.opendocument.presentation"
  ) {
    const manifest = files.get("META-INF/manifest.xml");
    if (manifest && /encryption-data/iu.test(manifest)) {
      throw new DocumentExtractionError("document-encrypted");
    }
    if ((mimeEntry && mimeEntry !== mimeType) || !files.has("content.xml")) {
      throw new DocumentExtractionError("content");
    }
    return;
  }
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    && !files.has("ppt/presentation.xml")
  ) {
    throw new DocumentExtractionError("content");
  }
}

function rootElement(root: XmlElementNode, name: string): XmlElementNode {
  const [element, ...rest] = xmlElementChildren(root);
  if (!element || rest.length > 0 || element.name !== name) {
    throw new DocumentExtractionError("content");
  }
  return element;
}

function* extractArchiveParts(
  bytes: Uint8Array,
  mimeType: ExtractedDocumentAttachmentMimeType,
  extension: string,
): Generator<DocumentTextPart, void> {
  const isOoxml = extension === ".docx" || extension === ".pptx";
  const files = readBoundedDocumentArchive(bytes, { allowOleEncryptedDetection: isOoxml });
  assertArchiveContainerMatches(files, mimeType);
  const nodeBudget = { remaining: MAX_DOCUMENT_XML_NODES };
  const notes: string[] = [];
  const markSkipped = (partName: string): void => {
    notes.push(`\n[Skipped document part: ${partName} (missing or invalid XML).]\n`);
  };
  const parsedXmlCache = new Map<
    string,
    { ok: true; node: XmlElementNode; nodesUsed: number } | { ok: false; error: unknown }
  >();
  const parseCachedXml = (partName: string, raw: string): XmlElementNode => {
    const cached = parsedXmlCache.get(partName);
    if (cached) {
      if (cached.ok) {
        nodeBudget.remaining -= cached.nodesUsed;
        if (nodeBudget.remaining < 0) throw new DocumentExtractionTruncation("xml-node-limit");
        return cached.node;
      }
      throw cached.error;
    }
    const beforeRemaining = nodeBudget.remaining;
    try {
      const node = parseDocumentXml(raw, extension, nodeBudget);
      const nodesUsed = Math.max(1, beforeRemaining - nodeBudget.remaining);
      parsedXmlCache.set(partName, { ok: true, node, nodesUsed });
      return node;
    } catch (error) {
      parsedXmlCache.set(partName, { ok: false, error });
      throw error;
    }
  };
  const readStrictXml = (partName: string): XmlElementNode => {
    const raw = files.get(partName);
    if (!raw) throw new DocumentExtractionError("content");
    try {
      return parseCachedXml(partName, raw);
    } catch (error) {
      if (error instanceof DocumentExtractionError || error instanceof DocumentExtractionTruncation) {
        throw error;
      }
      throw new DocumentExtractionError("document-corrupt");
    }
  };
  const readTolerantXml = (partName: string): XmlElementNode => {
    const raw = files.get(partName);
    if (!raw) {
      markSkipped(partName);
      return { name: "root", attrs: {}, children: [] };
    }
    try {
      return parseCachedXml(partName, raw);
    } catch (error) {
      if (error instanceof DocumentExtractionError || error instanceof DocumentExtractionTruncation) {
        throw error;
      }
      markSkipped(partName);
      return { name: "root", attrs: {}, children: [] };
    }
  };
  const readRelations = (partName: string): Map<string, Record<string, string>> =>
    new Map(
      [...findAllElements(readTolerantXml(partName), "Relationship")]
        .filter((rel) => rel.attrs.TargetMode !== "External")
        .map((rel) => [rel.attrs.Id ?? "", rel.attrs]),
    );

  if (extension === ".docx") {
    let target: string | undefined;
    if (files.has("_rels/.rels")) {
      const relsXml = readTolerantXml("_rels/.rels");
      target = [...findAllElements(relsXml, "Relationship")].find(
        (rel) => rel.attrs.Type?.endsWith("/officeDocument") && rel.attrs.TargetMode !== "External",
      )?.attrs.Target;
    }
    const normalized = target ? posix.normalize(target).replace(/^\//u, "") : undefined;
    const mainPath = normalized && files.has(normalized) ? normalized : "word/document.xml";
    if (!files.has(mainPath)) {
      throw new DocumentExtractionError("content");
    }
    const main = readStrictXml(mainPath);
    rootElement(main, "document");
    yield* emitParagraphs(main);
    yield* notes;
    return;
  }

  if (extension === ".odt" || extension === ".ods" || extension === ".odp") {
    const content = readStrictXml("content.xml");
    if (extension === ".odt") {
      yield* emitParagraphs(content);
      yield* notes;
      return;
    }
    let slideIndex = 0;
    for (const part of findAllElements(content, extension === ".ods" ? "table" : "page")) {
      if (extension === ".ods") {
        yield `\n\n## Sheet: ${part.attrs.name ?? "Untitled"}\n`;
        yield* emitTable(part);
        continue;
      }
      slideIndex += 1;
      yield `\n\n## Slide ${slideIndex}\n`;
      const notesNode = xmlElementChildren(part).find((child) => child.name === "notes");
      yield* emitParagraphs({
        ...part,
        children: part.children.filter((child) => child !== notesNode),
      });
      if (notesNode && nodeHasCellContent(notesNode)) {
        yield "\nNotes:\n";
        yield* emitParagraphs(notesNode);
      }
    }
    yield* notes;
    return;
  }

  if (extension === ".pptx") {
    const rels = readRelations("ppt/_rels/presentation.xml.rels");
    const presentation = rootElement(readStrictXml("ppt/presentation.xml"), "presentation");
    const slideList = xmlElementChildren(presentation).find((node) => node.name === "sldIdLst");
    const inheritedAttrs = { ...presentation?.attrs, ...slideList?.attrs };
    let slideIndex = 0;
    for (const slide of xmlElementChildren(slideList).filter((node) => node.name === "sldId")) {
      slideIndex += 1;
      yield `\n\n## Slide ${slideIndex}\n`;
      const relId = resolveSlideRelationshipId(slide, inheritedAttrs);
      const target = relId ? rels.get(relId)?.Target : undefined;
      if (!target) {
        markSkipped(`slide relationship ${slideIndex}`);
        continue;
      }
      const slidePath = target.startsWith("/")
        ? target.slice(1)
        : posix.normalize(`ppt/${target}`);
      yield* emitParagraphs(readTolerantXml(slidePath));
      const slideRelsPath = posix.join(
        posix.dirname(slidePath),
        "_rels",
        `${posix.basename(slidePath)}.rels`,
      );
      if (!files.has(slideRelsPath)) continue;
      const seenNotes = new Set<string>();
      for (const rel of findAllElements(readTolerantXml(slideRelsPath), "Relationship")) {
        const notesTarget = rel.attrs.Target;
        if (
          !rel.attrs.Type?.endsWith("/notesSlide")
          || rel.attrs.TargetMode === "External"
          || !notesTarget
        ) {
          continue;
        }
        const notesPath = notesTarget.startsWith("/")
          ? notesTarget.slice(1)
          : posix.join(posix.dirname(slidePath), notesTarget);
        if (seenNotes.has(notesPath)) continue;
        seenNotes.add(notesPath);
        const notesPage = stripNotesPlaceholders(readTolerantXml(notesPath));
        if (!nodeHasCellContent(notesPage)) continue;
        yield "Notes:\n";
        yield* emitParagraphs(notesPage);
      }
    }
    yield* notes;
    return;
  }

  if (extension === ".epub") {
    const container = readStrictXml("META-INF/container.xml");
    const rootfile = findAllElements(container, "rootfile").next().value?.attrs["full-path"];
    if (!rootfile || !files.has(rootfile)) {
      throw new DocumentExtractionError("document-corrupt");
    }
    const packageXml = readStrictXml(rootfile);
    const manifestItems = new Map<string, string>();
    for (const item of findAllElements(packageXml, "item")) {
      if (item.attrs.id && item.attrs.href) {
        manifestItems.set(item.attrs.id, item.attrs.href);
      }
    }
    let chapterIndex = 0;
    for (const itemref of findAllElements(packageXml, "itemref")) {
      chapterIndex += 1;
      yield `\n\n## Chapter ${chapterIndex}\n`;
      const href = itemref.attrs.idref ? manifestItems.get(itemref.attrs.idref) : undefined;
      if (!href) {
        markSkipped(`chapter ${chapterIndex}`);
        continue;
      }
      let decodedHref: string;
      try {
        decodedHref = decodeURIComponent(href.split("#")[0]!);
      } catch {
        markSkipped(`chapter ${chapterIndex}`);
        continue;
      }
      const chapterPath = posix.normalize(posix.join(posix.dirname(rootfile), decodedHref));
      yield* emitParagraphs(readTolerantXml(chapterPath));
    }
    yield* notes;
  }
}

export function extractStructuredDocumentText(
  bytes: Uint8Array,
  mimeType: ExtractedDocumentAttachmentMimeType,
): ExtractedStructuredDocument {
  if (bytes.byteLength < 1) {
    throw new DocumentExtractionError("document-empty");
  }
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new DocumentExtractionError("document-limit");
  }
  const extension = extensionForExtractedMime(mimeType);
  const parts: Iterable<DocumentTextPart> = extension === ".ipynb"
    ? extractNotebookParts(bytes)
    : extension === ".rtf"
      ? extractRtfParts(
          Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1"),
        )
      : extractArchiveParts(bytes, mimeType, extension);

  let output = "";
  let remaining = MAX_DOCUMENT_TEXT_OUTPUT_CHARS;
  let cellDepth = 0;
  let cellHasText = false;
  let pendingSpace = false;
  let truncated = false;

  try {
    for (const part of parts) {
      if (part === CELL_START) {
        if (cellDepth === 0) {
          cellHasText = false;
          pendingSpace = false;
        } else if (cellHasText) {
          pendingSpace = true;
        }
        cellDepth += 1;
        continue;
      }
      if (part === CELL_END) {
        cellDepth -= 1;
        if (cellDepth > 0 && cellHasText) pendingSpace = true;
        continue;
      }
      if (typeof part !== "string" && cellHasText) continue;
      const raw = typeof part === "string" ? part : part.fallback;
      const bounded = raw.slice(0, remaining).replace(UNSAFE_CONTROL_CHARS, "");
      remaining -= Math.min(raw.length, remaining);
      if (cellDepth > 0) {
        const normalized = bounded.replace(/\s+/gu, " ");
        const trimmed = normalized.trim();
        if (trimmed) {
          const prefix = cellHasText && (pendingSpace || normalized.startsWith(" ")) ? " " : "";
          output += prefix + trimmed;
          cellHasText = true;
        }
        pendingSpace = normalized.endsWith(" ") || (!normalized && pendingSpace);
      } else {
        output += bounded;
      }
      if (remaining === 0) {
        throw new DocumentExtractionTruncation("Output budget");
      }
    }
  } catch (error) {
    if (!(error instanceof DocumentExtractionTruncation)) throw error;
    truncated = true;
  }

  output = output.replace(/\r\n?/gu, "\n").replace(/\n(?:[ \t]*\n){2,}/gu, "\n\n").trim();
  if (!output) {
    throw new DocumentExtractionError(truncated ? "document-limit" : "document-empty");
  }
  if (truncated) {
    output = output.replace(/[\uD800-\uDBFF]$/u, "").trimEnd() + DOCUMENT_TEXT_TRUNCATED_NOTICE;
  }
  return { text: output, truncated };
}
