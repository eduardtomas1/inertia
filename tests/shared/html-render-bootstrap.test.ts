import { describe, expect, it } from "vitest";

import { HTML_RENDER_THEME_STYLE_ID, injectHtmlRenderBootstrap } from "../../src/shared/html-render";

const STYLE_OPEN = `<style id="${HTML_RENDER_THEME_STYLE_ID}">`;
const CHARSET = '<meta charset="utf-8">';
const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">';

function bootstrapCount(html: string): number {
  return html.split(STYLE_OPEN).length - 1;
}

describe("visual reply bootstrap injection", () => {
  it("adds a head right after the doctype, ahead of the page's own head and styles", () => {
    const page = '<html lang="en"><head data-x="1"><style>p{color:red}</style></head><body><p>hi</p></body></html>';
    const result = injectHtmlRenderBootstrap(`<!doctype html>${page}`);
    expect(result.startsWith(`<!doctype html><head>${CHARSET}${VIEWPORT}${STYLE_OPEN}`)).toBe(true);
    expect(result.endsWith(`</script></head>${page}`)).toBe(true);
    expect(bootstrapCount(result)).toBe(1);
    expect(result.indexOf(STYLE_OPEN)).toBeLessThan(result.indexOf("<style>p{color:red}"));
  });

  it("adds a doctype and a head ahead of a page without a doctype", () => {
    const html = "<html><body><p>hi</p></body></html>";
    const result = injectHtmlRenderBootstrap(html);
    expect(result.startsWith(`<!doctype html><head>${CHARSET}`)).toBe(true);
    expect(result.endsWith(`</script></head>${html}`)).toBe(true);
    expect(bootstrapCount(result)).toBe(1);
  });

  it("adds a head right after a doctype-only preamble", () => {
    const result = injectHtmlRenderBootstrap("<!DOCTYPE html>\n<p>hi</p>");
    expect(result.startsWith(`<!DOCTYPE html><head>${CHARSET}`)).toBe(true);
    expect(result).toMatch(/<\/script><\/head>\n<p>hi<\/p>$/u);
  });

  it("wraps a bare fragment in a document with a head", () => {
    const result = injectHtmlRenderBootstrap("<svg viewBox=\"0 0 1 1\"></svg>");
    expect(result.startsWith(`<!doctype html><head>${CHARSET}${VIEWPORT}${STYLE_OPEN}`)).toBe(true);
    expect(result.endsWith("</head><svg viewBox=\"0 0 1 1\"></svg>")).toBe(true);
  });

  it("ignores a <head> inside a comment", () => {
    const html = "<!-- <head> --><p>hi</p>";
    const result = injectHtmlRenderBootstrap(html);
    expect(result.startsWith("<!doctype html><head>")).toBe(true);
    expect(result.endsWith(`</head>${html}`)).toBe(true);
    expect(result).toContain("<!-- <head> -->");
    expect(bootstrapCount(result)).toBe(1);
  });

  it("ignores a <head> inside a script string", () => {
    const html = '<html><body><script>var tag = "<head>";</script></body></html>';
    const result = injectHtmlRenderBootstrap(html);
    expect(result.startsWith(`<!doctype html><head>${CHARSET}`)).toBe(true);
    expect(result.endsWith(`</head>${html}`)).toBe(true);
    expect(result.indexOf(STYLE_OPEN)).toBeLessThan(result.indexOf("var tag"));
    expect(bootstrapCount(result)).toBe(1);
  });

  it("leaves a <head> inside an attribute value untouched", () => {
    const html = '<div data-x="<head>"><p>hi</p></div>';
    const result = injectHtmlRenderBootstrap(html);
    expect(result.endsWith(html)).toBe(true);
    expect(bootstrapCount(result)).toBe(1);
  });

  it("puts the bootstrap ahead of a page script that precedes the head", () => {
    const html = "<!doctype html><script>window.first = 1</script><html><head></head><body></body></html>";
    const result = injectHtmlRenderBootstrap(html);
    expect(result.indexOf(STYLE_OPEN)).toBeLessThan(result.indexOf("window.first"));
    expect(result.indexOf("<script>(function(){")).toBeLessThan(result.indexOf("window.first"));
  });

  it("declares UTF-8 and a viewport ahead of the page's own declarations", () => {
    const authored = '<html><head><meta charset="utf-8"><meta name="viewport" content="width=600"></head><body></body></html>';
    const result = injectHtmlRenderBootstrap(authored);
    expect(result.indexOf(CHARSET)).toBeLessThan(result.indexOf(authored));
    expect(result.indexOf(VIEWPORT)).toBeLessThan(result.indexOf(authored));
    expect(result.endsWith(`</head>${authored}`)).toBe(true);
  });

  it.each(["<head ", "<html ", "<meta ", "<meta name=", "<!doctype ", " "])(
    "scans a maximum page of unterminated %j openings in linear time",
    (unit) => {
      // The main process injects on every load; a backtracking tag pattern took seconds here.
      const html = unit.repeat(Math.floor(256 * 1024 / unit.length));
      const started = performance.now();
      const result = injectHtmlRenderBootstrap(html);
      expect(performance.now() - started).toBeLessThan(1_000);
      expect(bootstrapCount(result)).toBe(1);
      expect(result.endsWith(`</head>${html}`)).toBe(true);
    },
  );
});
