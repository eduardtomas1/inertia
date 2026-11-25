import {
  DocumentExtractionError,
  DocumentExtractionTruncation,
  MAX_DOCUMENT_RTF_DEPTH,
} from "./document-text-errors.js";

const FONT_CODE_PAGES = new Map<number, string>([
  [77, "macintosh"],
  [161, "windows-1253"],
  [162, "windows-1254"],
  [163, "windows-1258"],
  [177, "windows-1255"],
  [178, "windows-1256"],
  [186, "windows-1257"],
  [204, "windows-1251"],
  [222, "windows-874"],
  [238, "windows-1250"],
]);

const SKIPPED_DESTINATIONS = new Set([
  "fonttbl",
  "colortbl",
  "stylesheet",
  "info",
  "pict",
  "object",
  "fldinst",
  "header",
  "headerf",
  "headerl",
  "headerr",
  "footer",
  "footerf",
  "footerl",
  "footerr",
]);

const BREAK_CONTROLS = new Set(["par", "line", "sect", "page", "column"]);

const RTF_SYMBOLS = new Map<string, string>([
  ["endash", "\u2013"],
  ["emdash", "\u2014"],
  ["enspace", "\u2002"],
  ["emspace", "\u2003"],
  ["qmspace", "\u2005"],
  ["lquote", "\u2018"],
  ["rquote", "\u2019"],
  ["ldblquote", "\u201c"],
  ["rdblquote", "\u201d"],
  ["bullet", "\u2022"],
  ["zwj", "\u200d"],
  ["zwnj", "\u200c"],
  ["ltrmark", "\u200e"],
  ["rtlmark", "\u200f"],
  ["~", "\u00a0"],
  ["_", "\u2011"],
  ["-", ""],
]);

interface RtfGroupState {
  skip: boolean;
  deleted: boolean;
  hiddenText: boolean;
  uc: number;
  font: number;
  fontTable: boolean;
  decoder: TextDecoder;
}

const MAX_RTF_FONTS = 4_096;
const CACHED_DECODERS = new Map<string, TextDecoder>();

function cachedDecoder(label: string, fatal = false): TextDecoder {
  const key = `${label}:${fatal ? "1" : "0"}`;
  let decoder = CACHED_DECODERS.get(key);
  if (!decoder) {
    decoder = new TextDecoder(label, { fatal });
    CACHED_DECODERS.set(key, decoder);
  }
  return decoder;
}

function ansiCodePageLabel(codePage: number): string | undefined {
  if (codePage === 0) return "windows-1252";
  if (codePage === 866) return "ibm866";
  if (codePage === 874 || (codePage >= 1250 && codePage <= 1258)) {
    return `windows-${codePage}`;
  }
  return undefined;
}

