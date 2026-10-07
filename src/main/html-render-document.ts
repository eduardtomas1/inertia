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

/** Builds the protocol response for one stored page, with the theme bootstrap injected. */
export function htmlRenderDocumentResponse(html: string): Response {
  const body = new TextEncoder().encode(injectHtmlRenderBootstrap(html));
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": String(body.byteLength),
      "Content-Security-Policy": HTML_RENDER_CONTENT_SECURITY_POLICY,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      "Permissions-Policy": HTML_RENDER_PERMISSIONS_POLICY,
    },
  });
}
