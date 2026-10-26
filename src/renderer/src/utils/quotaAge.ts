export function formatUpdatedAge(value: string | null, now = Date.now()): string | null {
  const updatedAt = Date.parse(value ?? "");
  if (!Number.isFinite(updatedAt)) return null;
  const minutes = Math.max(0, Math.floor((now - updatedAt) / 60_000));
  if (minutes < 1) return "updated just now";
  if (minutes < 60) return `updated ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `updated ${hours} h ago`;
  return `updated ${Math.floor(hours / 24)} d ago`;
}