export function* extractRtfParts(source: string): Generator<string, void> {
  if (!source.startsWith("{\\rtf")) {
    throw new DocumentExtractionError("content");
  }
  let state: RtfGroupState = {
    skip: false,
    deleted: false,
    hiddenText: false,
    uc: 1,
    font: 0,
    fontTable: false,
    decoder: cachedDecoder("windows-1252"),
  };
  const stack: RtfGroupState[] = [];
  const fonts = new Map<number, TextDecoder>();
  let defaultFont = 0;
  let fallbackCount = 0;

  const activeDecoder = (): TextDecoder => fonts.get(state.font) ?? state.decoder;
  const isHidden = (): boolean => state.skip || state.deleted || state.hiddenText;

  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index]!;
    if (ch === "{" || ch === "}") fallbackCount = 0;
    if (ch === "{") {
      stack.push({ ...state });
      if (stack.length > MAX_DOCUMENT_RTF_DEPTH) {
        throw new DocumentExtractionTruncation("RTF depth limit");
      }
      continue;
    }
    if (ch === "}") {
      state = stack.pop() ?? state;
      continue;
    }
    if (ch === "\\") {
      const lookahead = source.slice(index + 1, index + 80);
      const hexMatch = /^'([0-9a-f]{2})/iu.exec(lookahead);
      if (hexMatch) {
        if (fallbackCount > 0) {
          fallbackCount -= 1;
        } else if (!isHidden()) {
          yield activeDecoder().decode(Uint8Array.of(Number.parseInt(hexMatch[1]!, 16)));
        }
        index += 3;
        continue;
      }
      const wordMatch = /^([a-z]+)(-?\d+)? ?/iu.exec(lookahead);
      if (wordMatch) {
        index += wordMatch[0].length;
        const control = wordMatch[1]!;
        const value = wordMatch[2] === undefined ? Number.NaN : Number(wordMatch[2]);
        if (control === "bin") {
          if (!Number.isSafeInteger(value) || value < 0) {
            throw new DocumentExtractionError("document-corrupt");
          }
          index += value;
        }
        if (fallbackCount > 0) {
          fallbackCount -= 1;
          continue;
        }
        if (SKIPPED_DESTINATIONS.has(control)) {
          state.skip = true;
        }
        if (control === "fonttbl") {
          state.fontTable = true;
        } else if (control === "deff" && Number.isSafeInteger(value)) {
          defaultFont = value;
          state.font = value;
        } else if (control === "f" && Number.isSafeInteger(value)) {
          state.font = value;
          if (state.fontTable) fonts.delete(value);
        } else if (control === "fcharset" && state.fontTable && Number.isSafeInteger(value)) {
          const charsetLabel = FONT_CODE_PAGES.get(value);
          if (charsetLabel && (fonts.has(state.font) || fonts.size < MAX_RTF_FONTS)) {
            fonts.set(state.font, cachedDecoder(charsetLabel));
          }
        }

        if (control === "deleted") {
          state.deleted = value !== 0;
        } else if (control === "v") {
          state.hiddenText = value !== 0;
        } else if (control === "plain") {
          state.deleted = false;
          state.hiddenText = false;
          state.font = defaultFont;
        }

        if (control === "mac" || (control === "ansicpg" && value === 10000)) {
          state.decoder = cachedDecoder("macintosh");
        } else if (control === "ansicpg") {
          const label = Number.isSafeInteger(value) ? ansiCodePageLabel(value) : undefined;
          if (!label) {
            throw new DocumentExtractionError("document-corrupt");
          }
          state.decoder = cachedDecoder(label, true);
        } else if (control === "uc") {
          if (!Number.isSafeInteger(value) || value < 0) {
            throw new DocumentExtractionError("document-corrupt");
          }
          state.uc = value;
        } else if (control === "u" && Number.isSafeInteger(value)) {
          if (!isHidden()) {
            yield String.fromCharCode(value < 0 ? value + 65536 : value);
          }
          fallbackCount = state.uc;
        } else if (!isHidden() && BREAK_CONTROLS.has(control)) {
          yield "\n";
        } else if (!isHidden() && control === "tab") {
          yield "\t";
        } else if (!state.skip && control === "row") {
          yield "\n";
        } else if (!state.skip && control === "cell") {
          yield "\t";
        } else if (!isHidden() && RTF_SYMBOLS.has(control)) {
          yield RTF_SYMBOLS.get(control)!;
        }
        continue;
      }
      index += 1;
      const escaped = lookahead[0];
      if (fallbackCount > 0) {
        fallbackCount -= 1;
      } else if (escaped === "*") {
        state.skip = true;
      } else if (!isHidden() && (escaped === "\n" || escaped === "\r")) {
        yield "\n";
      } else if (!isHidden() && (escaped === "\\" || escaped === "{" || escaped === "}")) {
        yield escaped;
      } else if (!isHidden() && escaped !== undefined && RTF_SYMBOLS.has(escaped)) {
        yield RTF_SYMBOLS.get(escaped)!;
      }
      continue;
    }
    if (ch !== "\n" && ch !== "\r") {
      if (fallbackCount > 0) {
        fallbackCount -= 1;
      } else if (!isHidden()) {
        const code = ch.charCodeAt(0);
        yield code < 128 ? ch : activeDecoder().decode(Uint8Array.of(code));
      }
    }
  }
}
