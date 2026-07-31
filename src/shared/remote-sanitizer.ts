const SECRET_PATTERNS = [
  /\b(?:sk|rk|pk|api|key|token)[-_][A-Za-z0-9_-]{12,}\b/giu,
  /\b(?:ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/giu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
  /\b(Bearer|Basic)\s+\S+/giu,
] as const;

const CREDENTIAL_URL =
  /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s?#]*@/giu;
const DIRECTIONAL_FORMATTING =
  /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]+/gu;
const CONTENT_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/gu;
const SECRET_SCAN_MARGIN_CHARACTERS = 4 * 1024;
const TRAILING_SECRET_FRAGMENT =
  /(?:\b(?:sk|rk|pk|api|key|token)[-_][A-Za-z0-9_-]*|\beyJ[A-Za-z0-9_.-]*|\b(?:Bearer|Basic)\s+\S*)$/iu;
const MAX_REMOTE_CONTENT_CHARACTERS = 64 * 1024;
const CODE_OMISSION = "[Code omitted on Remote Companion]";
const HTML_OMISSION = "[HTML omitted on Remote Companion]";
const REMOTE_HTML_TAGS = new Set([
  "a", "abbr", "acronym", "address", "applet", "area", "article", "aside",
  "audio", "b", "base", "basefont", "bdi", "bdo", "bgsound", "big", "blink",
  "blockquote", "body", "br", "button", "canvas", "caption", "center", "cite",
  "code", "col", "colgroup", "data", "datalist", "dd", "del", "details",
  "dfn", "dialog", "dir", "div", "dl", "dt", "em", "embed", "fieldset",
  "figcaption", "figure", "font", "footer", "form", "frame", "frameset", "h1",
  "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup", "hr", "html",
  "i", "iframe", "img", "input", "ins", "kbd", "keygen", "label", "legend",
  "li", "link", "main", "map", "mark", "marquee", "math", "menu", "meta",
  "meter", "nav", "nobr", "noembed", "noframes", "noscript", "object", "ol",
  "optgroup", "option", "output", "p", "param", "picture", "plaintext", "pre",
  "progress", "q", "rb", "rp", "rt", "rtc", "ruby", "s", "samp", "script",
  "search", "section", "select", "slot", "small", "source", "spacer", "span",
  "strike", "strong", "style", "sub", "summary", "sup", "svg", "table",
  "tbody", "td", "template", "textarea", "tfoot", "th", "thead", "time",
  "title", "tr", "track", "tt", "u", "ul", "var", "video", "wbr", "xmp",
]);
const REMOTE_VOID_HTML_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);

interface RemoteLine {
  contentEnd: number;
  nextStart: number;
}

interface RemoteCodeFence {
  character: "`" | "~";
  length: number;
}

interface RemoteHtmlTag {
  name: string;
  closing: boolean;
  complete: boolean;
  selfClosing: boolean;
  hasAttributes: boolean;
  end: number;
}

interface RemoteHtmlOpening {
  name: string;
  start: number;
  likelyHtml: boolean;
}

function remoteOutputLimit(maximumCharacters: number): number {
  return Math.min(
    Math.max(0, maximumCharacters),
    MAX_REMOTE_CONTENT_CHARACTERS,
  );
}

export function remoteSanitizerInspectionWindow(
  value: string,
  maximumCharacters = MAX_REMOTE_CONTENT_CHARACTERS,
): string {
  return value.slice(
    0,
    remoteOutputLimit(maximumCharacters) + SECRET_SCAN_MARGIN_CHARACTERS,
  );
}

/**
 * Remote Companion deliberately omits code/source blocks, absolute paths,
 * credentials, and URL user-info. The result is still untrusted text and the
 * web client must render it through its strict Markdown allowlist.
 */
export function sanitizeRemoteContent(
  value: string,
  maximumCharacters = MAX_REMOTE_CONTENT_CHARACTERS,
): string {
  const outputLimit = remoteOutputLimit(maximumCharacters);
  let text = redactRemoteHtmlBlocks(
    redactRemoteCodeBlocks(
      remoteSanitizerInspectionWindow(value, maximumCharacters)
        .replace(CONTENT_CONTROL_CHARACTERS, " ")
        .replace(DIRECTIONAL_FORMATTING, " "),
    ),
  )
    .replace(CREDENTIAL_URL, "$1<redacted>@");
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match) =>
      /^(Bearer|Basic)\s/iu.test(match)
        ? `${match.split(/\s/u)[0]} <redacted>`
        : "<redacted-secret>");
  }
  text = redactAbsolutePathTokens(text);
  if (text.length <= outputLimit) return text;
  return text.slice(0, outputLimit).replace(TRAILING_SECRET_FRAGMENT, "");
}

