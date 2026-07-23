import {
  Children,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  Check,
  Code2,
  Copy,
  ExternalLink,
  FileCode2,
  Table2,
  WrapText,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
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

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "details", "summary"],
  attributes: {
    ...defaultSchema.attributes,
    details: ["open"],
    input: [...(defaultSchema.attributes?.input ?? []), "checked", "disabled", ["type", "checkbox"]],
  },
};

type ResponseMarkdownProps = {
  content: string;
  projectRoot: string;
  defaultCodeWrap: boolean;
  streaming?: boolean;
};

type ProjectLink =
  | { kind: "external"; url: string }
  | { kind: "project"; path: string }
  | { kind: "anchor"; href: string }
  | { kind: "unsafe" };

type MarkdownAstNode = {
  type?: string;
  meta?: unknown;
  data?: { hProperties?: Record<string, unknown> };
  children?: MarkdownAstNode[];
};

function preserveCodeMeta() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode): void => {
      if (node.type === "code" && typeof node.meta === "string" && node.meta.trim()) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataCodeMeta: node.meta.trim(),
          },
        };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

function normalizedPath(value: string): string {
  const slash = value.replace(/\\/gu, "/");
  const drive = /^[a-z]:/iu.exec(slash)?.[0] ?? "";
  const absolute = slash.startsWith("/") || Boolean(drive);
  const rest = drive ? slash.slice(drive.length) : slash;
  const segments: string[] = [];
  for (const segment of rest.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return "";
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  const prefix = drive ? `${drive}/` : absolute ? "/" : "";
  return `${prefix}${segments.join("/")}` || (absolute ? prefix : ".");
}

export function resolveResponseLink(projectRoot: string, rawHref: string): ProjectLink {
  const href = rawHref.trim();
  if (!href || href.includes("\0")) return { kind: "unsafe" };
  if (href.startsWith("#")) return { kind: "anchor", href };
  try {
    const url = new URL(href);
    if (url.protocol === "http:" || url.protocol === "https:") return { kind: "external", url: url.toString() };
    return { kind: "unsafe" };
  } catch {
    // Relative project paths are intentionally handled below.
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.split("#", 1)[0]!.split("?", 1)[0]!);
  } catch {
    return { kind: "unsafe" };
  }
  if (!decoded || /^[a-z][a-z0-9+.-]*:/iu.test(decoded) && !/^[a-z]:[\\/]/iu.test(decoded)) return { kind: "unsafe" };
  const root = normalizedPath(projectRoot).replace(/\/+$/u, "");
  if (!root) return { kind: "unsafe" };
  const isAbsolute = decoded.startsWith("/") || /^[a-z]:[\\/]/iu.test(decoded);
  const candidate = normalizedPath(isAbsolute ? decoded : `${root}/${decoded}`);
  const insensitive = /^[a-z]:\//iu.test(root);
  const comparableRoot = insensitive ? root.toLocaleLowerCase("en-US") : root;
  const comparableCandidate = insensitive ? candidate.toLocaleLowerCase("en-US") : candidate;
  if (comparableCandidate !== comparableRoot && !comparableCandidate.startsWith(`${comparableRoot}/`)) return { kind: "unsafe" };
  return { kind: "project", path: candidate };
}

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

function useCopiedState(): [boolean, (text: string) => Promise<void>] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const copy = async (text: string): Promise<void> => {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1_500);
  };
  return [copied, copy];
}

function quoteCsvCell(value: string): string {
  return /[",\n\r]/u.test(value) ? `"${value.replace(/"/gu, "\"\"")}"` : value;
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\r?\n/gu, "<br>");
}

export function tableRowsFromNode(children: ReactNode): string[][] {
  const rows: string[][] = [];
  const visit = (node: ReactNode): void => {
    if (!isValidElement<{ children?: ReactNode }>(node)) {
      if (Array.isArray(node)) node.forEach(visit);
      return;
    }
    if (node.type === "tr") {
      rows.push(Children.toArray(node.props.children).map((cell) => nodeText(cell).trim()));
      return;
    }
    Children.toArray(node.props.children).forEach(visit);
  };
  visit(children);
  return rows;
}

export function tableAsCsv(rows: string[][]): string {
  return rows.map((row) => row.map(quoteCsvCell).join(",")).join("\n");
}

