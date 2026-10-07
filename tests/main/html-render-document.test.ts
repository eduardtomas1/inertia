import { describe, expect, it } from "vitest";

import {
  HTML_RENDER_CONTENT_SECURITY_POLICY,
  htmlRenderDocumentResponse,
} from "../../src/main/html-render-document";
import { HTML_RENDER_THEME_STYLE_ID } from "../../src/shared/html-render";

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
    expect(Object.fromEntries(response.headers.entries())).toEqual({
      "content-type": "text/html; charset=utf-8",
      "content-length": String(body.byteLength),
      "content-security-policy": EXPECTED_POLICY,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), display-capture=(), fullscreen=()",
    });
    expect(text).toContain(`<style id="${HTML_RENDER_THEME_STYLE_ID}">`);
    expect(text.indexOf(HTML_RENDER_THEME_STYLE_ID)).toBeLessThan(text.indexOf("<title>"));
    expect(text).toContain("<p>ok</p>");
    // Content-Length counts UTF-8 bytes, not UTF-16 code units.
    expect(body.byteLength).toBeGreaterThan(text.length);
  });
});
