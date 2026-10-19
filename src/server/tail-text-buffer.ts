/**
 * A bounded ring of the newest complete text lines, for logs that a reader
 * follows with a cursor. Unlike CappedTextBuffer, which keeps the head of a
 * stream, this keeps the tail: the oldest lines are evicted first.
 *
 * Invariants:
 * - Retained text never exceeds `maxBytes` UTF-8 bytes nor `maxLines` lines.
 * - No line exceeds `maxLineBytes` UTF-8 bytes; a longer line is cut at a code
 *   point boundary and ends with LINE_CUT_MARKER, and the rest of that line
 *   is discarded up to its newline.
 * - Text holds no control characters except tab. ANSI escape sequences are
 *   removed whole, CR is dropped, and a lone UTF-16 surrogate becomes U+FFFD,
 *   so a retained string is always well formed.
 * - Every committed line gets the next cursor. Cursors start at 1, increase
 *   by one per line, and are never reused, including after eviction.
 * - Blank and whitespace-only lines are never committed, so they take no
 *   cursor and no room: a stray newline on stderr is not a log line.
 * - An optional `redact` hook sees each whole line once, before it is
 *   committed, so a secret split across chunks is still found; its output is
 *   bounded again to `maxLineBytes`.
 */

export const LINE_CUT_MARKER = " [line cut]";

export interface TailTextLine<Stream extends string> {
  cursor: number;
  stream: Stream;
  text: string;
}

export interface TailTextBufferOptions {
  maxBytes: number;
  maxLines: number;
  maxLineBytes: number;
  /**
   * Rewrites one complete, sanitized line before it is committed, for
   * example to hide remembered secrets. `cut` is true when the line was cut
   * at the byte bound, so its tail may hold part of a longer value.
   */
  redact?(text: string, cut: boolean): string;
}

export interface TailTextReadOptions {
  /** Return only lines with a greater cursor. Omitted: start at the oldest. */
  after?: number;
  limit: number;
  maxBytes: number;
  /** Literal, case-insensitive filter. */
  grep?: string;
  /** "oldest" pages forward from `after`; "newest" returns the tail. */
  prefer?: "oldest" | "newest";
}

export interface TailTextRead<Stream extends string> {
  lines: TailTextLine<Stream>[];
  /** Pass as `after` to read only lines committed later. */
  nextCursor: number;
  /** Matching retained lines in the range that were not returned. */
  omitted: number;
  /** Lines in the range that were evicted before this read. */
  dropped: number;
}

interface RetainedLine<Stream extends string> extends TailTextLine<Stream> {
  bytes: number;
}

interface PartialLine {
  /** Unsanitized input held back because it may continue in the next chunk. */
  carry: string;
  text: string;
  bytes: number;
  cut: boolean;
}

// CSI, OSC (BEL or ST terminated) and two-character escapes.
const ANSI_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/gu;
const INCOMPLETE_ANSI_TAIL = /\u001b(?:\[[0-?]*[ -/]*|\][^\u0007\u001b]*|)$/u;
const MAX_ESCAPE_CARRY = 256;
// Every C0/C1 control except tab and newline (kept for splitting).
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/gu;

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function sanitize(value: string): string {
  return value
    .replace(ANSI_SEQUENCE, "")
    .replace(CONTROL, "")
    .replace(LONE_SURROGATE, "�");
}

/** Longest prefix within `maximum` UTF-8 bytes that does not split a code point. */
export function utf8Prefix(value: string, maximum: number): string {
  if (maximum <= 0) return "";
  if (utf8ByteLength(value) <= maximum) return value;
  let bytes = 0;
  let end = 0;
  while (end < value.length) {
    const code = value.codePointAt(end)!;
    const width = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes + width > maximum) break;
    bytes += width;
    end += code > 0xffff ? 2 : 1;
  }
  return value.slice(0, end);
}

export class TailTextBuffer<Stream extends string> {
  private readonly lines: RetainedLine<Stream>[] = [];
  private readonly partials = new Map<Stream, PartialLine>();
  private retainedBytes = 0;
  private lastCursor = 0;
  private evicted = 0;
  private readonly markerBytes = utf8ByteLength(LINE_CUT_MARKER);

  constructor(private readonly options: TailTextBufferOptions) {
    if (
      !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1
      || !Number.isSafeInteger(options.maxLines) || options.maxLines < 1
      || !Number.isSafeInteger(options.maxLineBytes)
      || options.maxLineBytes <= this.markerBytes
      || options.maxLineBytes > options.maxBytes
    ) throw new Error("The tail buffer bounds are invalid.");
  }

  /** Cursor of the newest committed line, or 0 before the first one. */
  get latestCursor(): number {
    return this.lastCursor;
  }

  /** Lines evicted since construction. */
  get droppedLines(): number {
    return this.evicted;
  }

  get byteLength(): number {
    return this.retainedBytes;
  }

  get lineCount(): number {
    return this.lines.length;
  }