export function tableAsMarkdown(rows: string[][]): string {
  if (rows.length === 0) return "";
  const columns = Math.max(...rows.map((row) => row.length));
  const normalize = (row: string[]) => Array.from({ length: columns }, (_, index) => escapeMarkdownCell(row[index] ?? ""));
  const [head, ...body] = rows.map(normalize);
  return [
    `| ${head!.join(" | ")} |`,
    `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function MarkdownTable({ children, ...props }: ComponentProps<"table">): React.JSX.Element {
  const rows = useMemo(() => tableRowsFromNode(children), [children]);
  const [copied, copy] = useCopiedState();
  return (
    <div className="response-table-shell">
      <div className="response-table-toolbar">
        <span><Table2 size={13} />Table</span>
        <button type="button" onClick={() => void copy(tableAsMarkdown(rows))}>{copied ? <Check size={12} /> : <Copy size={12} />}Markdown</button>
        <button type="button" onClick={() => void copy(tableAsCsv(rows))}><Copy size={12} />CSV</button>
      </div>
      <div className="response-table-scroll"><table {...props}>{children}</table></div>
    </div>
  );
}

function codeMeta(meta: string | undefined): { label: string; file: string | null } {
  if (!meta) return { label: "Plain text", file: null };
  const fileMatch = /(?:^|\s)(?:file|filename|title)=["']?([^"'\s]+)["']?/iu.exec(meta);
  return { label: meta.split(/\s+/u)[0] || "Plain text", file: fileMatch?.[1] ?? null };
}

function HighlightedCode({ code, language, enabled }: { code: string; language: string; enabled: boolean }): React.JSX.Element {
  const html = useMemo(() => {
    if (!enabled || !language || !hljs.getLanguage(language)) return null;
    try {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }, [code, enabled, language]);
  return html
    ? <code className={`hljs language-${language}`} dangerouslySetInnerHTML={{ __html: html }} />
    : <code className={language ? `language-${language}` : undefined}>{code}</code>;
}

function CodeBlock({ children, defaultWrap, streaming }: { children: ReactNode; defaultWrap: boolean; streaming: boolean }): React.JSX.Element {
  const child = Children.toArray(children)[0];
  const element = isValidElement<{ className?: string; children?: ReactNode; node?: { properties?: Record<string, unknown> } }>(child) ? child : null;
  const code = nodeText(element?.props.children ?? children).replace(/\n$/u, "");
  const language = /^language-([\w+-]+)$/u.exec(element?.props.className ?? "")?.[1]?.toLocaleLowerCase("en-US") ?? "";
  const rawMeta = element?.props.node?.properties?.dataCodeMeta;
  const meta = codeMeta(typeof rawMeta === "string" ? rawMeta : language || undefined);
  const [wrap, setWrap] = useState(defaultWrap);
  const [copied, copy] = useCopiedState();
  useEffect(() => setWrap(defaultWrap), [defaultWrap]);
  const HeaderIcon = meta.file ? FileCode2 : Code2;
  return (
    <div className="response-code-block">
      <header>
        <span title={meta.file ?? undefined}><HeaderIcon size={13} />{meta.file ?? meta.label}</span>
        <div>
          <button type="button" aria-pressed={wrap} title={wrap ? "Disable code wrapping" : "Wrap long code lines"} onClick={() => setWrap((value) => !value)}><WrapText size={13} /><span>Wrap</span></button>
          <button type="button" title="Copy code" onClick={() => void copy(code)}>{copied ? <Check size={13} /> : <Copy size={13} />}<span>{copied ? "Copied" : "Copy"}</span></button>
        </div>
      </header>
      <pre className={wrap ? "wraps" : undefined}><HighlightedCode code={code} language={language} enabled={!streaming} /></pre>
    </div>
  );
}

export function stabilizeStreamingMarkdown(content: string): string {
  const fences = content.match(/^ {0,3}(?:```|~~~)/gmu) ?? [];
  if (fences.length % 2 === 0) return content;
  const marker = fences.at(-1)?.trim().startsWith("~~~") ? "~~~" : "```";
  return `${content}\n${marker}`;
}

export function ResponseMarkdown({ content, projectRoot, defaultCodeWrap, streaming = false }: ResponseMarkdownProps): React.JSX.Element {
  const renderedContent = streaming ? stabilizeStreamingMarkdown(content) : content;
  return (
    <div className="response-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, preserveCodeMeta]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
        components={{
          a: ({ href = "", children, ...props }) => {
            const target = resolveResponseLink(projectRoot, href);
            if (target.kind === "external") {
              return <a {...props} href={target.url} rel="noreferrer noopener" target="_blank" onClick={(event) => { event.preventDefault(); void window.inertia.openExternal(target.url); }}>{children}<ExternalLink size={11} aria-hidden="true" /></a>;
            }
            if (target.kind === "project") {
              return <a {...props} href={href} onClick={(event) => { event.preventDefault(); void window.inertia.openPath(target.path); }}>{children}</a>;
            }
            if (target.kind === "anchor") return <a {...props} href={target.href}>{children}</a>;
            return <span className="response-unsafe-link" title="This link was blocked because it is outside the project or uses an unsafe protocol.">{children}</span>;
          },
          pre: ({ children }) => <CodeBlock defaultWrap={defaultCodeWrap} streaming={streaming}>{children}</CodeBlock>,
          table: MarkdownTable,
          details: ({ children, ...props }) => <details {...props} className="response-details">{children}</details>,
        }}
      >
        {renderedContent}
      </ReactMarkdown>
    </div>
  );
}
