import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

import type { SourceLanguage } from "@shared/source-language";

const MAX_HIGHLIGHT_CHARS = 50_000;
const MAX_HIGHLIGHT_LINES = 2_000;

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

function highlightable(
  code: string,
  language: SourceLanguage,
  enabled: boolean,
): language is SourceLanguage & { highlightLanguage: string } {
  return enabled
    && Boolean(language.highlightLanguage)
    && code.length <= MAX_HIGHLIGHT_CHARS
    && code.split("\n", MAX_HIGHLIGHT_LINES + 1).length <= MAX_HIGHLIGHT_LINES
    && Boolean(hljs.getLanguage(language.highlightLanguage ?? ""));
}

export function highlightedSourceHtml(
  code: string,
  language: SourceLanguage,
  enabled = true,
): string | null {
  if (!highlightable(code, language, enabled)) return null;
  try {
    return hljs.highlight(code, {
      language: language.highlightLanguage,
      ignoreIllegals: true,
    }).value;
  } catch {
    return null;
  }
}

/**
 * highlight.js can keep one span open across several lines. Close and reopen
 * those generated spans at each newline so the preview can retain real line
 * elements for exact source navigation without changing the highlighted text.
 */
export function highlightedSourceLines(
  code: string,
  language: SourceLanguage,
  enabled = true,
): string[] | null {
  const html = highlightedSourceHtml(code, language, enabled);
  if (html === null) return null;
  const lines: string[] = [];
  const openSpans: string[] = [];
  let line = "";
  let cursor = 0;
  const tokens = /<span\b[^>]*>|<\/span>|\r?\n/gu;
  for (const match of html.matchAll(tokens)) {
    const token = match[0];
    const index = match.index;
    line += html.slice(cursor, index);
    cursor = index + token.length;
    if (token === "\n" || token === "\r\n") {
      line += "</span>".repeat(openSpans.length);
      lines.push(line);
      line = openSpans.join("");
    } else if (token === "</span>") {
      openSpans.pop();
      line += token;
    } else {
      openSpans.push(token);
      line += token;
    }
  }
  line += html.slice(cursor);
  line += "</span>".repeat(openSpans.length);
  lines.push(line);
  return lines;
}