// The input is capped before this scanner runs. It visits each line and fence
// character monotonically, including when a provider is interrupted before a
// closing fence arrives.
function redactRemoteCodeBlocks(value: string): string {
  let result = "";
  let copiedUntil = 0;
  let lineStart = 0;
  while (lineStart < value.length) {
    const line = remoteLineAt(value, lineStart);
    const fence = remoteCodeFenceAt(value, lineStart, line.contentEnd);
    if (fence) {
      const redactedEnd = remoteFenceBlockEnd(
        value,
        line.nextStart,
        fence,
      );
      result += value.slice(copiedUntil, lineStart);
      result += CODE_OMISSION;
      copiedUntil = redactedEnd;
      lineStart = redactedEnd;
      continue;
    }
    if (isIndentedRemoteCodeLine(value, lineStart, line.contentEnd)) {
      const redactedEnd = remoteIndentedBlockEnd(value, line);
      result += value.slice(copiedUntil, lineStart);
      result += CODE_OMISSION;
      copiedUntil = redactedEnd;
      lineStart = redactedEnd;
      continue;
    }
    lineStart = line.nextStart;
  }
  return `${result}${value.slice(copiedUntil)}`;
}

function remoteFenceBlockEnd(
  value: string,
  start: number,
  fence: RemoteCodeFence,
): number {
  let lineStart = start;
  while (lineStart < value.length) {
    const line = remoteLineAt(value, lineStart);
    if (isRemoteFenceClose(
      value,
      lineStart,
      line.contentEnd,
      fence,
    )) return line.contentEnd;
    lineStart = line.nextStart;
  }
  return value.length;
}

function remoteIndentedBlockEnd(
  value: string,
  firstLine: RemoteLine,
): number {
  let redactedEnd = firstLine.contentEnd;
  let lineStart = firstLine.nextStart;
  while (lineStart < value.length) {
    const line = remoteLineAt(value, lineStart);
    if (isIndentedRemoteCodeLine(value, lineStart, line.contentEnd)) {
      redactedEnd = line.contentEnd;
      lineStart = line.nextStart;
      continue;
    }
    if (isBlankRemoteLine(value, lineStart, line.contentEnd)) {
      let nextContentStart = line.nextStart;
      while (nextContentStart < value.length) {
        const next = remoteLineAt(value, nextContentStart);
        if (!isBlankRemoteLine(
          value,
          nextContentStart,
          next.contentEnd,
        )) break;
        nextContentStart = next.nextStart;
      }
      if (nextContentStart < value.length) {
        const next = remoteLineAt(value, nextContentStart);
        if (isIndentedRemoteCodeLine(
          value,
          nextContentStart,
          next.contentEnd,
        )) {
          lineStart = nextContentStart;
          continue;
        }
      }
    }
    break;
  }
  return redactedEnd;
}

function remoteCodeFenceAt(
  value: string,
  start: number,
  end: number,
): RemoteCodeFence | null {
  const markerStart = remoteFenceMarkerStart(value, start, end);
  if (markerStart === null) return null;
  const character = value[markerStart];
  if (character !== "`" && character !== "~") return null;
  const markerEnd = scanRemoteFenceRun(value, markerStart, end, character);
  const length = markerEnd - markerStart;
  if (length < 3) return null;
  return { character, length };
}

function isRemoteFenceClose(
  value: string,
  start: number,
  end: number,
  fence: RemoteCodeFence,
): boolean {
  const markerStart = remoteFenceMarkerStart(value, start, end);
  if (markerStart === null || value[markerStart] !== fence.character) {
    return false;
  }
  const markerEnd = scanRemoteFenceRun(
    value,
    markerStart,
    end,
    fence.character,
  );
  if (markerEnd - markerStart < fence.length) return false;
  for (let cursor = markerEnd; cursor < end; cursor += 1) {
    if (value[cursor] !== " " && value[cursor] !== "\t") return false;
  }
  return true;
}

