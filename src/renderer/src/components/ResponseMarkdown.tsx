import {
  Children,
  createContext,
  isValidElement,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useContext,
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
import {
  workspaceFileReferenceFallback,
} from "../utils/workspaceFileReference";
import { writeClipboardText } from "../utils/clipboard";

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

export const RESPONSE_MARKDOWN_TAG_NAMES = [
  "a", "blockquote", "br", "code", "dd", "del", "details", "div", "dl", "dt",
  "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "img", "input", "ins", "kbd",
  "li", "ol", "p", "pre", "q", "s", "samp", "section", "span", "strong", "sub",
  "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
  "var",
] as const;

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...RESPONSE_MARKDOWN_TAG_NAMES],
  protocols: {
    href: ["http", "https", "mailto"],
    src: ["http", "https", "data"],
    cite: ["http", "https"],
  },
  attributes: {
    a: ["href", "title"],
    img: ["src", "alt", "title"],
    div: [["className", "math", "math-display"]],
    span: [["className", /^hljs(?:-[a-z-]+)?$/u, /^language-[\w+-]+$/u, "math", "math-inline"]],
    code: [
      ["className", /^(?:hljs|language-[\w+-]+)$/u],
      "data-code-meta",
      "dataCodeMeta",
    ],
    details: ["open"],
    input: ["checked", "disabled", ["type", "checkbox"]],
    li: [["className", "task-list-item"]],
    ol: ["start", ["className", "contains-task-list"]],
    ul: [["className", "contains-task-list"]],
    td: ["colSpan", "rowSpan", ["align", "left", "center", "right"]],
    th: ["colSpan", "rowSpan", ["align", "left", "center", "right"]],
    "*": [],
  },
};
const REMARK_PLUGINS: NonNullable<
  ComponentProps<typeof ReactMarkdown>["remarkPlugins"]
> = [remarkGfm, preserveCodeMeta];
const REHYPE_PLUGINS: NonNullable<
  ComponentProps<typeof ReactMarkdown>["rehypePlugins"]
> = [rehypeRaw, [rehypeSanitize, sanitizeSchema]];
const MAX_HIGHLIGHT_CHARS = 50_000;
const MAX_HIGHLIGHT_LINES = 2_000;

type ResponseMarkdownProps = {
  content: string;
  projectRoot: string;
  projectId: string;
  conversationId?: string;
  defaultCodeWrap: boolean;
  streaming?: boolean;
  announceCopyFeedback?: boolean;
  onOpenProjectFile?: (path: string) => void;
};

type ProjectLink =
  | { kind: "external"; url: string }
  | { kind: "project"; relativePath: string; action: "reveal" }
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
            "data-code-meta": node.meta.trim(),
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
  const windowsAbsolute = /^[a-z]:[\\/]/iu.test(href);
  const scheme = /^[a-z][a-z0-9+.-]*:/iu.exec(href)?.[0] ?? null;
  if (!windowsAbsolute && scheme) {
    if (/^https?:$/iu.test(scheme)) {
      try {
        const url = new URL(href);
        return { kind: "external", url: url.toString() };
      } catch {
        return { kind: "unsafe" };
      }
    }
    const fallback = workspaceFileReferenceFallback(href);
    if (
      !fallback
      || !scheme.includes(".")
    ) return { kind: "unsafe" };
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.split("#", 1)[0]!.split("?", 1)[0]!);
  } catch {
    return { kind: "unsafe" };
  }
  if (
    !decoded
    || /[\0\r\n]/u.test(decoded)
  ) return { kind: "unsafe" };
  const root = normalizedPath(projectRoot).replace(/\/+$/u, "");
  if (!root) return { kind: "unsafe" };
  const isAbsolute = decoded.startsWith("/") || /^[a-z]:[\\/]/iu.test(decoded);
  const candidate = normalizedPath(isAbsolute ? decoded : `${root}/${decoded}`);
  const insensitive = /^[a-z]:\//iu.test(root);
  const comparableRoot = insensitive ? root.toLocaleLowerCase("en-US") : root;
  const comparableCandidate = insensitive ? candidate.toLocaleLowerCase("en-US") : candidate;
  if (comparableCandidate !== comparableRoot && !comparableCandidate.startsWith(`${comparableRoot}/`)) return { kind: "unsafe" };
  const relativePath = candidate === root ? "." : candidate.slice(root.length + 1);
  return relativePath ? { kind: "project", relativePath, action: "reveal" } : { kind: "unsafe" };
}

