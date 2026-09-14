/** File links are opened on demand by the desktop, never loaded as web content. */
export function parseLocalFileUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 16_384 || /[\0\r\n]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "file:" || url.username || url.password || url.port || url.search
      || /%(?:2f|5c)/iu.test(url.pathname)
      || /[\0\r\n]/u.test(decodeURIComponent(url.pathname))) return null;
    return url;
  } catch { return null; }
}

/** Preserve URL escaping until the Markdown path parser has interpreted locations. */
export function encodedLocalFilePath(url: URL): string {
  return url.hostname
    ? `//${url.hostname}${url.pathname}`
    : url.pathname.replace(/^\/([a-z]:\/)/iu, "$1");
}

export function localFileLocationSuffix(path: string): string {
  return /:([1-9]\d{0,8})(?::([1-9]\d{0,8}))?(?:-([1-9]\d{0,8})(?::([1-9]\d{0,8}))?)?$/u.exec(path)?.[0] ?? "";
}

export function localFileUrl(path: string, literalPath = true): string | null {
  const normalized = path.replace(/\\/gu, "/");
  if (/[\0\r\n]/u.test(normalized)) return null;
  const windowsDrive = /^[a-z]:\//iu.test(normalized);
  if (!windowsDrive && !normalized.startsWith("/")) return null;
  const segments = normalized.split("/");
  let host = "";
  if (normalized.startsWith("//")) {
    host = segments[2] ?? "";
    if (!host || /[@:%?#]/u.test(host)) return null;
    segments.splice(0, 3, "");
  }
  try {
    let pathname = segments.map((segment, index) => windowsDrive && index === 0
      ? segment : encodeURIComponent(segment)).join("/");
    const location = literalPath ? "" : localFileLocationSuffix(normalized);
    if (location) pathname = pathname.slice(0, -encodeURIComponent(location).length) + location;
    const url = parseLocalFileUrl(`file://${host}${windowsDrive ? "/" : ""}${pathname}`);
    return url?.href ?? null;
  } catch { return null; }
}
