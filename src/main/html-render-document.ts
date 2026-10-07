import { injectHtmlRenderBootstrap } from "../shared/html-render.js";

/**
 * Policy for a served visual reply. The document runs in an opaque-origin
 * sandbox with inline script and style only: it cannot fetch, frame, open
 * workers, submit forms, or load anything from the app scheme or the network.
 */
export const HTML_RENDER_CONTENT_SECURITY_POLICY = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export const HTML_RENDER_PERMISSIONS_POLICY =
  "camera=(), microphone=(), geolocation=(), display-capture=(), fullscreen=()";

const UNAVAILABLE_PAGE = [
  "<!doctype html><html><head><title>Page unavailable</title>",
  "<style>p{margin:0;padding:24px 16px;color:var(--muted-foreground);text-align:center}</style>",
  "</head><body><p>This page is no longer available.</p></body></html>",
].join("");

function htmlRenderResponse(html: string, status: 200 | 404): Response {
  const body = new TextEncoder().encode(injectHtmlRenderBootstrap(html));
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": String(body.byteLength),
      "Content-Security-Policy": HTML_RENDER_CONTENT_SECURITY_POLICY,
      "X-Content-Type-Options": "nosniff",
      "X-DNS-Prefetch-Control": "off",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      "Permissions-Policy": HTML_RENDER_PERMISSIONS_POLICY,
    },
  });
}

/** Builds the protocol response for one stored page, with the theme bootstrap injected. */
export function htmlRenderDocumentResponse(html: string): Response {
  return htmlRenderResponse(html, 200);
}

/** A themed 404 for a well-formed render id with no page to show, under the same policy as a page. */
export function htmlRenderUnavailableResponse(): Response {
  return htmlRenderResponse(UNAVAILABLE_PAGE, 404);
}
