import { describe, expect, it } from "vitest";

import { HTML_RENDER_THEME_STYLE_ID, injectHtmlRenderBootstrap } from "../../src/shared/html-render";

const STYLE_OPEN = `<style id="${HTML_RENDER_THEME_STYLE_ID}">`;
const CHARSET = '<meta charset="utf-8">';
const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">';

function bootstrapCount(html: string): number {
  return html.split(STYLE_OPEN).length - 1;
}

describe("visual reply bootstrap injection", () => {
  it("inserts at the start of an existing head, ahead of the page's own styles", () => {
    const html = '<!doctype html><html lang="en"><head data-x="1"><style>p{color:red}</style></head><body><p>hi</p></body></html>';
    const result = injectHtmlRenderBootstrap(html);
    expect(result.startsWith('<!doctype html><html lang="en"><head data-x="1"><meta charset="utf-8">')).toBe(true);
    expect(bootstrapCount(result)).toBe(1);
    expect(result.indexOf(STYLE_OPEN)).toBeLessThan(result.indexOf("<style>p{color:red}"));
    expect(result.indexOf("<script>")).toBeLessThan(result.indexOf("</head>"));
    expect(result.endsWith("<body><p>hi</p></body></html>")).toBe(true);
  });

  it("adds a head right after <html> when the page has none", () => {
    const result = injectHtmlRenderBootstrap("<html><body><p>hi</p></body></html>");
    expect(result.startsWith(`<html><head>${CHARSET}`)).toBe(true);
    expect(result).toMatch(/<\/script><\/head><body><p>hi<\/p><\/body><\/html>$/u);
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
    expect(result.startsWith(`<html><head>${CHARSET}`)).toBe(true);
    expect(result).toContain('<script>var tag = "<head>";</script>');
    expect(result.indexOf(STYLE_OPEN)).toBeLessThan(result.indexOf("var tag"));
    expect(bootstrapCount(result)).toBe(1);
  });

  it("adds charset and viewport only when the page lacks them", () => {
    const authored = '<html><head><meta charset="utf-8"><meta name="viewport" content="width=600"></head><body></body></html>';
    const result = injectHtmlRenderBootstrap(authored);
    expect(result.split("charset").length - 1).toBe(1);
    expect(result).not.toContain(VIEWPORT);
    expect(result).toContain('<meta name="viewport" content="width=600">');

    const bare = injectHtmlRenderBootstrap("<html><head></head><body></body></html>");
    expect(bare).toContain(CHARSET);
    expect(bare).toContain(VIEWPORT);

    // A commented-out meta does not count as present.
    const commented = injectHtmlRenderBootstrap("<html><head><!-- <meta charset=\"latin1\"> --></head></html>");
    expect(commented).toContain(CHARSET);
  });

  it.each(["<head ", "<html ", "<meta ", "<meta name="])(
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

  it("finds a viewport meta after an unterminated or nested meta opening", () => {
    expect(injectHtmlRenderBootstrap('<head><meta <meta name="viewport" content="width=600"></head>'))
      .not.toContain(VIEWPORT);
    expect(injectHtmlRenderBootstrap('<head><meta charset="utf-8"><meta name=viewport content="width=600"></head>'))
      .not.toContain(VIEWPORT);
    expect(injectHtmlRenderBootstrap('<head><meta name="description" content="viewport"></head>'))
      .toContain(VIEWPORT);
  });
});
