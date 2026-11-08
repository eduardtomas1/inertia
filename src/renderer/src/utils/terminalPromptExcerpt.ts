export const MAX_TERMINAL_PROMPT_LINES = 200;
export const MAX_TERMINAL_PROMPT_BYTES = 8 * 1_024;
const MAX_LABEL_LENGTH = 60;

const encoder = new TextEncoder();
const utf8Bytes = (value: string): number => encoder.encode(value).byteLength;

const ESC = 0x1b;
const BEL = 0x07;
const C1_CSI = 0x9b;

function skipCsi(value: string, index: number): number {
  let cursor = index;
  while (cursor < value.length) {
    const code = value.charCodeAt(cursor);
    cursor += 1;
    if (code >= 0x40 && code <= 0x7e) break;
  }
  return cursor;
}

function skipOsc(value: string, index: number): number {
  let cursor = index;
  while (cursor < value.length) {
    const code = value.charCodeAt(cursor);
    if (code === BEL) return cursor + 1;
    if (code === ESC && value[cursor + 1] === "\\") return cursor + 2;
    cursor += 1;
  }
  return cursor;
}

/**
 * xterm's getSelection() returns cell text, which is already free of escape
 * sequences. Strip CSI, OSC and two-byte escapes anyway so the excerpt stays
 * plain even if a future selection source includes raw output.
 */
function withoutEscapeSequences(value: string): string {
  let result = "";
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === C1_CSI) {
      index = skipCsi(value, index + 1);
    } else if (code === ESC && value[index + 1] === "[") {
      index = skipCsi(value, index + 2);
    } else if (code === ESC && value[index + 1] === "]") {
      index = skipOsc(value, index + 2);
    } else if (code === ESC) {
      index += 2;
    } else {
      result += value[index];
      index += 1;
    }
  }
  return result;
}

function isControlCharacter(character: string): boolean {
  const code = character.codePointAt(0)!;
  return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

function withoutControlCharacters(value: string): string {
  let result = "";
  for (const character of value) {
    if (character === "\n" || character === "\t" || !isControlCharacter(character)) result += character;
  }
  return result;
}

function plainTerminalText(selection: string): string {
  const lines = withoutControlCharacters(
    withoutEscapeSequences(selection).replace(/\r\n?/gu, "\n"),
  ).split("\n").map((line) => line.trimEnd());
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

function tailWithinBytes(value: string, bytes: number): string {
  const characters = [...value];
  let used = 0;
  let start = characters.length;
  while (start > 0) {
    const size = utf8Bytes(characters[start - 1]!);
    if (used + size > bytes) break;
    used += size;
    start -= 1;
  }
  return characters.slice(start).join("");
}

function promptLabel(label: string | undefined): string {
  const plain = [...(label ?? "")]
    .map((character) => (isControlCharacter(character) ? " " : character))
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  return [...plain].slice(0, MAX_LABEL_LENGTH).join("") || "Terminal";
}

function fenceFor(body: string): string {
  let longest = 0;
  for (const run of body.matchAll(/`+/gu)) longest = Math.max(longest, run[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

export interface TerminalPromptExcerpt {
  text: string;
  includedLines: number;
  totalLines: number;
  trimmed: boolean;
}

/**
 * Formats a terminal selection for the composer: a one-line header and a
 * fenced block that no backtick run in the output can close. The most recent
 * lines are kept when the selection exceeds 200 lines or 8 KiB.
 */
export function terminalPromptExcerpt(
  selection: string,
  label?: string,
): TerminalPromptExcerpt | null {
  const plain = plainTerminalText(selection);
  if (!plain.trim()) return null;
  const lines = plain.split("\n");
  const totalLines = lines.length;
  let kept = lines.slice(-MAX_TERMINAL_PROMPT_LINES);
  // Each line is measured once; dropping the oldest line also drops the
  // newline that joined it to the next one.
  const sizes = kept.map(utf8Bytes);
  let bytes = sizes.reduce((total, size) => total + size, kept.length - 1);
  let first = 0;
  while (kept.length - first > 1 && bytes > MAX_TERMINAL_PROMPT_BYTES) {
    bytes -= sizes[first]! + 1;
    first += 1;
  }
  kept = kept.slice(first);
  let lineShortened = false;
  if (bytes > MAX_TERMINAL_PROMPT_BYTES) {
    kept = [tailWithinBytes(kept[0]!, MAX_TERMINAL_PROMPT_BYTES)];
    lineShortened = true;
  }
  const trimmed = lineShortened || kept.length < totalLines;
  const name = promptLabel(label);
  const detail = lineShortened
    ? `${name}, last ${MAX_TERMINAL_PROMPT_BYTES / 1_024} KiB of ${totalLines === 1 ? "1 line" : `${totalLines} lines`}`
    : kept.length < totalLines
      ? `${name}, last ${kept.length} of ${totalLines} lines`
      : name;
  const body = kept.join("\n");
  const fence = fenceFor(body);
  return {
    text: `Terminal output (${detail}):\n${fence}text\n${body}\n${fence}`,
    includedLines: kept.length,
    totalLines,
    trimmed,
  };
}