  /** Appends raw stream text; only complete lines are committed. */
  append(stream: Stream, chunk: string): void {
    if (!chunk) return;
    const partial = this.partial(stream);
    let input = partial.carry + chunk;
    partial.carry = "";
    // Hold back what may be the start of an escape sequence or of a
    // surrogate pair that the next chunk completes.
    const escape = INCOMPLETE_ANSI_TAIL.exec(input);
    if (escape && input.length - escape.index <= MAX_ESCAPE_CARRY) {
      partial.carry = input.slice(escape.index);
      input = input.slice(0, escape.index);
    } else {
      const last = input.charCodeAt(input.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        partial.carry = input.slice(-1);
        input = input.slice(0, -1);
      }
    }
    const segments = sanitize(input).split("\n");
    for (let index = 0; index < segments.length; index += 1) {
      this.extend(partial, segments[index]!);
      if (index < segments.length - 1) this.commitPartial(stream, partial);
    }
  }

  /** Commits one whole line, independent of any partial line on its stream. */
  appendLine(stream: Stream, text: string): void {
    const line: PartialLine = { carry: "", text: "", bytes: 0, cut: false };
    this.extend(line, sanitize(text).replaceAll("\n", " "));
    this.commit(stream, line);
  }

  /** Commits the unterminated tail of one stream, or of every stream. */
  flush(stream?: Stream): void {
    const streams = stream === undefined ? [...this.partials.keys()] : [stream];
    for (const current of streams) {
      const partial = this.partials.get(current);
      if (!partial) continue;
      if (partial.carry) {
        this.extend(partial, sanitize(partial.carry));
        partial.carry = "";
      }
      if (partial.text || partial.cut) this.commitPartial(current, partial);
      this.partials.delete(current);
    }
  }

  /** The newest `count` lines, oldest first. */
  tail(count: number): TailTextLine<Stream>[] {
    return this.lines.slice(Math.max(0, this.lines.length - Math.max(0, count)))
      .map(({ cursor, stream, text }) => ({ cursor, stream, text }));
  }

  read(options: TailTextReadOptions): TailTextRead<Stream> {
    const after = Math.max(0, Math.min(Math.trunc(options.after ?? 0), this.lastCursor));
    const limit = Math.max(0, Math.trunc(options.limit));
    const maxBytes = Math.max(0, Math.trunc(options.maxBytes));
    const needle = options.grep?.toLowerCase();
    const firstRetained = this.lines[0]?.cursor ?? this.lastCursor + 1;
    const dropped = Math.max(0, firstRetained - 1 - after);
    const candidates = this.lines.filter((line) => line.cursor > after
      && (needle === undefined || line.text.toLowerCase().includes(needle)));
    const selected: RetainedLine<Stream>[] = [];
    let bytes = 0;
    const take = (line: RetainedLine<Stream>): boolean => {
      if (selected.length >= limit || bytes + line.bytes > maxBytes) return false;
      selected.push(line);
      bytes += line.bytes;
      return true;
    };
    let nextCursor = this.lastCursor;
    if (options.prefer === "newest") {
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        if (!take(candidates[index]!)) break;
      }
      selected.reverse();
    } else {
      for (const line of candidates) {
        if (!take(line)) {
          nextCursor = selected.at(-1)?.cursor ?? after;
          break;
        }
      }
    }
    return {
      lines: selected.map(({ cursor, stream, text }) => ({ cursor, stream, text })),
      nextCursor,
      omitted: candidates.length - selected.length,
      dropped,
    };
  }

  private partial(stream: Stream): PartialLine {
    let partial = this.partials.get(stream);
    if (!partial) {
      partial = { carry: "", text: "", bytes: 0, cut: false };
      this.partials.set(stream, partial);
    }
    return partial;
  }

  private extend(partial: PartialLine, text: string): void {
    if (!text || partial.cut) return;
    const room = this.options.maxLineBytes - this.markerBytes - partial.bytes;
    const bytes = utf8ByteLength(text);
    if (bytes <= room) {
      partial.text += text;
      partial.bytes += bytes;
      return;
    }
    const kept = utf8Prefix(text, room);
    partial.text += kept;
    partial.bytes += utf8ByteLength(kept);
    partial.cut = true;
  }

  private commitPartial(stream: Stream, partial: PartialLine): void {
    this.commit(stream, partial);
    partial.text = "";
    partial.bytes = 0;
    partial.cut = false;
  }

  private commit(stream: Stream, partial: PartialLine): void {
    if (!partial.cut && partial.text.trim() === "") return;
    let body = partial.text;
    let cut = partial.cut;
    let bodyBytes = partial.bytes;
    if (this.options.redact) {
      const redacted = sanitize(this.options.redact(body, cut)).replaceAll("\n", " ");
      if (redacted !== body) {
        const room = this.options.maxLineBytes - this.markerBytes;
        body = utf8Prefix(redacted, room);
        cut ||= body !== redacted;
        bodyBytes = utf8ByteLength(body);
      }
    }
    const text = cut ? `${body}${LINE_CUT_MARKER}` : body;
    const bytes = bodyBytes + (cut ? this.markerBytes : 0);
    this.lastCursor += 1;
    this.lines.push({ cursor: this.lastCursor, stream, text, bytes });
    this.retainedBytes += bytes;
    let remove = 0;
    while (
      remove < this.lines.length
      && (this.retainedBytes > this.options.maxBytes
        || this.lines.length - remove > this.options.maxLines)
    ) {
      this.retainedBytes -= this.lines[remove]!.bytes;
      remove += 1;
    }
    if (remove > 0) {
      this.lines.splice(0, remove);
      this.evicted += remove;
    }
  }
}
