const sourceLocationSuffix = /:(?:[1-9]\d{0,8})(?::(?:[1-9]\d{0,8}))?$/u;

export function workspaceFileReferenceFallback(
  path: string,
): string | null {
  const fallback = path.replace(sourceLocationSuffix, "");
  return fallback && fallback !== path ? fallback : null;
}
