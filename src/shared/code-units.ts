export function clipCodeUnits(value: string, maximum: number): string {
  if (maximum <= 0) return "";
  if (value.length <= maximum) return value;
  const last = value.charCodeAt(maximum - 1);
  return value.slice(0, last >= 0xD800 && last <= 0xDBFF ? maximum - 1 : maximum);
}
