import type {
  IBufferCell,
  IBufferLine,
  IBufferRange,
  ILink,
  ILinkHandler,
  ILinkProvider,
  Terminal,
} from "@xterm/xterm";
import {
  MAX_TERMINAL_PATH_TEXT_LENGTH,
  type TerminalPathResolution,
} from "@shared/contracts/terminal-links";

/** Opens an http(s) link printed in the terminal through the main-process URL policy. */
export function openTerminalWebLink(event: MouseEvent | undefined, uri: string): void {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  event?.preventDefault();
  void window.inertia?.openExternal(url.href).catch(() => undefined);
}

/**
 * OSC 8 hyperlinks take the same route as detected web links. Without it xterm
 * would ask with `confirm()` and call `window.open`, which the window denies.
 */
export const TERMINAL_LINK_HANDLER: ILinkHandler = {
  activate: (event, uri) => openTerminalWebLink(event, uri),
  allowNonHttpProtocols: false,
};

export interface TerminalPathCandidate {
  /** The token, including any `:line[:column]` or `(line,column)` suffix. */
  text: string;
  /** Inclusive start and exclusive end indices in the scanned text. */
  start: number;
  end: number;
}

export const MAX_TERMINAL_PATH_CANDIDATE_LENGTH = 512;
export const MAX_TERMINAL_PATH_CANDIDATES_PER_LINE = 8;

const TOKEN = /[^\s"'`<>|[\]{}]+/gu;
const LEADING_PUNCTUATION = new Set(["(", "'", "\"", "[", "{", "<", "`"]);
const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", ")", "'", "\"", "]", "}", ">", "`"]);
const COMPILER_LOCATION = /\(\d{1,9}(?:,\d{1,9})?\)$/u;
const LOCATION = /(?::\d{1,9}(?::\d{1,9})?|\(\d{1,9}(?:,\d{1,9})?\))$/u;
const BARE_FILE_NAME = /^[\w.@+-]*[A-Za-z0-9_]\.[A-Za-z][A-Za-z0-9]{0,9}$/u;

function pathLike(token: string): boolean {
  if (token.length > MAX_TERMINAL_PATH_CANDIDATE_LENGTH) return false;
  if (token.includes("://") || token.startsWith("~") || token.startsWith("-")) return false;
  const path = token.replace(LOCATION, "");
  if (!/[\p{L}\p{N}_]/u.test(path)) return false;
  if (/^[A-Za-z]:[\\/]/u.test(path) || path.includes("/") || path.includes("\\")) {
    // Bare separators, `//` comments and `../`-only fragments are not files.
    return /[\p{L}\p{N}_]/u.test(path.replace(/^[A-Za-z]:/u, "")) && !path.startsWith("//");
  }
  return BARE_FILE_NAME.test(path);
}

/**
 * Finds conservative path-shaped tokens: anything with a separator or a
 * Windows drive, or a bare `name.ext`, with an optional location suffix.
 * Only the runtime decides whether a token names an existing workspace file.
 */
export function terminalPathCandidates(text: string): TerminalPathCandidate[] {
  const candidates: TerminalPathCandidate[] = [];
  for (const match of text.matchAll(TOKEN)) {
    let start = match.index;
    let end = start + match[0].length;
    while (start < end && LEADING_PUNCTUATION.has(text[start]!)) start += 1;
    while (end > start && TRAILING_PUNCTUATION.has(text[end - 1]!)) {
      if (text[end - 1] === ")" && COMPILER_LOCATION.test(text.slice(start, end))) break;
      end -= 1;
    }
    const token = text.slice(start, end);
    if (!token || !pathLike(token)) continue;
    candidates.push({ text: token, start, end });
  }
  return candidates;
}

export interface TerminalCellPosition {
  /** 1-based buffer column and row, as xterm link ranges expect. */
  x: number;
  y: number;
  width: number;
}

