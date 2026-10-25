const GAP_CHARACTERS: ReadonlySet<string> = new Set([" ", "\t", "\r", "\n"]);
const GAP_PATTERN = "[ \\t\\r\\n]*";
const MASK = "[redacted]";
const OVER_DEPTH = "[redacted:over-depth]";
const MAX_PAYLOAD_DEPTH = 32;
const SIGNIFICANT_PARTIAL_CHARS = 6;
const LINE_ENDINGS = ["", "\n", "\r\n"] as const;

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
  private readonly pattern: RegExp | null;
  readonly window: number;

  constructor(readonly forms: readonly string[]) {
    this.pattern = forms.length === 0
      ? null
      : new RegExp(forms.map(gapTolerantSource).join("|"), "gu");
    this.window = 2 * Math.max(0, ...forms.map((form) => form.length)) + 8;
  }

  mask(text: string): string {
    return this.pattern ? text.replace(this.pattern, MASK) : text;
  }

  payload<T>(value: T): T {
    if (!this.pattern) return value;
    const visit = (current: unknown, depth: number): unknown => {
      if (typeof current === "string") return this.mask(current);
      if (current === null || typeof current !== "object") return current;
      if (depth >= MAX_PAYLOAD_DEPTH) return OVER_DEPTH;
      if (Array.isArray(current)) return current.map((entry) => visit(entry, depth + 1));
      return Object.fromEntries(Object.entries(current).map(([key, entry]) => [
        this.mask(key),
        visit(entry, depth + 1),
      ]));
    };
    return visit(value, 0) as T;
  }

  matches(text: string): Array<{ start: number; end: number }> {
    if (!this.pattern) return [];
    return [...text.matchAll(this.pattern)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
    }));
  }

  partialStart(text: string, covered: ReadonlyArray<{ start: number; end: number }>): number {
    for (let start = Math.max(0, text.length - this.window); start < text.length; start += 1) {
      if (GAP_CHARACTERS.has(text[start]!)) continue;
      if (covered.some((range) => start >= range.start && start < range.end)) continue;
      if (this.forms.some((form) => continuesForm(text, start, form))) return start;
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
    const matches = this.matcher.matches(this.pending);
    let cut = this.matcher.partialStart(this.pending, matches);
    if (cut > 0 && isHighSurrogate(this.pending, cut - 1)) cut -= 1;
    const output = this.matcher.mask(this.pending.slice(0, cut));
    this.pending = this.pending.slice(cut);
    return output;
  }

  finish(): string {
    const text = this.pending;
    this.pending = "";
    const cut = this.matcher.partialStart(text, this.matcher.matches(text));
    const tail = text.slice(cut);
    const significant = tail.replace(/[ \t\r\n]/gu, "").length >= SIGNIFICANT_PARTIAL_CHARS;
    return this.matcher.mask(text.slice(0, cut)) + (significant ? MASK : tail);
  }
}

function gapTolerantSource(form: string): string {
  return [...form].map((character) => character.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&")).join(GAP_PATTERN);
}

function continuesForm(text: string, start: number, form: string): boolean {
  let matched = 0;
  let index = start;
  while (index < text.length && matched < form.length) {
    const character = text[index]!;
    if (character === form[matched]) {
      matched += 1;
      index += 1;
    } else if (matched > 0 && GAP_CHARACTERS.has(character)) {
      index += 1;
    } else {
      return false;
    }
  }
  return index === text.length && matched > 0 && matched < form.length;
}

function isHighSurrogate(text: string, index: number): boolean {
  const unit = text.charCodeAt(index);
  return unit >= 0xd800 && unit <= 0xdbff;
}
