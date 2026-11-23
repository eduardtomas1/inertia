import {
  DocumentExtractionError,
  DocumentExtractionTruncation,
  MAX_DOCUMENT_XML_DEPTH,
  MAX_DOCUMENT_XML_NODES,
} from "./document-text-errors.js";

export interface XmlElementNode {
  readonly name: string;
  readonly attrs: Record<string, string>;
  children: Array<XmlElementNode | string>;
  spaceCount?: number;
  hasText?: boolean;
  hasTextChoice?: boolean;
}

export const HIDDEN_XML_ELEMENTS: ReadonlySet<string> = new Set([
  "head",
  "script",
  "style",
  "binary-data",
  "rPh",
  "delText",
  "moveFrom",
  "instrText",
  "delInstrText",
  "tracked-changes",
  "pPr",
  "positionH",
  "positionV",
  "sizeRelH",
  "sizeRelV",
  "fldData",
  "table-of-content-source",
  "illustration-index-source",
  "table-index-source",
  "object-index-source",
  "user-index-source",
  "alphabetical-index-source",
  "bibliography-source",
]);

const BASE_XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const EPUB_NAMED_ENTITIES: Readonly<Record<string, string>> = {
  ...BASE_XML_ENTITIES,
  nbsp: "\u00a0",
  iexcl: "\u00a1",
  cent: "\u00a2",
  pound: "\u00a3",
  curren: "\u00a4",
  yen: "\u00a5",
  brvbar: "\u00a6",
  sect: "\u00a7",
  uml: "\u00a8",
  copy: "\u00a9",
  ordf: "\u00aa",
  laquo: "\u00ab",
  not: "\u00ac",
  shy: "\u00ad",
  reg: "\u00ae",
  macr: "\u00af",
  deg: "\u00b0",
  plusmn: "\u00b1",
  sup2: "\u00b2",
  sup3: "\u00b3",
  acute: "\u00b4",
  micro: "\u00b5",
  para: "\u00b6",
  middot: "\u00b7",
  cedil: "\u00b8",
  sup1: "\u00b9",
  ordm: "\u00ba",
  raquo: "\u00bb",
  frac14: "\u00bc",
  frac12: "\u00bd",
  frac34: "\u00be",
  iquest: "\u00bf",
  times: "\u00d7",
  divide: "\u00f7",
  ensp: "\u2002",
  emsp: "\u2003",
  thinsp: "\u2009",
  zwnj: "\u200c",
  zwj: "\u200d",
  lrm: "\u200e",
  rlm: "\u200f",
  ndash: "\u2013",
  mdash: "\u2014",
  lsquo: "\u2018",
  rsquo: "\u2019",
  sbquo: "\u201a",
  ldquo: "\u201c",
  rdquo: "\u201d",
  bdquo: "\u201e",
  dagger: "\u2020",
  Dagger: "\u2021",
  bull: "\u2022",
  hellip: "\u2026",
  permil: "\u2030",
  prime: "\u2032",
  Prime: "\u2033",
  lsaquo: "\u2039",
  rsaquo: "\u203a",
  euro: "\u20ac",
  trade: "\u2122",
  larr: "\u2190",
  uarr: "\u2191",
  rarr: "\u2192",
  darr: "\u2193",
  harr: "\u2194",
  minus: "\u2212",
  infin: "\u221e",
  ne: "\u2260",
  le: "\u2264",
  ge: "\u2265",
  NotEqualTilde: "\u2242\u0338",
  CounterClockwiseContourIntegral: "\u2233",
};

export function xmlElementChildren(node: XmlElementNode | undefined): XmlElementNode[] {
  if (!node) return [];
  return node.children.filter((child): child is XmlElementNode => typeof child !== "string");
}

export function parseRepeatCount(value: string | undefined): number {
  if (value === undefined) return 1;
  if (!/^[0-9]+$/u.test(value)) {
    throw new DocumentExtractionError("document-corrupt");
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new DocumentExtractionError("document-corrupt");
  }
  return count;
}

function decodeEntities(raw: string, allowHtmlEntities: boolean): string {
  if (!raw.includes("&")) return raw;
  const entities = allowHtmlEntities ? EPUB_NAMED_ENTITIES : BASE_XML_ENTITIES;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9._:-]*);/gu, (match, token: string) => {
    if (token.startsWith("#x") || token.startsWith("#X")) {
      const codePoint = Number.parseInt(token.slice(2), 16);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        throw new Error("Invalid numeric character reference");
      }
      return String.fromCodePoint(codePoint);
    }
    if (token.startsWith("#")) {
      const codePoint = Number.parseInt(token.slice(1), 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        throw new Error("Invalid numeric character reference");
      }
      return String.fromCodePoint(codePoint);
    }
    if (Object.hasOwn(entities, token)) {
      return entities[token]!;
    }
    if (allowHtmlEntities) return match;
    throw new Error(`Unknown XML entity: ${token}`);
  });
}

