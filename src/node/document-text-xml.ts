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

const HTML4_ENTITY_CODE_POINTS: Readonly<Record<string, number>> = {
  nbsp: 160, iexcl: 161, cent: 162, pound: 163, curren: 164, yen: 165, brvbar: 166, sect: 167,
  uml: 168, copy: 169, ordf: 170, laquo: 171, not: 172, shy: 173, reg: 174, macr: 175,
  deg: 176, plusmn: 177, sup2: 178, sup3: 179, acute: 180, micro: 181, para: 182, middot: 183,
  cedil: 184, sup1: 185, ordm: 186, raquo: 187, frac14: 188, frac12: 189, frac34: 190, iquest: 191,
  Agrave: 192, Aacute: 193, Acirc: 194, Atilde: 195, Auml: 196, Aring: 197, AElig: 198, Ccedil: 199,
  Egrave: 200, Eacute: 201, Ecirc: 202, Euml: 203, Igrave: 204, Iacute: 205, Icirc: 206, Iuml: 207,
  ETH: 208, Ntilde: 209, Ograve: 210, Oacute: 211, Ocirc: 212, Otilde: 213, Ouml: 214, times: 215,
  Oslash: 216, Ugrave: 217, Uacute: 218, Ucirc: 219, Uuml: 220, Yacute: 221, THORN: 222, szlig: 223,
  agrave: 224, aacute: 225, acirc: 226, atilde: 227, auml: 228, aring: 229, aelig: 230, ccedil: 231,
  egrave: 232, eacute: 233, ecirc: 234, euml: 235, igrave: 236, iacute: 237, icirc: 238, iuml: 239,
  eth: 240, ntilde: 241, ograve: 242, oacute: 243, ocirc: 244, otilde: 245, ouml: 246, divide: 247,
  oslash: 248, ugrave: 249, uacute: 250, ucirc: 251, uuml: 252, yacute: 253, thorn: 254, yuml: 255,
  quot: 34, amp: 38, lt: 60, gt: 62, OElig: 338, oelig: 339, Scaron: 352, scaron: 353,
  Yuml: 376, circ: 710, tilde: 732, ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205,
  lrm: 8206, rlm: 8207, ndash: 8211, mdash: 8212, lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220,
  rdquo: 8221, bdquo: 8222, dagger: 8224, Dagger: 8225, permil: 8240, lsaquo: 8249, rsaquo: 8250, euro: 8364,
  fnof: 402, Alpha: 913, Beta: 914, Gamma: 915, Delta: 916, Epsilon: 917, Zeta: 918, Eta: 919,
  Theta: 920, Iota: 921, Kappa: 922, Lambda: 923, Mu: 924, Nu: 925, Xi: 926, Omicron: 927,
  Pi: 928, Rho: 929, Sigma: 931, Tau: 932, Upsilon: 933, Phi: 934, Chi: 935, Psi: 936,
  Omega: 937, alpha: 945, beta: 946, gamma: 947, delta: 948, epsilon: 949, zeta: 950, eta: 951,
  theta: 952, iota: 953, kappa: 954, lambda: 955, mu: 956, nu: 957, xi: 958, omicron: 959,
  pi: 960, rho: 961, sigmaf: 962, sigma: 963, tau: 964, upsilon: 965, phi: 966, chi: 967,
  psi: 968, omega: 969, thetasym: 977, upsih: 978, piv: 982, bull: 8226, hellip: 8230, prime: 8242,
  Prime: 8243, oline: 8254, frasl: 8260, weierp: 8472, image: 8465, real: 8476, trade: 8482, alefsym: 8501,
  larr: 8592, uarr: 8593, rarr: 8594, darr: 8595, harr: 8596, crarr: 8629, lArr: 8656, uArr: 8657,
  rArr: 8658, dArr: 8659, hArr: 8660, forall: 8704, part: 8706, exist: 8707, empty: 8709, nabla: 8711,
  isin: 8712, notin: 8713, ni: 8715, prod: 8719, sum: 8721, minus: 8722, lowast: 8727, radic: 8730,
  prop: 8733, infin: 8734, ang: 8736, and: 8743, or: 8744, cap: 8745, cup: 8746, int: 8747,
  there4: 8756, sim: 8764, cong: 8773, asymp: 8776, ne: 8800, equiv: 8801, le: 8804, ge: 8805,
  sub: 8834, sup: 8835, nsub: 8836, sube: 8838, supe: 8839, oplus: 8853, otimes: 8855, perp: 8869,
  sdot: 8901, lceil: 8968, rceil: 8969, lfloor: 8970, rfloor: 8971, lang: 9001, rang: 9002, loz: 9674,
  spades: 9824, clubs: 9827, hearts: 9829, diams: 9830,
};

const EPUB_NAMED_ENTITIES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(HTML4_ENTITY_CODE_POINTS).map(([name, codePoint]) => [name, String.fromCodePoint(codePoint)])),
  ...BASE_XML_ENTITIES,
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