export function responseLinkHasDirectoryHint(rawHref: string): boolean {
  const path = rawHref.trim().split("#", 1)[0]!.split("?", 1)[0]!;
  try {
    return /[\\/]$/u.test(decodeURIComponent(path));
  } catch {
    return false;
  }
}

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

interface ClipboardControlState {
  copied: boolean;
  pending: boolean;
  error: string | null;
  copy: (text: string) => Promise<void>;
}

function useCopiedState(): ClipboardControlState {
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const operation = useRef(0);
  useEffect(() => () => {
    operation.current += 1;
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const copy = async (text: string): Promise<void> => {
    const sequence = operation.current + 1;
    operation.current = sequence;
    setPending(true);
    setCopied(false);
    setError(null);
    const succeeded = await writeClipboardText(text);
    if (operation.current !== sequence) return;
    setPending(false);
    if (!succeeded) {
      setError("Couldn't copy. Try again or select the text manually.");
      return;
    }
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1_500);
  };
  return { copied, pending, error, copy };
}

function quoteCsvCell(value: string): string {
  const safeValue = /^[\t\r]/u.test(value)
    || /^[\s\u0000-\u001f]*[=+@-]/u.test(value)
    ? `'${value}`
    : value;
  return /[",\n\r]/u.test(safeValue)
    ? `"${safeValue.replace(/"/gu, "\"\"")}"`
    : safeValue;
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
  const { announceCopyFeedback } = useMarkdownRenderContext();
  const rows = useMemo(() => tableRowsFromNode(children), [children]);
  const markdownCopy = useCopiedState();
  const csvCopy = useCopiedState();
  return (
    <div className="response-table-shell">
      <div className="response-table-toolbar">
        <span><Table2 size={13} />Table</span>
        <button type="button" disabled={markdownCopy.pending} onClick={() => void markdownCopy.copy(tableAsMarkdown(rows))}>{markdownCopy.copied ? <Check size={12} /> : <Copy size={12} />}<span>{markdownCopy.pending ? "Copying Markdown" : markdownCopy.copied ? "Copied Markdown" : "Markdown"}</span></button>
        <button type="button" disabled={csvCopy.pending} onClick={() => void csvCopy.copy(tableAsCsv(rows))}>{csvCopy.copied ? <Check size={12} /> : <Copy size={12} />}<span>{csvCopy.pending ? "Copying CSV" : csvCopy.copied ? "Copied CSV" : "CSV"}</span></button>
      </div>
      {(markdownCopy.error || csvCopy.error) && (
        <p className="response-copy-error" role="alert">
          {markdownCopy.error ?? csvCopy.error}
        </p>
      )}
      {announceCopyFeedback && (
        <span className="visually-hidden" role="status" aria-live="polite">
          {markdownCopy.copied
            ? "Table copied as Markdown."
            : csvCopy.copied
              ? "Table copied as CSV."
              : ""}
        </span>
      )}
      <div className="response-table-scroll"><table {...props}>{children}</table></div>
    </div>
  );
}

function codeMeta(meta: string | undefined): { label: string; file: string | null } {
  if (!meta) return { label: "Plain text", file: null };
  const fileMatch =
    /(?:^|\s)(?:file|filename|title)=(?:"([^"]+)"|'([^']+)'|([^\s]+))/iu
      .exec(meta);
  return {
    label: meta.split(/\s+/u)[0] || "Plain text",
    file: fileMatch?.[1] ?? fileMatch?.[2] ?? fileMatch?.[3] ?? null,
  };
}

function HighlightedCode({ code, language, enabled }: { code: string; language: string; enabled: boolean }): React.JSX.Element {
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
  return html
    ? <code className={`hljs language-${language}`} dangerouslySetInnerHTML={{ __html: html }} />
    : <code className={language ? `language-${language}` : undefined}>{code}</code>;
}

function CodeBlock({
  children,
  defaultWrap,
  streaming,
  projectRoot,
  onOpenProjectFile,
}: {
  children: ReactNode;
  defaultWrap: boolean;
  streaming: boolean;
  projectRoot: string;
  onOpenProjectFile?: (path: string) => void;
}): React.JSX.Element {
  const { announceCopyFeedback } = useMarkdownRenderContext();
  const child = Children.toArray(children)[0];
  const element = isValidElement<{
    className?: string;
    children?: ReactNode;
    node?: { properties?: Record<string, unknown> };
    dataCodeMeta?: unknown;
    "data-code-meta"?: unknown;
  }>(child) ? child : null;
  const code = nodeText(element?.props.children ?? children).replace(/\n$/u, "");
  const language = /^language-([\w+-]+)$/u.exec(element?.props.className ?? "")?.[1]?.toLocaleLowerCase("en-US") ?? "";
  const rawMeta = element?.props.node?.properties?.dataCodeMeta
    ?? element?.props.node?.properties?.["data-code-meta"]
    ?? element?.props.dataCodeMeta
    ?? element?.props["data-code-meta"];
  const meta = codeMeta(typeof rawMeta === "string" ? rawMeta : language || undefined);
  const [wrap, setWrap] = useState(defaultWrap);
  const clipboard = useCopiedState();
  useEffect(() => setWrap(defaultWrap), [defaultWrap]);
  const HeaderIcon = meta.file ? FileCode2 : Code2;
  const fileTarget = meta.file
    ? resolveResponseLink(projectRoot, meta.file)
    : null;
  const fileLabel = (
    <>
      <HeaderIcon size={13} />
      {meta.file ?? meta.label}
    </>
  );
  return (
    <div className="response-code-block">
      <header>
        {fileTarget?.kind === "project" && onOpenProjectFile
          ? (
              <button
                type="button"
                className="response-code-file-link"
                title={`Open ${fileTarget.relativePath} in Files`}
                onClick={() => onOpenProjectFile(fileTarget.relativePath)}
              >
                {fileLabel}
              </button>
            )
          : <span title={meta.file ?? undefined}>{fileLabel}</span>}
        <div>
          <button type="button" aria-pressed={wrap} title={wrap ? "Disable code wrapping" : "Wrap long code lines"} onClick={() => setWrap((value) => !value)}><WrapText size={13} /><span>Wrap</span></button>
          <button type="button" title="Copy code" disabled={clipboard.pending} onClick={() => void clipboard.copy(code)}>{clipboard.copied ? <Check size={13} /> : <Copy size={13} />}<span>{clipboard.pending ? "Copying" : clipboard.copied ? "Copied" : "Copy"}</span></button>
        </div>
      </header>
      {clipboard.error && (
        <p className="response-copy-error" role="alert">
          {clipboard.error}
        </p>
      )}
      {announceCopyFeedback && (
        <span className="visually-hidden" role="status" aria-live="polite">
          {clipboard.copied ? "Code copied to clipboard." : ""}
        </span>
      )}
      <pre className={wrap ? "wraps" : undefined}><HighlightedCode code={code} language={language} enabled={!streaming} /></pre>
    </div>
  );
}

interface MarkdownRenderContextValue {
  projectRoot: string;
  projectId: string;
  conversationId?: string;
  defaultCodeWrap: boolean;
  streaming: boolean;
  announceCopyFeedback: boolean;
  onOpenProjectFile?: (path: string) => void;
}

const MarkdownRenderContext = createContext<MarkdownRenderContextValue | null>(
  null,
);

function useMarkdownRenderContext(): MarkdownRenderContextValue {
  const context = useContext(MarkdownRenderContext);
  if (!context) throw new Error("Markdown renderer context is unavailable.");
  return context;
}

function MarkdownLink({
  href = "",
  children,
  ...props
}: ComponentProps<"a">): React.JSX.Element {
  const {
    projectRoot,
    projectId,
    conversationId,
    onOpenProjectFile,
  } = useMarkdownRenderContext();
  const target = resolveResponseLink(projectRoot, href);
  if (target.kind === "external") {
    return <a {...props} href={target.url} rel="noreferrer noopener" target="_blank" onClick={(event) => { event.preventDefault(); void window.inertia.openExternal(target.url); }}>{children}<ExternalLink size={11} aria-hidden="true" /></a>;
  }
  if (target.kind === "project") {
    return <a {...props} href={href} onClick={(event) => {
      event.preventDefault();
      if (onOpenProjectFile && !responseLinkHasDirectoryHint(href)) {
        onOpenProjectFile(target.relativePath);
        return;
      }
      void window.inertia.openProjectPath({
        projectId,
        ...(conversationId ? { conversationId } : {}),
        relativePath: target.relativePath,
        action: target.action,
      }).catch(() => undefined);
    }}>{children}</a>;
  }
  if (target.kind === "anchor") {
    return <a {...props} href={target.href}>{children}</a>;
  }
  return <span className="response-unsafe-link" title="This link was blocked because it is outside the project or uses an unsafe protocol.">{children}</span>;
}

function MarkdownCodeBlock({ children }: ComponentProps<"pre">): React.JSX.Element {
  const {
    defaultCodeWrap,
    streaming,
    projectRoot,
    onOpenProjectFile,
  } = useMarkdownRenderContext();
  return (
    <CodeBlock
      defaultWrap={defaultCodeWrap}
      streaming={streaming}
      projectRoot={projectRoot}
      onOpenProjectFile={onOpenProjectFile}
    >
      {children}
    </CodeBlock>
  );
}

function MarkdownDetails({
  children,
  ...props
}: ComponentProps<"details">): React.JSX.Element {
  return <details {...props} className="response-details">{children}</details>;
}

const RESPONSE_MARKDOWN_COMPONENTS: NonNullable<
  ComponentProps<typeof ReactMarkdown>["components"]
> = {
  a: MarkdownLink,
  pre: MarkdownCodeBlock,
  table: MarkdownTable,
  details: MarkdownDetails,
};

export function stabilizeStreamingMarkdown(content: string): string {
  const fences = content.match(/^ {0,3}(?:```|~~~)/gmu) ?? [];
  if (fences.length % 2 === 0) return content;
  const marker = fences.at(-1)?.trim().startsWith("~~~") ? "~~~" : "```";
  return `${content}\n${marker}`;
}

function ResponseMarkdownComponent({
  content,
  projectRoot,
  projectId,
  conversationId,
  defaultCodeWrap,
  streaming = false,
  announceCopyFeedback = true,
  onOpenProjectFile,
}: ResponseMarkdownProps): React.JSX.Element {
  const renderedContent = streaming ? stabilizeStreamingMarkdown(content) : content;
  const renderContext = useMemo<MarkdownRenderContextValue>(() => ({
    projectRoot,
    projectId,
    conversationId,
    defaultCodeWrap,
    streaming,
    announceCopyFeedback,
    onOpenProjectFile,
  }), [
    announceCopyFeedback,
    conversationId,
    defaultCodeWrap,
    onOpenProjectFile,
    projectId,
    projectRoot,
    streaming,
  ]);
  return (
    <MarkdownRenderContext.Provider value={renderContext}>
      <div className={`response-markdown${streaming ? " is-streaming" : ""}`}>
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          components={RESPONSE_MARKDOWN_COMPONENTS}
        >
          {renderedContent}
        </ReactMarkdown>
      </div>
    </MarkdownRenderContext.Provider>
  );
}

export const ResponseMarkdown = memo(ResponseMarkdownComponent);