function collapseOdfWhitespace(paragraph: XmlElementNode): void {
  let afterSpace = true;
  let tail: { node: XmlElementNode; index: number; value: string } | undefined;
  const visit = (node: XmlElementNode): void => {
    for (let index = 0; index < node.children.length; index += 1) {
      const child = node.children[index]!;
      if (typeof child !== "string") {
        if (HIDDEN_XML_ELEMENTS.has(child.name)) continue;
        if (
          child.spaceCount === undefined
          && child.name !== "tab"
          && child.name !== "line-break"
          && child.name !== "p"
          && child.name !== "h"
        ) {
          visit(child);
        } else {
          afterSpace = false;
          tail = undefined;
        }
        continue;
      }
      let value = child.replace(/[ \t\r\n]+/gu, " ");
      if (afterSpace && value.startsWith(" ")) value = value.slice(1);
      if (value) {
        afterSpace = value.endsWith(" ");
        tail = { node, index, value };
      }
      node.children[index] = value;
    }
  };
  visit(paragraph);
  if (tail && afterSpace) {
    tail.node.children[tail.index] = tail.value.slice(0, -1);
  }
}

function hasInlineTab(node: XmlElementNode, names: readonly string[]): boolean {
  return (
    !HIDDEN_XML_ELEMENTS.has(node.name)
    && (
      names.includes(node.name)
      || xmlElementChildren(node).some((child) => hasInlineTab(child, names))
    )
  );
}

function retainCompatibilityFallback(parent: XmlElementNode, fallback: XmlElementNode): boolean {
  if (parent.hasTextChoice) {
    parent.children.pop();
    return false;
  }
  if (fallback.hasText || hasInlineTab(fallback, ["tab", "ptab"])) {
    parent.children = parent.children.filter(
      (child) =>
        typeof child === "string"
        || child.name !== "Choice"
        || !hasInlineTab(child, ["ptab"]),
    );
  }
  return true;
}

function isHiddenDocxRun(node: XmlElementNode): boolean {
  return xmlElementChildren(node)
    .flatMap((child) => (child.name === "rPr" ? xmlElementChildren(child) : []))
    .some((prop) => {
      if (prop.name !== "vanish") return false;
      const val = prop.attrs.val ?? "1";
      return val === "true" || val === "1" || val === "on";
    });
}

function isWhitespaceCode(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function isNameCharCode(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || (code >= 0x30 && code <= 0x39)
    || code === 0x5f
    || code === 0x2d
    || code === 0x2e
    || code === 0x3a
    || code >= 0x80
  );
}

