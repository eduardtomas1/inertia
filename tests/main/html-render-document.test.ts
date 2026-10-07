import { describe, expect, it } from "vitest";

import {
  HTML_RENDER_CONTENT_SECURITY_POLICY,
  htmlRenderDocumentResponse,
  htmlRenderTemporarilyUnavailableResponse,
  htmlRenderUnavailableResponse,
} from "../../src/main/html-render-document";
import { HTML_RENDER_THEME_STYLE_ID } from "../../src/shared/html-render";

const EXPECTED_HEADERS = (contentLength: number) => ({
  "content-type": "text/html; charset=utf-8",
  "content-length": String(contentLength),
  "content-security-policy": EXPECTED_POLICY,
  "x-content-type-options": "nosniff",
  "x-dns-prefetch-control": "off",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), display-capture=(), fullscreen=()",
});

const EXPECTED_POLICY = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

describe("visual reply document", () => {
  it("pins the sandboxed content security policy", () => {
    expect(HTML_RENDER_CONTENT_SECURITY_POLICY).toBe(EXPECTED_POLICY);
    for (const directive of HTML_RENDER_CONTENT_SECURITY_POLICY.split("; ")) {
      expect(directive).not.toMatch(/inertia/u);
      expect(directive).not.toMatch(/https?:|\*|'self'/u);
    }
  });

  it("serves the page with the bootstrap and exact headers", async () => {
    const html = "<!doctype html><html><head><title>Chart ✓</title></head><body><p>ok</p></body></html>";
    const response = htmlRenderDocumentResponse(html);
    const body = new Uint8Array(await response.clone().arrayBuffer());
    const text = new TextDecoder().decode(body);

    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers.entries())).toEqual(EXPECTED_HEADERS(body.byteLength));
    expect(text).toContain(`<style id="${HTML_RENDER_THEME_STYLE_ID}">`);
    expect(text.indexOf(HTML_RENDER_THEME_STYLE_ID)).toBeLessThan(text.indexOf("<title>"));
    expect(text).toContain("<p>ok</p>");
    // Content-Length counts UTF-8 bytes, not UTF-16 code units.
    expect(body.byteLength).toBeGreaterThan(text.length);
  });

  it("serves a themed 404 under the same policy when a page is unavailable", async () => {
    const response = htmlRenderUnavailableResponse();
    const body = new Uint8Array(await response.clone().arrayBuffer());
    const text = new TextDecoder().decode(body);

    expect(response.status).toBe(404);
    expect(Object.fromEntries(response.headers.entries())).toEqual(EXPECTED_HEADERS(body.byteLength));
    expect(text).toMatch(/^<!doctype html><head><meta charset="utf-8">/u);
    expect(text).toContain(`<style id="${HTML_RENDER_THEME_STYLE_ID}">`);
    expect(text).toContain("<p>This page is no longer available.</p>");
    expect(text).toContain("var(--muted-foreground)");
    expect(text).not.toMatch(/https?:/u);
  });

  it("serves a themed 503 that tells its frame to retry once the runtime is back", async () => {
    const response = htmlRenderTemporarilyUnavailableResponse();
    const body = new Uint8Array(await response.clone().arrayBuffer());
    const text = new TextDecoder().decode(body);

    expect(response.status).toBe(503);
    expect(Object.fromEntries(response.headers.entries())).toEqual(EXPECTED_HEADERS(body.byteLength));
    expect(text).toContain(`<style id="${HTML_RENDER_THEME_STYLE_ID}">`);
    expect(text).toContain("<p>This page is temporarily unavailable.</p>");
    expect(text).toContain('{type:"inertia-html-render:unavailable"}');
    expect(text).not.toMatch(/https?:/u);
  });
});