function remoteContainerContentStart(
  value: string,
  start: number,
  end: number,
): number {
  let cursor = start;
  for (let depth = 0; depth < 8; depth += 1) {
    let probe = cursor;
    while (probe < end && probe - cursor < 3 && value[probe] === " ") {
      probe += 1;
    }
    if (probe >= end || value[probe] !== ">") break;
    cursor = probe + 1;
    if (cursor < end && value[cursor] === " ") cursor += 1;
  }
  return remoteListMarkerEnd(value, cursor, end) ?? cursor;
}

function remoteListMarkerEnd(
  value: string,
  start: number,
  end: number,
): number | null {
  let cursor = start;
  while (cursor < end && cursor - start < 3 && value[cursor] === " ") {
    cursor += 1;
  }
  const character = value[cursor];
  if (character === "-" || character === "*" || character === "+") {
    cursor += 1;
  } else {
    const digits = scanAsciiDigits(value, cursor, end);
    if (
      digits === cursor
      || digits - cursor > 9
      || (value[digits] !== "." && value[digits] !== ")")
    ) return null;
    cursor = digits + 1;
  }
  if (cursor >= end || value[cursor] !== " ") return null;
  return cursor + 1;
}

function remoteFenceMarkerStart(
  value: string,
  start: number,
  end: number,
): number | null {
  const contentStart = remoteContainerContentStart(value, start, end);
  let cursor = contentStart;
  while (cursor < end && cursor - contentStart < 4 && value[cursor] === " ") {
    cursor += 1;
  }
  return cursor - contentStart <= 3 ? cursor : null;
}

function scanRemoteFenceRun(
  value: string,
  start: number,
  end: number,
  character: "`" | "~",
): number {
  let cursor = start;
  while (cursor < end && value[cursor] === character) cursor += 1;
  return cursor;
}

function isIndentedRemoteCodeLine(
  value: string,
  start: number,
  end: number,
): boolean {
  if (isBlankRemoteLine(value, start, end)) return false;
  const contentStart = remoteContainerContentStart(value, start, end);
  if (isBlankRemoteLine(value, contentStart, end)) return false;
  if (value[contentStart] === "\t") return true;
  return end - contentStart >= 4
    && value[contentStart] === " "
    && value[contentStart + 1] === " "
    && value[contentStart + 2] === " "
    && value[contentStart + 3] === " ";
}

function isBlankRemoteLine(
  value: string,
  start: number,
  end: number,
): boolean {
  for (let cursor = start; cursor < end; cursor += 1) {
    if (value[cursor] !== " " && value[cursor] !== "\t") return false;
  }
  return true;
}

function remoteLineAt(value: string, start: number): RemoteLine {
  let contentEnd = start;
  while (
    contentEnd < value.length
    && value[contentEnd] !== "\n"
    && value[contentEnd] !== "\r"
  ) contentEnd += 1;
  let nextStart = contentEnd;
  if (value[nextStart] === "\r") nextStart += 1;
  if (value[nextStart] === "\n") nextStart += 1;
  return { contentEnd, nextStart };
}

// HTML ranges are discovered in one bounded token pass. A fixed-size start
// table avoids nested-regex behavior and lets the second pass replace
// disjoint/nested ranges monotonically.
function redactRemoteHtmlBlocks(value: string): string {
  if (!value.includes("<")) return value;
  const redactionEnds = new Uint32Array(value.length + 1);
  const openings: RemoteHtmlOpening[] = [];
  let index = 0;
  while (index < value.length) {
    if (value[index] !== "<") {
      index += 1;
      continue;
    }
    const specialEnd = remoteSpecialHtmlEndAt(value, index);
    if (specialEnd !== null) {
      redactionEnds[index] = specialEnd;
      index = specialEnd;
      continue;
    }
    const tag = remoteHtmlTagAt(value, index);
    if (!tag) {
      index += 1;
      continue;
    }
    const known = REMOTE_HTML_TAGS.has(tag.name);
    const likelyHtml = known || tag.hasAttributes;
    if (!tag.complete) {
      if (likelyHtml) redactionEnds[index] = value.length;
      break;
    }
    if (tag.closing) {
      const opening = openings.at(-1);
      if (opening?.name === tag.name) {
        openings.pop();
        redactionEnds[opening.start] = tag.end;
      } else if (known) {
        redactionEnds[index] = tag.end;
      }
      index = tag.end;
      continue;
    }
    if (tag.selfClosing || REMOTE_VOID_HTML_TAGS.has(tag.name)) {
      if (likelyHtml || tag.selfClosing) redactionEnds[index] = tag.end;
      index = tag.end;
      continue;
    }
    openings.push({ name: tag.name, start: index, likelyHtml });
    index = tag.end;
  }
  for (const opening of openings) {
    if (opening.likelyHtml) redactionEnds[opening.start] = value.length;
  }

  let result = "";
  let copiedUntil = 0;
  index = 0;
  while (index < value.length) {
    const redactionEnd = redactionEnds[index] ?? 0;
    if (redactionEnd <= index) {
      index += 1;
      continue;
    }
    result += value.slice(copiedUntil, index);
    result += HTML_OMISSION;
    copiedUntil = redactionEnd;
    index = redactionEnd;
  }
  return `${result}${value.slice(copiedUntil)}`;
}

