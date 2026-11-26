export const EN_COLLATOR = new Intl.Collator("en");

export function isIsoUtc(value: string): boolean {
  return (
    value.length === 24
    && value.charCodeAt(23) === 90
    && value.charCodeAt(10) === 84
    && value.charCodeAt(4) === 45
    && value.charCodeAt(7) === 45
    && value.charCodeAt(13) === 58
    && value.charCodeAt(16) === 58
    && value.charCodeAt(19) === 46
  );
}

export function compareTimestampsAsc(left: string, right: string): number {
  if (left === right) return 0;
  if (isIsoUtc(left) && isIsoUtc(right)) return left < right ? -1 : 1;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return (Number.isFinite(leftMs) ? leftMs : 0) - (Number.isFinite(rightMs) ? rightMs : 0);
}

export function compareIsoTextDesc(left: string, right: string): number {
  if (left === right) return 0;
  if (isIsoUtc(left) && isIsoUtc(right)) return right < left ? -1 : 1;
  return EN_COLLATOR.compare(right, left);
}