export function parseDocumentXml(source: string, extension: string): XmlElementNode {
  const isOdf = extension === ".odt" || extension === ".ods" || extension === ".odp";
  const isEpub = extension === ".epub";
  const root: XmlElementNode = { name: "root", attrs: {}, children: [] };
  const stack: XmlElementNode[] = [root];
  const rawNameStack: string[] = ["root"];
  let nodeCount = 0;

  const pushText = (value: string): void => {
    if (!value) return;
    const current = stack[stack.length - 1]!;
    current.children.push(value);
    if (value.trim() !== "") current.hasText = true;
  };

  const closeCurrent = (closingRawName?: string): void => {
    if (stack.length <= 1) {
      throw new Error("Unexpected closing XML tag");
    }
    const expectedRawName = rawNameStack.pop()!;
    if (closingRawName !== undefined && closingRawName !== expectedRawName) {
      throw new Error(`Mismatched XML tag: expected ${expectedRawName}, got ${closingRawName}`);
    }
    const node = stack.pop()!;
    const parent = stack[stack.length - 1]!;
    if (isOdf && (node.name === "p" || node.name === "h")) {
      collapseOdfWhitespace(node);
    }
    if (
      (extension === ".docx" && node.name === "del")
      || (extension === ".docx" && node.name === "r" && isHiddenDocxRun(node))
      || (isOdf && node.name === "annotation" && parent.name !== "semantics")
      || (
        extension === ".odp"
        && node.name === "page-thumbnail"
        && stack.some((ancestor) => ancestor.name === "notes")
      )
    ) {
      parent.children.pop();
      return;
    }
    if (node.name === "Fallback" && !retainCompatibilityFallback(parent, node)) return;
    if (HIDDEN_XML_ELEMENTS.has(node.name) || (!node.hasText && node.name !== "noBreakHyphen")) return;
    parent.hasText = true;
    if (node.name === "Choice") parent.hasTextChoice = true;
  };

  const input = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const length = input.length;
  let cursor = 0;

  while (cursor < length) {
    const lt = input.indexOf("<", cursor);
    if (lt < 0) {
      pushText(decodeEntities(input.slice(cursor), isEpub));
      break;
    }
    if (lt > cursor) {
      pushText(decodeEntities(input.slice(cursor, lt), isEpub));
    }
    if (lt + 1 >= length) {
      throw new Error("Truncated XML tag");
    }
    const next = input[lt + 1]!;
    if (next === "!") {
      if (input.startsWith("<!--", lt)) {
        const end = input.indexOf("-->", lt + 4);
        if (end < 0) throw new Error("Unterminated XML comment");
        cursor = end + 3;
        continue;
      }
      if (input.startsWith("<![CDATA[", lt)) {
        const end = input.indexOf("]]>", lt + 9);
        if (end < 0) throw new Error("Unterminated CDATA section");
        pushText(input.slice(lt + 9, end));
        cursor = end + 3;
        continue;
      }
      const declarationPrefix = input.slice(lt, lt + 16).toUpperCase();
      if (declarationPrefix.startsWith("<!ENTITY")) {
        throw new DocumentExtractionError("document-corrupt");
      }
      if (declarationPrefix.startsWith("<!DOCTYPE")) {
        const gt = input.indexOf(">", lt + 9);
        if (gt < 0) throw new DocumentExtractionError("document-corrupt");
        const header = input.slice(lt, gt + 1);
        if (!isEpub || header.includes("[") || /<!ENTITY/iu.test(header)) {
          throw new DocumentExtractionError("document-corrupt");
        }
        cursor = gt + 1;
        continue;
      }
      throw new DocumentExtractionError("document-corrupt");
    }
    if (next === "?") {
      const end = input.indexOf("?>", lt + 2);
      if (end < 0) throw new Error("Unterminated XML processing instruction");
      cursor = end + 2;
      continue;
    }
    if (next === "/") {
      let nameEnd = lt + 2;
      while (nameEnd < length && isNameCharCode(input.charCodeAt(nameEnd))) {
        nameEnd += 1;
      }
      if (nameEnd === lt + 2) throw new Error("Empty closing XML tag");
      const rawName = input.slice(lt + 2, nameEnd);
      let scan = nameEnd;
      while (scan < length && isWhitespaceCode(input.charCodeAt(scan))) scan += 1;
      if (scan >= length || input[scan] !== ">") {
        throw new Error("Malformed closing XML tag");
      }
      closeCurrent(rawName);
      cursor = scan + 1;
      continue;
    }
    let nameEnd = lt + 1;
    while (nameEnd < length && isNameCharCode(input.charCodeAt(nameEnd))) {
      nameEnd += 1;
    }
    if (nameEnd === lt + 1) throw new Error("Malformed opening XML tag");
    const rawName = input.slice(lt + 1, nameEnd);
    const localName = rawName.includes(":") ? rawName.slice(rawName.lastIndexOf(":") + 1) : rawName;
    const attrs: Record<string, string> = {};
    let scan = nameEnd;
    let selfClosing = false;
    while (scan < length) {
      while (scan < length && isWhitespaceCode(input.charCodeAt(scan))) scan += 1;
      if (scan >= length) throw new Error("Unterminated opening XML tag");
      const ch = input[scan]!;
      if (ch === ">") {
        scan += 1;
        break;
      }
      if (ch === "/") {
        if (input[scan + 1] !== ">") throw new Error("Malformed self-closing XML tag");
        selfClosing = true;
        scan += 2;
        break;
      }
      const attrStart = scan;
      while (scan < length && isNameCharCode(input.charCodeAt(scan))) scan += 1;
      if (scan === attrStart) throw new Error("Malformed XML attribute name");
      const attrName = input.slice(attrStart, scan);
      while (scan < length && isWhitespaceCode(input.charCodeAt(scan))) scan += 1;
      if (input[scan] !== "=") throw new Error("Expected '=' in XML attribute");
      scan += 1;
      while (scan < length && isWhitespaceCode(input.charCodeAt(scan))) scan += 1;
      const quote = input[scan];
      if (quote !== '"' && quote !== "'") throw new Error("Unquoted XML attribute value");
      scan += 1;
      const valueStart = scan;
      const valueEnd = input.indexOf(quote, valueStart);
      if (valueEnd < 0) throw new Error("Unterminated XML attribute value");
      const attrValue = decodeEntities(input.slice(valueStart, valueEnd), isEpub);
      attrs[attrName] = attrValue;
      const shortAttr = attrName.includes(":") ? attrName.slice(attrName.lastIndexOf(":") + 1) : attrName;
      attrs[shortAttr] = attrValue;
      scan = valueEnd + 1;
    }
    nodeCount += 1;
    if (nodeCount > MAX_DOCUMENT_XML_NODES || stack.length > MAX_DOCUMENT_XML_DEPTH) {
      throw new DocumentExtractionTruncation("XML structure limit");
    }
    const node: XmlElementNode = {
      name: localName,
      attrs,
      children: [],
    };
    if (isOdf && localName === "s") {
      node.spaceCount = parseRepeatCount(attrs.c);
    }
    stack[stack.length - 1]!.children.push(node);
    stack.push(node);
    rawNameStack.push(rawName);
    if (selfClosing) {
      closeCurrent(rawName);
    }
    cursor = scan;
  }

  if (stack.length !== 1) {
    throw new Error("Unclosed XML element");
  }
  return root;
}