function remoteSpecialHtmlEndAt(
  value: string,
  start: number,
): number | null {
  if (value.startsWith("<!--", start)) {
    const close = value.indexOf("-->", start + 4);
    return close < 0 ? value.length : close + 3;
  }
  if (value.startsWith("<?", start)) {
    const close = value.indexOf("?>", start + 2);
    return close < 0 ? value.length : close + 2;
  }
  const declaration = value.slice(start, start + 10).toLowerCase();
  if (
    !declaration.startsWith("<!doctype")
    && !value.startsWith("<![CDATA[", start)
  ) return null;
  const terminator = value.startsWith("<![CDATA[", start) ? "]]>" : ">";
  const close = value.indexOf(terminator, start + 2);
  return close < 0 ? value.length : close + terminator.length;
}

function remoteHtmlTagAt(
  value: string,
  start: number,
): RemoteHtmlTag | null {
  let cursor = start + 1;
  const closing = value[cursor] === "/";
  if (closing) cursor += 1;
  if (!isAsciiLetter(value[cursor])) return null;
  const nameStart = cursor;
  cursor += 1;
  while (
    cursor < value.length
    && (
      isAsciiLetter(value[cursor])
      || isAsciiDigit(value[cursor])
      || value[cursor] === "-"
    )
  ) cursor += 1;
  const name = value.slice(nameStart, cursor).toLowerCase();
  if (
    cursor < value.length
    && value[cursor] !== ">"
    && value[cursor] !== "/"
    && !isHtmlWhitespace(value[cursor])
  ) return null;
  const attributeStart = cursor;
  let quote: "'" | "\"" | null = null;
  while (cursor < value.length) {
    const character = value[cursor];
    if (quote) {
      if (character === quote) quote = null;
      cursor += 1;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      cursor += 1;
      continue;
    }
    if (character === "<") return null;
    if (character === ">") {
      let suffix = cursor - 1;
      while (suffix >= attributeStart && isHtmlWhitespace(value[suffix])) {
        suffix -= 1;
      }
      if (closing) {
        for (let check = attributeStart; check < cursor; check += 1) {
          if (!isHtmlWhitespace(value[check])) return null;
        }
      }
      return {
        name,
        closing,
        complete: true,
        selfClosing: !closing && value[suffix] === "/",
        hasAttributes: hasRemoteHtmlAttributes(
          value,
          attributeStart,
          cursor,
        ),
        end: cursor + 1,
      };
    }
    cursor += 1;
  }
  return {
    name,
    closing,
    complete: false,
    selfClosing: false,
    hasAttributes: hasRemoteHtmlAttributes(
      value,
      attributeStart,
      value.length,
    ),
    end: value.length,
  };
}

function hasRemoteHtmlAttributes(
  value: string,
  start: number,
  end: number,
): boolean {
  for (let cursor = start; cursor < end; cursor += 1) {
    if (
      !isHtmlWhitespace(value[cursor])
      && value[cursor] !== "/"
    ) return true;
  }
  return false;
}

function isHtmlWhitespace(value: string | undefined): boolean {
  return value === " "
    || value === "\t"
    || value === "\n"
    || value === "\r"
    || value === "\f";
}

