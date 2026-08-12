import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  PreviewPanel,
  safePreviewUrl,
} from "../../src/renderer/src/components/PreviewPanel";

describe("preview panel URL routing", () => {
  it("normalizes literal development origins for embedding", () => {
    expect(safePreviewUrl("localhost:3000/app")).toMatchObject({
      value: "http://localhost:3000/app",
      target: "embed",
    });
    expect(safePreviewUrl("127.0.0.1:4173")).toMatchObject({
      value: "http://127.0.0.1:4173/",
      target: "embed",
    });
    expect(safePreviewUrl("[::1]:8080")).toMatchObject({
      value: "http://[::1]:8080/",
      target: "embed",
    });
  });

  it("routes remote addresses externally and rejects remote plaintext HTTP", () => {
    expect(safePreviewUrl("example.com/docs")).toMatchObject({
      value: "https://example.com/docs",
      target: "external",
    });
    expect(safePreviewUrl("https://example.com/docs")).toMatchObject({
      value: "https://example.com/docs",
      target: "external",
    });
    expect(safePreviewUrl("http://example.com")).toMatchObject({
      error: "Remote previews must use HTTPS",
    });
  });

  it("preserves the accessible preview and external-open controls", () => {
    const html = renderToStaticMarkup(createElement(PreviewPanel, {
      owner: "primary",
      url: "",
      onNavigate: () => undefined,
      onOpenExternal: () => undefined,
    }));

    expect(html).toContain('aria-label="Browser preview"');
    expect(html).toContain('aria-label="Preview address"');
    expect(html).toContain('aria-label="Open in system browser"');
    expect(html).toContain("localhost:3000 or https://example.com");
  });
});
