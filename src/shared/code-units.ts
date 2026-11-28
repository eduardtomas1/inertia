/**
 * Keeps at most `maximum` UTF-16 code units from the start of `value`. A cut
 * that would end on the high half of a surrogate pair drops that half, so the
 * result never ends on a lone high surrogate.
 */
export function clipCodeUnits(value: string, maximum: number): string {
  if (maximum <= 0) return "";
  if (value.length <= maximum) return value;
  const last = value.charCodeAt(maximum - 1);
  return value.slice(0, last >= 0xD800 && last <= 0xDBFF ? maximum - 1 : maximum);
}

/**
 * Keeps at most `maximum` UTF-16 code units from the end of `value`. A cut
 * that would start on the low half of a surrogate pair drops that half, so the
 * result never starts on a lone low surrogate.
 */
export function clipTrailingCodeUnits(value: string, maximum: number): string {
  if (maximum <= 0) return "";
  if (value.length <= maximum) return value;
  const start = value.length - maximum;
  const first = value.charCodeAt(start);
  return value.slice(first >= 0xDC00 && first <= 0xDFFF ? start + 1 : start);
}