export interface TerminalLineText {
  text: string;
  /** The cell that produced each UTF-16 code unit of `text`. */
  cells: TerminalCellPosition[];
  /** The logical line starts before the scanned rows, so the first token may be cut. */
  cutAtStart?: boolean;
  /** The logical line continues after the scanned rows, so the last token may be cut. */
  cutAtEnd?: boolean;
}

const MAX_WRAPPED_ROWS = 16;

/** The part of xterm's buffer API that link detection reads. */
export interface TerminalLineSource {
  getLine(row: number): Pick<IBufferLine, "isWrapped" | "length" | "getCell"> | undefined;
  getNullCell(): IBufferCell;
}

/**
 * Reads the logical (soft-wrapped) line containing buffer row `row` (0-based),
 * keeping the cell position of every character so matches map back to the
 * terminal grid even with wide characters.
 */
export function readTerminalLine(
  buffer: TerminalLineSource,
  row: number,
  columns: number,
): TerminalLineText {
  let first = row;
  while (
    first > 0
    && row - first < MAX_WRAPPED_ROWS
    && buffer.getLine(first)?.isWrapped
  ) first -= 1;
  const cutAtStart = buffer.getLine(first)?.isWrapped === true;
  const cell: IBufferCell = buffer.getNullCell();
  let text = "";
  const cells: TerminalCellPosition[] = [];
  const last = first + MAX_WRAPPED_ROWS * 2;
  for (let current = first; current < last; current += 1) {
    const line = buffer.getLine(current);
    if (!line || (current > first && !line.isWrapped)) break;
    const width = Math.min(columns, line.length);
    for (let x = 0; x < width; x += 1) {
      if (!line.getCell(x, cell)) break;
      const cellWidth = cell.getWidth();
      if (cellWidth === 0) continue;
      const chars = cell.getChars() || " ";
      text += chars;
      for (let unit = 0; unit < chars.length; unit += 1) {
        cells.push({ x: x + 1, y: current + 1, width: cellWidth });
      }
    }
  }
  const cutAtEnd = buffer.getLine(last)?.isWrapped === true;
  return { text, cells, cutAtStart, cutAtEnd };
}

/**
 * Drops a token that touches a scan boundary inside a longer wrapped line: it
 * may be the tail or head of a longer token and name a different file.
 */
export function completeTerminalPathCandidates(line: TerminalLineText): TerminalPathCandidate[] {
  const candidates = terminalPathCandidates(line.text);
  const first = candidates[0];
  if (line.cutAtStart && first && !/\s/u.test(line.text.slice(0, first.start))) candidates.shift();
  const final = candidates.at(-1);
  if (line.cutAtEnd && final && !/\s/u.test(line.text.slice(final.end))) candidates.pop();
  return candidates;
}

export function terminalCandidateRange(
  line: TerminalLineText,
  candidate: TerminalPathCandidate,
): IBufferRange | null {
  const start = line.cells[candidate.start];
  const end = line.cells[candidate.end - 1];
  if (!start || !end) return null;
  return {
    start: { x: start.x, y: start.y },
    end: { x: end.x + end.width - 1, y: end.y },
  };
}

export interface TerminalPathResolver {
  resolve(text: string): Promise<TerminalPathResolution | null>;
  dispose(): void;
}

export interface TerminalPathResolverOptions {
  maxConcurrent?: number;
  maxQueued?: number;
  maxEntries?: number;
  resolvedTtlMs?: number;
  missingTtlMs?: number;
  now?: () => number;
}

export const TERMINAL_PATH_RESOLVER_LIMITS = {
  maxConcurrent: 3,
  maxQueued: 24,
  maxEntries: 256,
  resolvedTtlMs: 5 * 60_000,
  missingTtlMs: 15_000,
} as const;

/**
 * Caches runtime path lookups for one terminal session and bounds them: at
 * most `maxConcurrent` lookups run at once, excess hover traffic beyond
 * `maxQueued` is dropped, and failed lookups are never cached.
 */