// Projection schemas cap this input at 64 KiB. The scanner advances
// monotonically through that bounded text and never backtracks across tokens.
function redactAbsolutePathTokens(value: string): string {
  let result = "";
  let copiedUntil = 0;
  let index = 0;
  while (index < value.length) {
    const webUrlEnd = webUrlEndAt(value, index);
    if (webUrlEnd !== null) {
      index = webUrlEnd;
      continue;
    }
    const fileUrlEnd = fileUrlEndAt(value, index);
    if (fileUrlEnd !== null) {
      const suffix = trailingPathSuffix(
        value,
        index + "file://".length,
        fileUrlEnd,
      );
      result += value.slice(copiedUntil, index);
      result += `file://<local-path>${value.slice(suffix.start, fileUrlEnd)}`;
      copiedUntil = fileUrlEnd;
      index = fileUrlEnd;
      continue;
    }
    const path = absolutePathTokenAt(value, index);
    if (path === null) {
      index += 1;
      continue;
    }
    if (path.pathEnd === null) {
      index = path.tokenEnd;
      continue;
    }
    result += value.slice(copiedUntil, index);
    result += `<local-path>${value.slice(path.pathEnd, path.tokenEnd)}`;
    copiedUntil = path.tokenEnd;
    index = path.tokenEnd;
  }
  return `${result}${value.slice(copiedUntil)}`;
}

function webUrlEndAt(value: string, index: number): number | null {
  if (!isSchemeBoundary(value, index)) return null;
  for (const scheme of ["https://", "http://", "wss://", "ws://"]) {
    if (value.slice(index, index + scheme.length).toLowerCase() === scheme) {
      return scanPathTokenEnd(value, index + scheme.length);
    }
  }
  return null;
}

function fileUrlEndAt(value: string, index: number): number | null {
  if (
    !isSchemeBoundary(value, index)
    || value.slice(index, index + "file://".length).toLowerCase() !== "file://"
  ) return null;
  return scanPathTokenEnd(value, index + "file://".length);
}

function absolutePathTokenAt(
  value: string,
  index: number,
): { pathEnd: number | null; tokenEnd: number } | null {
  if (
    !isPathBoundary(value, index)
    || !isPlausibleAbsolutePathPrefix(value, index)
  ) return null;
  const tokenEnd = scanPathTokenEnd(value, index);
  if (!isAbsolutePathToken(value, index, tokenEnd)) {
    return { pathEnd: null, tokenEnd };
  }
  const suffix = trailingPathSuffix(value, index, tokenEnd);
  let pathEnd = tokenEnd;
  if (
    suffix.start < tokenEnd
    && isAbsolutePathToken(value, index, suffix.start)
    && (
      suffix.enclosingDelimiter
      || hasAbsolutePathContent(value, index, suffix.start)
    )
  ) {
    pathEnd = suffix.start;
  } else if (
    isStrongTrailingDelimiter(value[tokenEnd - 1])
    && isAbsolutePathToken(value, index, tokenEnd - 1)
  ) {
    pathEnd = tokenEnd - 1;
  }
  return { pathEnd, tokenEnd };
}

function isPlausibleAbsolutePathPrefix(
  value: string,
  start: number,
): boolean {
  return value[start] === "/"
    || value[start] === "\\"
    || (
      isAsciiLetter(value[start])
      && value[start + 1] === ":"
      && isWindowsSeparator(value[start + 2])
    );
}

function isAbsolutePathToken(
  value: string,
  start: number,
  end: number,
): boolean {
  return isPosixAbsoluteToken(value, start, end)
    || isWindowsDriveAbsoluteToken(value, start, end)
    || isWindowsUncOrDeviceToken(value, start, end)
    || isWindowsRootedAbsoluteToken(value, start, end);
}

function isPosixAbsoluteToken(
  value: string,
  start: number,
  end: number,
): boolean {
  return end > start && value[start] === "/";
}

function isWindowsDriveAbsoluteToken(
  value: string,
  start: number,
  end: number,
): boolean {
  return end >= start + 3
    && isAsciiLetter(value[start])
    && value[start + 1] === ":"
    && isWindowsSeparator(value[start + 2]);
}

