export function middleTruncate(value: string, limit: number): string {
  const characters = Array.from(value);
  if (characters.length <= limit) return value;
  const kept = Math.max(limit - 1, 2);
  const head = Math.floor(kept / 2);
  return `${characters.slice(0, head).join("")}…${characters.slice(head - kept).join("")}`;
}
