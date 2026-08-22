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

  it("renders bounded browser pages and visible agent activity", () => {
    const activeTabId = "11111111-1111-4111-8111-111111111111";
    const html = renderToStaticMarkup(createElement(PreviewPanel, {
      owner: "primary",
      url: "http://127.0.0.1:4173/",
      tabs: [{
        id: activeTabId,
        title: "Local dashboard",
        url: "http://127.0.0.1:4173/",
        loading: false,
      }],
      activeTabId,
      evidence: {
        revision: 1,
        omitted: false,
        entries: [{
          id: "22222222-2222-4222-8222-222222222222",
          sequence: 1,
          kind: "agent-action",
          tabId: activeTabId,
          pageNumber: 1,
          documentSequence: 1,
          runId: "33333333-3333-4333-8333-333333333333",
          turnId: "44444444-4444-4444-8444-444444444444",
          occurredAt: "2026-08-22T08:00:00.000Z",
          summary: "Agent clicked a page element",
          detail: null,
          origin: null,
          redacted: false,
          occurrences: 1,
        }],
      },
      onNavigate: () => undefined,
      onOpenExternal: () => undefined,
      onOpenTab: () => undefined,
      onActivateTab: () => undefined,
      onCloseTab: () => undefined,
    }));

    expect(html).toContain('aria-label="Inertia Browser pages"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("Local dashboard");
    expect(html).toContain("Evidence");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Open browser page"');
    expect(html).toContain('aria-label="Close Local dashboard"');
  });
});
