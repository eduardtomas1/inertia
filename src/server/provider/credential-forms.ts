/** Forms shorter than this are not matched: a fragment that short would redact ordinary text. */
const MIN_CREDENTIAL_FORM_CHARS = 8;
/** Base64 characters that depend only on the value's own bytes when it follows 0, 1 or 2 other bytes. */
const BASE64_STABLE_START = [0, 2, 3] as const;

function lowerPercentEscapes(value: string): string {
  return value.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase());
}

/**
 * The forms in which a launch credential is matched in text a user wrote: the value itself; JSON string escapes,
 * with and without `\/`; percent encoding with upper- or lowercase escapes, and form encoding (`+` for a space);
 * upper- and lowercase hex; and base64 and base64url, padded, unpadded and at each of the three byte alignments
 * (the value encoded after 0, 1 or 2 other bytes, keeping only the characters its own bytes decide). These are the
 * common encodings, not every possible one: a value split by a line break, for one, is not matched.
 */
export function credentialForms(credentials: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const credential of credentials) {
    if (!credential) continue;
    const bytes = Buffer.from(credential, "utf8");
    const json = JSON.stringify(credential).slice(1, -1);
    const percent = encodeURIComponent(credential);
    const form = percent.replace(/%20/gu, "+");
    for (const value of [credential, json, json.replaceAll("/", "\\/"), percent, lowerPercentEscapes(percent), form,
      lowerPercentEscapes(form), bytes.toString("hex"), bytes.toString("hex").toUpperCase(),
      bytes.toString("base64"), bytes.toString("base64url")]) forms.add(value);
    for (const encoding of ["base64", "base64url"] as const) {
      for (const offset of [0, 1, 2] as const) {
        const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString(encoding).replace(/=+$/u, "");
        forms.add(encoded.slice(BASE64_STABLE_START[offset], Math.floor(((offset + bytes.length) * 8) / 6)));
      }
    }
  }
  return [...forms].filter((value) => value.length >= MIN_CREDENTIAL_FORM_CHARS);
}

/**
 * Replaces every occurrence of every form with `[redacted]`. Occurrences are collected in the original text and
 * overlapping or touching ones merged first, so two overlapping credentials leave no part of either. Each form is
 * found by literal search.
 */
export function redactCredentialForms(text: string, forms: readonly string[]): string {
  const ranges: Array<[number, number]> = [];
  for (const form of forms) {
    for (let index = text.indexOf(form); index >= 0; index = text.indexOf(form, index + 1)) {
      const last = ranges.at(-1);
      // Overlapping matches of one form arrive in order; extend the current range instead of adding one each.
      if (last && last[0] <= index && index <= last[1]) last[1] = Math.max(last[1], index + form.length);
      else ranges.push([index, index + form.length]);
    }
  }
  if (ranges.length === 0) return text;
  ranges.sort((left, right) => left[0] - right[0] || right[1] - left[1]);
  let result = "";
  let cursor = 0;
  let start = ranges[0]![0];
  let end = ranges[0]![1];
  for (const [rangeStart, rangeEnd] of ranges.slice(1)) {
    if (rangeStart <= end) {
      end = Math.max(end, rangeEnd);
      continue;
    }
    result += `${text.slice(cursor, start)}[redacted]`;
    cursor = end;
    start = rangeStart;
    end = rangeEnd;
  }
  return `${result}${text.slice(cursor, start)}[redacted]${text.slice(end)}`;
}
