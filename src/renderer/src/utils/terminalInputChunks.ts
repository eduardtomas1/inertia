export const TERMINAL_INPUT_CHUNK_CODE_UNITS = 8_192;

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xD800 && codeUnit <= 0xDBFF;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xDC00 && codeUnit <= 0xDFFF;
}

/**
 * Keeps every payload within the UTF-16 protocol bound without separating a
 * valid surrogate pair across two runtime commands.
 */
export function terminalInputChunks(
  data: string,
  maximumCodeUnits = TERMINAL_INPUT_CHUNK_CODE_UNITS,
): string[] {
  if (!Number.isInteger(maximumCodeUnits) || maximumCodeUnits < 2) {
    throw new Error("Terminal input chunks require a bound of at least two code units.");
  }
  const chunks: string[] = [];
  let offset = 0;
  while (offset < data.length) {
    let end = Math.min(data.length, offset + maximumCodeUnits);
    if (
      end < data.length
      && isHighSurrogate(data.charCodeAt(end - 1))
      && isLowSurrogate(data.charCodeAt(end))
    ) {
      end -= 1;
    }
    chunks.push(data.slice(offset, end));
    offset = end;
  }
  return chunks;
}
