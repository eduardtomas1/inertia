const MASK = "[redacted]";
const OVER_DEPTH = "[redacted:over-depth]";
const MAX_PAYLOAD_DEPTH = 32;
const SIGNIFICANT_PARTIAL_CHARS = 6;
const LINE_ENDINGS = ["", "\n", "\r\n"] as const;

export interface LaunchSecretSpan {
  readonly start: number;
  readonly end: number;
}

export interface LaunchSecretScanResult {
  readonly matches: readonly LaunchSecretSpan[];
  readonly partialStart: number;
}

export function launchSecretForms(values: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    forms.add(value);
    forms.add(encodeURIComponent(value));
    forms.add(JSON.stringify(value).slice(1, -1));
    const bytes = Buffer.from(value, "utf8");
    forms.add(bytes.toString("hex"));
    forms.add(bytes.toString("hex").toUpperCase());
    for (const ending of LINE_ENDINGS) {
      const encoded = Buffer.from(`${value}${ending}`, "utf8");
      forms.add(encoded.toString("base64").replace(/=+$/u, ""));
      forms.add(encoded.toString("base64url"));
    }
  }
  return [...forms].filter((form) => form.length > 0)
    .sort((left, right) => right.length - left.length);
}

export class LaunchSecretMatcher {
  private readonly asciiFirst: (string[] | undefined)[];
  private readonly nonAsciiFirst: Map<number, string[]> | null;
  readonly window: number;

  constructor(readonly forms: readonly string[]) {
    this.asciiFirst = Array.from<string[] | undefined>({ length: 128 });
    let nonAscii: Map<number, string[]> | null = null;
    let longest = 0;
    for (const form of forms) {
      if (form.length === 0) continue;
      if (form.length > longest) longest = form.length;
      const code = form.charCodeAt(0);
      if (code < 128) {
        const bucket = this.asciiFirst[code];
        if (bucket) bucket.push(form);
        else this.asciiFirst[code] = [form];
      } else {
        nonAscii ??= new Map();
        const bucket = nonAscii.get(code);
        if (bucket) bucket.push(form);
        else nonAscii.set(code, [form]);
      }
    }
    this.nonAsciiFirst = nonAscii;
    this.window = 2 * longest + 8;
  }

  scan(text: string, includePartial: boolean): LaunchSecretScanResult {
    const length = text.length;
    if (this.forms.length === 0 || length === 0) {
      return { matches: [], partialStart: length };
    }
    const matches: LaunchSecretSpan[] = [];
    const windowStart = includePartial ? Math.max(0, length - this.window) : length;
    let partialStart = length;
    for (let index = 0; index < length; index += 1) {
      const code = text.charCodeAt(index);
      const candidates = code < 128 ? this.asciiFirst[code] : this.nonAsciiFirst?.get(code);
      if (!candidates) continue;
      let matchedEnd = -1;
      let isPartial = false;
      const canStartPartial = includePartial && index >= windowStart && !isGapCode(code);
      for (let c = 0; c < candidates.length; c += 1) {
        const result = matchForm(text, index, candidates[c]!);
        if (result > 0) {
          matchedEnd = result;
          break;
        }
        if (result === -2 && canStartPartial) {
          isPartial = true;
        }
      }
      if (matchedEnd !== -1) {
        matches.push({ start: index, end: matchedEnd });
        index = matchedEnd - 1;
      } else if (isPartial) {
        partialStart = index;
        break;
      }
    }
    return { matches, partialStart };
  }

  mask(text: string): string {
    if (this.forms.length === 0 || !text) return text;
    const { matches } = this.scan(text, false);
    return spliceMasked(text, text.length, matches);
  }