function isWindowsUncOrDeviceToken(
  value: string,
  start: number,
  end: number,
): boolean {
  if (
    value[start] !== "\\"
    || value[start + 1] !== "\\"
    || isKnownRegexEscapeToken(value, start, end)
  ) return false;
  let cursor = consumeWindowsSeparators(value, start, end);
  if (
    (value[cursor] === "?" || value[cursor] === ".")
    && isWindowsSeparator(value[cursor + 1])
  ) {
    cursor = consumeWindowsSeparators(value, cursor + 1, end);
    return cursor < end;
  }
  const serverEnd = scanWindowsSegmentEnd(value, cursor, end);
  if (serverEnd === cursor || serverEnd === end) return false;
  cursor = consumeWindowsSeparators(value, serverEnd, end);
  const shareEnd = scanWindowsSegmentEnd(value, cursor, end);
  return shareEnd > cursor;
}

function isWindowsRootedAbsoluteToken(
  value: string,
  start: number,
  end: number,
): boolean {
  if (
    value[start] !== "\\"
    || isKnownRegexEscapeToken(value, start, end)
  ) return false;
  const cursor = consumeWindowsSeparators(value, start, end);
  return cursor < end;
}

function isKnownRegexEscapeToken(
  value: string,
  start: number,
  end: number,
): boolean {
  while (
    end > start
    && isTrailingSentencePunctuation(value[end - 1])
  ) end -= 1;
  let cursor = start;
  let sawCharacterClass = false;
  while (cursor < end) {
    if (value[cursor] !== "\\") return false;
    while (cursor < end && value[cursor] === "\\") cursor += 1;
    if (cursor === end) return !sawCharacterClass;
    if (!"dDsSwWbB".includes(value[cursor])) return false;
    sawCharacterClass = true;
    cursor += 1;
    if ("+*?".includes(value[cursor] ?? "")) {
      cursor += 1;
      continue;
    }
    if (value[cursor] !== "{") continue;
    cursor += 1;
    const minimumEnd = scanAsciiDigits(value, cursor, end);
    if (minimumEnd === cursor) return false;
    cursor = minimumEnd;
    if (value[cursor] === ",") {
      cursor = scanAsciiDigits(value, cursor + 1, end);
    }
    if (value[cursor] !== "}") return false;
    cursor += 1;
  }
  return sawCharacterClass;
}

function scanAsciiDigits(
  value: string,
  start: number,
  end: number,
): number {
  let cursor = start;
  while (
    cursor < end
    && value.charCodeAt(cursor) >= 48
    && value.charCodeAt(cursor) <= 57
  ) cursor += 1;
  return cursor;
}

function hasAbsolutePathContent(
  value: string,
  start: number,
  end: number,
): boolean {
  let cursor = start;
  if (
    isAsciiLetter(value[start])
    && value[start + 1] === ":"
  ) cursor += 2;
  cursor = consumeWindowsSeparators(value, cursor, end);
  return cursor < end;
}

