const MAX_PREVIEW_URL_LENGTH = 4_096;

const LITERAL_LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

export type PreviewNavigationTarget =
  | { kind: "embed"; url: URL }
  | { kind: "external"; url: URL };

export function isLiteralLoopbackHost(hostname: string): boolean {
  return LITERAL_LOOPBACK_HOSTS.has(hostname.toLocaleLowerCase("en-US"));
}

export function safeHttpUrl(value: unknown): URL {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_PREVIEW_URL_LENGTH
  ) {
    throw new Error("Invalid URL");
  }
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username
    || url.password
  ) {
    throw new Error("Only safe HTTP and HTTPS URLs can be opened");
  }
  if (url.protocol === "http:" && !isLiteralLoopbackHost(url.hostname)) {
    throw new Error("Remote previews must use HTTPS");
  }
  return url;
}

export function previewNavigationTarget(
  value: unknown,
): PreviewNavigationTarget {
  const url = safeHttpUrl(value);
  return isLiteralLoopbackHost(url.hostname)
    ? { kind: "embed", url }
    : { kind: "external", url };
}