export function createTerminalPathResolver(
  lookup: (text: string) => Promise<TerminalPathResolution | null>,
  options: TerminalPathResolverOptions = {},
): TerminalPathResolver {
  const limits = { ...TERMINAL_PATH_RESOLVER_LIMITS, ...options };
  const now = options.now ?? Date.now;
  const cache = new Map<string, { value: Promise<TerminalPathResolution | null>; expires: number }>();
  const queue: Array<{ start: () => void; drop: () => void }> = [];
  let active = 0;
  let disposed = false;

  const pump = (): void => {
    while (!disposed && active < limits.maxConcurrent && queue.length > 0) {
      queue.shift()!.start();
    }
  };

  const run = (text: string): Promise<TerminalPathResolution | null> => new Promise((resolve, reject) => {
    const start = (): void => {
      active += 1;
      lookup(text).then(resolve, reject).finally(() => {
        active -= 1;
        pump();
      });
    };
    if (active < limits.maxConcurrent) start();
    else if (queue.length < limits.maxQueued) {
      queue.push({ start, drop: () => reject(new Error("Terminal path lookups were stopped.")) });
    } else reject(new Error("Terminal path lookups are busy."));
  });

  return {
    resolve(text) {
      if (disposed || text.length === 0 || text.length > MAX_TERMINAL_PATH_TEXT_LENGTH) {
        return Promise.resolve(null);
      }
      const cached = cache.get(text);
      if (cached && cached.expires > now()) {
        cache.delete(text);
        cache.set(text, cached);
        return cached.value;
      }
      cache.delete(text);
      const value = run(text).then((resolution) => {
        if (disposed) return null;
        const entry = cache.get(text);
        if (entry?.value === value) {
          entry.expires = now() + (resolution ? limits.resolvedTtlMs : limits.missingTtlMs);
        }
        return resolution;
      }, () => {
        if (cache.get(text)?.value === value) cache.delete(text);
        return null;
      });
      cache.set(text, { value, expires: Number.POSITIVE_INFINITY });
      while (cache.size > limits.maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      return value;
    },
    dispose() {
      disposed = true;
      for (const entry of queue.splice(0)) entry.drop();
      cache.clear();
    },
  };
}

export interface TerminalPathLinkProvider extends ILinkProvider {
  /** Late lookups after this never reach xterm. */
  dispose(): void;
}

/** Links existing workspace files printed in the terminal. */
export function createTerminalPathLinkProvider(
  terminal: Pick<Terminal, "buffer" | "cols">,
  resolver: Pick<TerminalPathResolver, "resolve">,
  open: (resolution: TerminalPathResolution) => void,
  isEnabled: () => boolean = () => true,
): TerminalPathLinkProvider {
  let disposed = false;
  return {
    dispose() {
      disposed = true;
    },
    provideLinks(bufferLineNumber, callback) {
      if (disposed) return;
      if (!isEnabled()) {
        callback(undefined);
        return;
      }
      const row = bufferLineNumber - 1;
      const line = readTerminalLine(terminal.buffer.active, row, terminal.cols);
      const candidates = completeTerminalPathCandidates(line)
        .map((candidate) => ({ candidate, range: terminalCandidateRange(line, candidate) }))
        .filter((entry): entry is { candidate: TerminalPathCandidate; range: IBufferRange } => (
          entry.range !== null
          && entry.range.start.y <= bufferLineNumber
          && entry.range.end.y >= bufferLineNumber
        ))
        .slice(0, MAX_TERMINAL_PATH_CANDIDATES_PER_LINE);
      if (candidates.length === 0) {
        callback(undefined);
        return;
      }
      void Promise.all(candidates.map(async ({ candidate, range }): Promise<ILink | null> => {
        const resolution = await resolver.resolve(candidate.text);
        if (!resolution) return null;
        return {
          range,
          text: candidate.text,
          decorations: { pointerCursor: true, underline: true },
          activate: (event) => {
            event.preventDefault();
            open(resolution);
          },
        };
      })).then((links) => {
        if (disposed) return;
        const found = links.filter((link): link is ILink => link !== null);
        callback(found.length > 0 ? found : undefined);
      }, () => {
        if (!disposed) callback(undefined);
      });
    },
  };
}