function scanPathTokenEnd(value: string, start: number): number {
  let cursor = start;
  while (cursor < value.length && !isPathTokenTerminator(value[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function scanWindowsSegmentEnd(
  value: string,
  start: number,
  end: number,
): number {
  let cursor = start;
  while (cursor < end && !isWindowsSeparator(value[cursor])) cursor += 1;
  return cursor;
}

function consumeWindowsSeparators(
  value: string,
  start: number,
  end: number,
): number {
  let cursor = start;
  while (cursor < end && isWindowsSeparator(value[cursor])) cursor += 1;
  return cursor;
}

function trailingPathSuffix(
  value: string,
  start: number,
  end: number,
): { enclosingDelimiter: boolean; start: number } {
  let punctuationStart = end;
  while (
    punctuationStart > start
    && isTrailingSentencePunctuation(value[punctuationStart - 1])
  ) punctuationStart -= 1;
  if (
    end - punctuationStart > 1
    && isStrongTrailingDelimiter(value[end - 1])
  ) {
    return { enclosingDelimiter: false, start: end - 1 };
  }

  const possibleCloser = punctuationStart - 1;
  if (
    possibleCloser >= start
    && isUnmatchedClosingDelimiter(value, start, possibleCloser)
  ) return { enclosingDelimiter: true, start: possibleCloser };

  const sourceSuffix = /(?::\d+){1,2}$/u.exec(
    value.slice(start, punctuationStart),
  );
  if (sourceSuffix?.index !== undefined && sourceSuffix.index > 1) {
    return {
      enclosingDelimiter: false,
      start: start + sourceSuffix.index,
    };
  }
  if (punctuationStart > start + 1 && value[punctuationStart - 1] === ":") {
    return { enclosingDelimiter: false, start: punctuationStart - 1 };
  }
  return { enclosingDelimiter: false, start: punctuationStart };
}

function isUnmatchedClosingDelimiter(
  value: string,
  start: number,
  closerIndex: number,
): boolean {
  const closer = value[closerIndex];
  const opener = closer === ")" ? "(" : closer === "]" ? "[" : closer === "}"
    ? "{"
    : null;
  if (opener === null) return false;
  let balance = 0;
  for (let index = start; index <= closerIndex; index += 1) {
    if (value[index] === opener) balance += 1;
    else if (value[index] === closer) balance -= 1;
  }
  return balance < 0;
}

function isPathBoundary(value: string, index: number): boolean {
  if (index === 0) return true;
  const previous = value[index - 1];
  if (
    isPathWordLikeAt(value, index - 1)
    || previous === "/"
    || previous === "\\"
    || isMatchedPathSegmentCloser(value, index - 1)
  ) return false;
  if (
    (value[index] === "/" || value[index] === "\\")
    && previous === "."
    && isRelativeDotPrefix(value, index)
  ) return false;
  return true;
}

function isMatchedPathSegmentCloser(
  value: string,
  closerIndex: number,
): boolean {
  const closer = value[closerIndex];
  if (closer !== ")" && closer !== "]" && closer !== "}") return false;
  let segmentStart = closerIndex;
  while (
    segmentStart > 0
    && !isPathTokenTerminator(value[segmentStart - 1])
    && value[segmentStart - 1] !== "/"
    && value[segmentStart - 1] !== "\\"
  ) segmentStart -= 1;
  return !isUnmatchedClosingDelimiter(value, segmentStart, closerIndex);
}

function isRelativeDotPrefix(value: string, separatorIndex: number): boolean {
  let cursor = separatorIndex - 1;
  while (cursor >= 0 && value[cursor] === ".") cursor -= 1;
  return cursor < 0 || !isPathTokenCharacterAt(value, cursor);
}

function isPathTokenCharacterAt(value: string, index: number): boolean {
  return isPathWordLikeAt(value, index)
    || value[index] === "/"
    || value[index] === "\\";
}

function isSchemeBoundary(value: string, index: number): boolean {
  return index === 0 || !/[A-Za-z0-9+.-]/u.test(value[index - 1]);
}

function isPathTokenTerminator(value: string | undefined): boolean {
  return value === undefined || /[\s"'`<>]/u.test(value);
}

function isTrailingSentencePunctuation(value: string | undefined): boolean {
  return value !== undefined && /[.,;!?]/u.test(value);
}

function isStrongTrailingDelimiter(value: string | undefined): boolean {
  return value === "," || value === ";";
}

function isWindowsSeparator(value: string | undefined): boolean {
  return value === "\\" || value === "/";
}

function isAsciiLetter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z]/u.test(value);
}

function isAsciiDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

function isPathWordLikeAt(value: string, index: number): boolean {
  if (index < 0 || index >= value.length) return false;
  let start = index;
  let end = index + 1;
  const codeUnit = value.charCodeAt(index);
  if (
    codeUnit >= 0xdc00
    && codeUnit <= 0xdfff
    && index > 0
    && value.charCodeAt(index - 1) >= 0xd800
    && value.charCodeAt(index - 1) <= 0xdbff
  ) start -= 1;
  else if (
    codeUnit >= 0xd800
    && codeUnit <= 0xdbff
    && index + 1 < value.length
    && value.charCodeAt(index + 1) >= 0xdc00
    && value.charCodeAt(index + 1) <= 0xdfff
  ) end += 1;
  const character = value.slice(start, end);
  return character === "_" || /[\p{L}\p{N}\p{M}]/u.test(character);
}

export function sanitizeRemoteLabel(
  value: string | null | undefined,
  maximumCharacters = 240,
): string | null {
  if (typeof value !== "string") return null;
  const text = sanitizeRemoteContent(
    value.normalize("NFKC"),
    maximumCharacters,
  )
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(DIRECTIONAL_FORMATTING, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return text || null;
}