  payload<T>(value: T): T {
    if (this.forms.length === 0) return value;
    const visit = (current: unknown, depth: number): unknown => {
      if (typeof current === "string") return this.mask(current);
      if (current === null || typeof current !== "object") return current;
      if (depth >= MAX_PAYLOAD_DEPTH) return OVER_DEPTH;
      if (Array.isArray(current)) {
        let changed = false;
        const next = current.map((entry) => {
          const visited = visit(entry, depth + 1);
          if (visited !== entry) changed = true;
          return visited;
        });
        return changed ? next : current;
      }
      let changed = false;
      const next: [string, unknown][] = [];
      for (const [key, entry] of Object.entries(current)) {
        const maskedKey = this.mask(key);
        const visited = visit(entry, depth + 1);
        if (maskedKey !== key || visited !== entry) changed = true;
        next.push([maskedKey, visited]);
      }
      return changed ? Object.fromEntries(next) : current;
    };
    return visit(value, 0) as T;
  }

  matches(text: string): LaunchSecretSpan[] {
    return [...this.scan(text, false).matches];
  }

  partialStart(text: string, covered: ReadonlyArray<{ start: number; end: number }>): number {
    if (this.forms.length === 0) return text.length;
    for (let start = Math.max(0, text.length - this.window); start < text.length; start += 1) {
      const code = text.charCodeAt(start);
      if (isGapCode(code)) continue;
      const candidates = code < 128 ? this.asciiFirst[code] : this.nonAsciiFirst?.get(code);
      if (!candidates) continue;
      if (covered.some((range) => start >= range.start && start < range.end)) continue;
      for (let c = 0; c < candidates.length; c += 1) {
        if (matchForm(text, start, candidates[c]!) === -2) return start;
      }
    }
    return text.length;
  }
}

export class LaunchSecretStream {
  private pending = "";

  constructor(private readonly matcher: LaunchSecretMatcher) {}

  push(value: string): string {
    if (!value) return "";
    this.pending += value;
    const text = this.pending;
    const { matches, partialStart } = this.matcher.scan(text, true);
    let cut = partialStart;
    if (cut > 0 && isHighSurrogate(text, cut - 1)) cut -= 1;
    const output = spliceMasked(text, cut, matches);
    this.pending = cut === text.length ? "" : text.slice(cut);
    return output;
  }

  finish(): string {
    const text = this.pending;
    this.pending = "";
    if (!text) return "";
    const { matches, partialStart } = this.matcher.scan(text, true);
    const tail = text.slice(partialStart);
    const significant = countNonGapChars(tail) >= SIGNIFICANT_PARTIAL_CHARS;
    return spliceMasked(text, partialStart, matches) + (significant ? MASK : tail);
  }
}

function isGapCode(code: number): boolean {
  return code === 32 || code === 9 || code === 13 || code === 10;
}

function countNonGapChars(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!isGapCode(text.charCodeAt(index))) count += 1;
  }
  return count;
}

/**
 * Matches one gap-tolerant form starting at `start` (where `text[start] === form[0]`).
 * Returns end index (>0) on complete match, -2 on partial match reaching `text.length`, or -1 on mismatch.
 */
function matchForm(text: string, start: number, form: string): number {
  const textLen = text.length;
  const formLen = form.length;
  let scan = start + 1;
  let matched = 1;
  while (matched < formLen && scan < textLen) {
    const code = text.charCodeAt(scan);
    if (code === form.charCodeAt(matched)) {
      matched += 1;
      scan += 1;
    } else if (isGapCode(code)) {
      scan += 1;
    } else {
      return -1;
    }
  }
  if (matched === formLen) return scan;
  return scan === textLen ? -2 : -1;
}

function spliceMasked(
  text: string,
  cut: number,
  matches: readonly LaunchSecretSpan[],
): string {
  if (matches.length === 0) {
    return cut === text.length ? text : text.slice(0, cut);
  }
  let output = "";
  let cursor = 0;
  for (let index = 0; index < matches.length; index += 1) {
    const span = matches[index]!;
    if (span.end > cut) break;
    if (span.start > cursor) output += text.slice(cursor, span.start);
    output += MASK;
    cursor = span.end;
  }
  if (cursor < cut) output += text.slice(cursor, cut);
  return output;
}

function isHighSurrogate(text: string, index: number): boolean {
  const unit = text.charCodeAt(index);
  return unit >= 0xd800 && unit <= 0xdbff;
}
