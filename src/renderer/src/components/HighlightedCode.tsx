import { useMemo } from "react";
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

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("jsx", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("rs", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);

const MAX_HIGHLIGHT_CHARS = 50_000;
const MAX_HIGHLIGHT_LINES = 2_000;

export function HighlightedCode({
  code,
  language,
  enabled,
  className,
}: {
  code: string;
  language: string;
  enabled: boolean;
  className?: string;
}): React.JSX.Element {
  const html = useMemo(() => {
    if (
      !enabled
      || !language
      || code.length > MAX_HIGHLIGHT_CHARS
      || code.split("\n", MAX_HIGHLIGHT_LINES + 1).length > MAX_HIGHLIGHT_LINES
      || !hljs.getLanguage(language)
    ) return null;
    try {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }, [code, enabled, language]);
  const classes = [
    className,
    html ? "hljs" : null,
    language ? `language-${language}` : null,
  ].filter(Boolean).join(" ") || undefined;
  return html
    ? <code className={classes} dangerouslySetInnerHTML={{ __html: html }} />
    : <code className={classes}>{code}</code>;
}
