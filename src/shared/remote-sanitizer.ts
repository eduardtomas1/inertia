const SECRET_PATTERNS = [
  /\b(?:sk|rk|pk|api|key|token)[-_][A-Za-z0-9_-]{12,}\b/giu,
  /\b(?:ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/giu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
  /\b(Bearer|Basic)\s+\S+/giu,
] as const;

const CREDENTIAL_URL =
  /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^/\s@]+)@/giu;
const CODE_FENCE = /```[\s\S]*?```/gu;
const HTML_BLOCK = /<([A-Za-z][A-Za-z0-9-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gu;
const DIRECTIONAL_FORMATTING =
  /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f]+/gu;
const MAX_REMOTE_CONTENT_CHARACTERS = 64 * 1024;

/**
 * Remote Companion deliberately omits code/source blocks, absolute paths,
 * credentials, and URL user-info. The result is still untrusted text and the
 * web client must render it through its strict Markdown allowlist.
 */
export function sanitizeRemoteContent(
  value: string,
  maximumCharacters = 64 * 1024,
): string {
  let text = value
    .replace(CODE_FENCE, "[Code omitted on Remote Companion]")
    .replace(HTML_BLOCK, "[HTML omitted on Remote Companion]")
    .replace(CREDENTIAL_URL, "$1<redacted>@");
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match) =>
      /^(Bearer|Basic)\s/iu.test(match)
        ? `${match.split(/\s/u)[0]} <redacted>`
        : "<redacted-secret>");
  }
  const outputLimit = Math.min(
    Math.max(0, maximumCharacters),
    MAX_REMOTE_CONTENT_CHARACTERS,
  );
  return redactAbsolutePathTokens(text.slice(0, outputLimit))
    .slice(0, outputLimit);
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
): { pathEnd: number; tokenEnd: number } | null {
  if (
    !isPathBoundary(value, index)
    || !isPlausibleAbsolutePathPrefix(value, index)
  ) return null;
  const tokenEnd = scanPathTokenEnd(value, index);
  if (!isAbsolutePathToken(value, index, tokenEnd)) return null;
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
  return index === 0 || /[\s<("'`=[{>,;!?:-]/u.test(value[index - 1]);
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
