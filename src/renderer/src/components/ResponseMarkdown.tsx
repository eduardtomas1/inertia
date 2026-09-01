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
  FileCode2,
  Table2,
  WrapText,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import {
  sourceLanguageForFile,
  sourceLanguageFromAlias,
  type SourceLanguage,
} from "@shared/source-language";
import {
  workspaceFileLocationFromFragment,
  workspaceFileReference,
  workspaceFileReferenceFallback,
  type WorkspaceFileLocation,
} from "../utils/workspaceFileReference";
import { writeClipboardText } from "../utils/clipboard";
import { highlightedSourceHtml } from "../utils/sourceHighlighting";
import { applicationRendererScheme, workspaceImagePreviewUrl } from "@shared/workspace-image-preview";
import { markdownHeadingDomId } from "../utils/markdownHeading";
import {
  MarkdownImageSchedulerProvider,
  useMarkdownImageSchedule,
} from "./markdown/MarkdownImageScheduler";

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
    src: ["http", "https"],
    cite: ["http", "https"],
  },
  attributes: {
    a: ["href", "title"],
    img: ["src", "alt", "title"],
    h1: ["id"],
    h2: ["id"],
    h3: ["id"],
    h4: ["id"],
    h5: ["id"],
    h6: ["id"],
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
> = [rehypeRaw, stableHeadingIds, [rehypeSanitize, sanitizeSchema]];
type ResponseMarkdownProps = {
  content: string;
  projectRoot: string;
  projectId: string;
  conversationId?: string;
  markdownBasePath?: string;
  defaultCodeWrap: boolean;
  streaming?: boolean;
  announceCopyFeedback?: boolean;
  onOpenProjectFile?: (
    path: string,
    location?: WorkspaceFileLocation,
    literalPath?: boolean,
    headingId?: string,
  ) => void;
};

type ProjectLink =
  | { kind: "external"; url: string }
  | {
      kind: "project";
      relativePath: string;
      action: "reveal";
      location?: WorkspaceFileLocation;
      literalPath?: boolean;
      headingId?: string;
    }
  | { kind: "anchor"; href: string }
  | { kind: "unsafe" };

type MarkdownAstNode = {
  type?: string;
  value?: unknown;
  url?: unknown;
  meta?: unknown;
  data?: { hProperties?: Record<string, unknown> };
  children?: MarkdownAstNode[];
};

type MarkdownHtmlNode = {
  type?: string;
  tagName?: string;
  value?: unknown;
  properties?: Record<string, unknown>;
  children?: MarkdownHtmlNode[];
};

const GITHUB_HEADING_PUNCTUATION = /[\u2000-\u206f\u2e00-\u2e7f\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/gu;

export function githubHeadingSlug(value: string): string {
  return value
    .toLocaleLowerCase("en-US")
    .trim()
    .replace(GITHUB_HEADING_PUNCTUATION, "")
    .replace(/\s/gu, "-");
}

function uniqueGithubHeadingSlug(
  value: string,
  occurrences: Map<string, number>,
): string {
  const original = githubHeadingSlug(value);
  let slug = original;
  while (occurrences.has(slug)) {
    const next = (occurrences.get(original) ?? 0) + 1;
    occurrences.set(original, next);
    slug = `${original}-${next}`;
  }
  occurrences.set(slug, 0);
  return slug;
}

function markdownHtmlText(node: MarkdownHtmlNode): string {
  if (typeof node.value === "string") return node.value;
  return node.children?.map(markdownHtmlText).join("") ?? "";
}

function stableHeadingIds() {
  return (tree: MarkdownHtmlNode) => {
    const occurrences = new Map<string, number>();
    const visit = (node: MarkdownHtmlNode): void => {
      if (
        node.type === "element"
        && /^h[1-6]$/u.test(node.tagName ?? "")
      ) {
        node.properties = {
          ...node.properties,
          id: uniqueGithubHeadingSlug(markdownHtmlText(node), occurrences),
        };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

function preserveCodeMeta() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode): void => {
      if (node.type === "link" && typeof node.url === "string") {
        const fallback = workspaceFileReferenceFallback(node.url);
        if (
          /^[a-z]:[\\/]/iu.test(node.url)
        ) {
          node.url = node.url.replace(":", "%3A");
        } else if (fallback !== null && !/[\\/]/u.test(fallback)) {
          node.url = `./${node.url}`;
        }
      }
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
  const unc = !drive && slash.startsWith("//");
  const absolute = slash.startsWith("/") || Boolean(drive);
  const rest = drive
    ? slash.slice(drive.length)
    : unc
      ? slash.slice(2)
      : slash;
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
  const prefix = drive ? `${drive}/` : unc ? "//" : absolute ? "/" : "";
  return `${prefix}${segments.join("/")}` || (absolute ? prefix : ".");
}

export function resolveResponseLink(
  projectRoot: string,
  rawHref: string,
  syntax: "markdown" | "file" = "markdown",
  markdownBasePath = "",
): ProjectLink {
  const href = rawHref.trim();
  if (!href || href.includes("\0")) return { kind: "unsafe" };
  if (syntax === "markdown" && href.startsWith("#")) {
    return { kind: "anchor", href };
  }
  const windowsAbsolute = /^[a-z]:[\\/]/iu.test(href);
  const uncAbsolute = /^(?:\\\\|\/\/)/u.test(href);
  const scheme = /^[a-z][a-z0-9+.-]*:/iu.exec(href)?.[0] ?? null;
  if (syntax === "markdown" && !windowsAbsolute && !uncAbsolute && scheme) {
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
      || /[\\/]/u.test(fallback)
    ) return { kind: "unsafe" };
  }
  const hashIndex = syntax === "file"
    ? href.lastIndexOf("#")
    : href.indexOf("#");
  const fragmentLocation = hashIndex >= 0
    ? workspaceFileLocationFromFragment(href.slice(hashIndex))
    : null;
  const headingId = syntax === "markdown" && hashIndex >= 0 && !fragmentLocation
    ? responseHeadingIdFromFragment(href.slice(hashIndex))
    : null;
  let rawPath = syntax === "file"
    ? fragmentLocation
      ? href.slice(0, hashIndex)
      : href
    : href.slice(0, hashIndex >= 0 ? hashIndex : undefined).split("?", 1)[0]!;
  let location = fragmentLocation;
  const rawSourceReference = location === null
    ? workspaceFileReference(rawPath)
    : null;
  const rawSourcePathHasEncodedDelimiter = rawSourceReference !== null
    && /%(?:23|3a|3f)/iu.test(rawSourceReference.path);
  if (rawSourceReference && rawSourcePathHasEncodedDelimiter) {
    rawPath = rawSourceReference.path;
    location = rawSourceReference.location;
  }
  if (
    syntax === "markdown"
    && rawPath.startsWith("./")
    && /^[a-z]%3a(?:%2f|%5c|[\\/])/iu.test(rawPath.slice(2))
  ) {
    rawPath = rawPath.slice(2);
  }
  const encodedWindowsAbsolute = /^[a-z]%3a(?:%2f|%5c|[\\/])/iu.test(rawPath);
  const encodedPathDelimiter = /%(?:23|3a|3f)/iu.test(
    encodedWindowsAbsolute ? rawPath.slice(4) : rawPath,
  );
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { kind: "unsafe" };
  }
  if (
    !decoded
    || /[\0\r\n]/u.test(decoded)
  ) return { kind: "unsafe" };
  const root = normalizedPath(projectRoot).replace(/\/+$/u, "");
  if (!root) return { kind: "unsafe" };
  const base = syntax === "markdown" && markdownBasePath
    ? normalizedPath(`${root}/${markdownBasePath}`)
    : root;
  const markdownCollapsedUnc = root.startsWith("//")
    && decoded.startsWith("\\")
    && !decoded.startsWith("\\\\");
  const resolvedDecoded = markdownCollapsedUnc ? `\\${decoded}` : decoded;
  const isAbsolute = resolvedDecoded.startsWith("/")
    || /^[a-z]:[\\/]/iu.test(decoded)
    || resolvedDecoded.startsWith("\\\\");
  const candidate = normalizedPath(
    isAbsolute ? resolvedDecoded : `${base}/${resolvedDecoded}`,
  );
  const insensitive = /^[a-z]:\//iu.test(root) || root.startsWith("//");
  const comparableRoot = insensitive ? root.toLocaleLowerCase("en-US") : root;
  const comparableCandidate = insensitive ? candidate.toLocaleLowerCase("en-US") : candidate;
  if (comparableCandidate !== comparableRoot && !comparableCandidate.startsWith(`${comparableRoot}/`)) return { kind: "unsafe" };
  const relativePath = candidate === root ? "." : candidate.slice(root.length + 1);
  return relativePath
    ? {
        kind: "project",
        relativePath,
        action: "reveal",
        ...(location ? { location } : {}),
        ...(encodedPathDelimiter ? { literalPath: true } : {}),
        ...(headingId ? { headingId } : {}),
      }
    : { kind: "unsafe" };
}

export function responseHeadingIdFromFragment(fragment: string): string | null {
  const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (!raw || raw.length > 512) return null;
  try {
    const decoded = decodeURIComponent(raw);
    return decoded && !/[\0\r\n]/u.test(decoded) ? decoded : null;
  } catch {
    return null;
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

function codeMeta(
  meta: string | undefined,
  language: string,
): { label: string; file: string | null } {
  if (!meta) return { label: language || "Plain text", file: null };
  const fileMatch =
    /(?:^|\s)(?:file|filename|title)=(?:"([^"]+)"|'([^']+)'|([^\s]+))/iu
      .exec(meta);
  return {
    label: language || meta.split(/\s+/u)[0] || "Plain text",
    file: fileMatch?.[1] ?? fileMatch?.[2] ?? fileMatch?.[3] ?? null,
  };
}

function HighlightedCode({
  code,
  language,
  classLanguage,
  enabled,
}: {
  code: string;
  language: SourceLanguage;
  classLanguage: string;
  enabled: boolean;
}): React.JSX.Element {
  const html = useMemo(
    () => highlightedSourceHtml(code, language, enabled),
    [code, enabled, language],
  );
  return html
    ? <code className={`hljs language-${classLanguage}`} dangerouslySetInnerHTML={{ __html: html }} />
    : <code className={classLanguage ? `language-${classLanguage}` : undefined}>{code}</code>;
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
  onOpenProjectFile?: (
    path: string,
    location?: WorkspaceFileLocation,
    literalPath?: boolean,
    headingId?: string,
  ) => void;
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
  const meta = codeMeta(
    typeof rawMeta === "string" ? rawMeta : undefined,
    language,
  );
  const fileTarget = meta.file
    ? resolveResponseLink(projectRoot, meta.file, "file")
    : null;
  const fileLanguagePath = fileTarget?.kind === "project"
    ? workspaceFileReferenceFallback(fileTarget.relativePath)
      ?? fileTarget.relativePath
    : meta.file ?? "";
  const declaredLanguage = sourceLanguageFromAlias(language);
  const fileLanguage = fileTarget?.kind === "project"
    ? sourceLanguageForFile(fileLanguagePath, code)
    : null;
  const recognizedFileLanguage = fileLanguage
    && fileLanguage.id !== "file"
    && fileLanguage.id !== "text"
    ? fileLanguage
    : null;
  const sourceLanguage = recognizedFileLanguage
    ?? declaredLanguage
    ?? fileLanguage
    ?? sourceLanguageForFile("", code);
  const [wrap, setWrap] = useState(defaultWrap);
  const clipboard = useCopiedState();
  useEffect(() => setWrap(defaultWrap), [defaultWrap]);
  const HeaderIcon = meta.file ? FileCode2 : Code2;
  const fileLabel = (
    <>
      <HeaderIcon size={13} />
      {meta.file ?? meta.label}
    </>
  );
  return (
    <div
      className="response-code-block"
      data-language-family={sourceLanguage.family}
    >
      <header>
        {fileTarget?.kind === "project" && onOpenProjectFile
          ? (
              <button
                type="button"
                className="response-code-file-link"
                title={`Open ${fileTarget.relativePath} in Files`}
                data-language-family={sourceLanguage.family}
                onClick={() => {
                  if (fileTarget.literalPath) {
                    onOpenProjectFile(
                      fileTarget.relativePath,
                      fileTarget.location ?? undefined,
                      true,
                    );
                  } else if (fileTarget.location) {
                    onOpenProjectFile(
                      fileTarget.relativePath,
                      fileTarget.location,
                    );
                  } else {
                    onOpenProjectFile(fileTarget.relativePath);
                  }
                }}
              >
                {fileLabel}
              </button>
            )
          : (
              <span
                title={meta.file ?? undefined}
                data-language-family={sourceLanguage.family}
              >
                {meta.file ? fileLabel : (
                  <>
                    <HeaderIcon size={13} />
                    {sourceLanguage.label === "Text"
                      ? meta.label
                      : sourceLanguage.label}
                  </>
                )}
              </span>
            )}
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
      <pre className={wrap ? "wraps" : undefined}><HighlightedCode code={code} language={sourceLanguage} classLanguage={sourceLanguage === declaredLanguage ? language : sourceLanguage.id} enabled={!streaming} /></pre>
    </div>
  );
}

interface MarkdownRenderContextValue {
  projectRoot: string;
  projectId: string;
  conversationId?: string;
  markdownBasePath: string;
  defaultCodeWrap: boolean;
  streaming: boolean;
  announceCopyFeedback: boolean;
  onOpenProjectFile?: (
    path: string,
    location?: WorkspaceFileLocation,
    literalPath?: boolean,
    headingId?: string,
  ) => void;
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
    markdownBasePath,
    onOpenProjectFile,
  } = useMarkdownRenderContext();
  const target = resolveResponseLink(
    projectRoot,
    href,
    "markdown",
    markdownBasePath,
  );
  if (target.kind === "external") {
    const externalLinkClass = [props.className, "response-web-link"]
      .filter(Boolean)
      .join(" ");
    return (
      <a
        {...props}
        className={externalLinkClass}
        href={target.url}
        rel="noreferrer noopener"
        target="_blank"
        onClick={(event) => {
          event.preventDefault();
          void window.inertia.openExternal(target.url);
        }}
      >
        <svg
          aria-hidden="true"
          fill="none"
          height="12"
          stroke="currentColor"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width="12"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" />
        </svg>
        {children}
      </a>
    );
  }
  if (target.kind === "project") {
    const language = sourceLanguageForFile(
      workspaceFileReferenceFallback(target.relativePath)
        ?? target.relativePath,
    );
    const projectLinkClass = [props.className, "response-project-file-link"]
      .filter(Boolean)
      .join(" ");
    const FileIcon = language.id === "sql" ? Table2 : FileCode2;
    return (
      <a
        {...props}
        className={projectLinkClass}
        data-language-family={language.family}
        href={href}
        onClick={(event) => {
          event.preventDefault();
          if (onOpenProjectFile) {
            if (target.headingId) {
              onOpenProjectFile(
                target.relativePath,
                target.location,
                target.literalPath,
                target.headingId,
              );
            } else if (target.literalPath) {
              onOpenProjectFile(
                target.relativePath,
                target.location ?? undefined,
                true,
              );
            } else if (target.location) {
              onOpenProjectFile(target.relativePath, target.location);
            } else {
              onOpenProjectFile(target.relativePath);
            }
            return;
          }
          void window.inertia.openProjectPath({
            projectId,
            ...(conversationId ? { conversationId } : {}),
            relativePath: target.relativePath,
            action: target.action,
          }).catch(() => undefined);
        }}
      >
        <FileIcon
          className="response-project-file-icon"
          size={13}
          aria-hidden="true"
        />
        <span>{children}</span>
      </a>
    );
  }
  if (target.kind === "anchor") {
    return <a {...props} href={target.href} onClick={(event) => {
      event.preventDefault();
      const headingId = responseHeadingIdFromFragment(target.href);
      const markdown = event.currentTarget.closest(".response-markdown");
      const heading = headingId
        ? [...(markdown?.querySelectorAll<HTMLElement>("[id]") ?? [])]
          .find(({ id }) => id === markdownHeadingDomId(headingId))
        : null;
      heading?.scrollIntoView({ block: "start", inline: "nearest" });
      if (heading) heading.tabIndex = -1;
      heading?.focus({ preventScroll: true });
    }}>{children}</a>;
  }
  return <span className="response-unsafe-link" title="This link was blocked because it is outside the project or uses an unsafe protocol.">{children}</span>;
}

function MarkdownImage({
  src = "",
  alt = "",
  title,
  className,
}: ComponentProps<"img">): React.JSX.Element {
  const {
    projectRoot,
    projectId,
    conversationId,
    markdownBasePath,
  } = useMarkdownRenderContext();
  const unavailableAlt = alt.trim();
  const target = resolveResponseLink(
    projectRoot,
    src,
    "markdown",
    markdownBasePath,
  );
  const trustedSource = target.kind === "project"
      ? workspaceImagePreviewUrl({
        projectId,
        ...(conversationId ? { conversationId } : {}),
        relativePath: target.relativePath,
      }, applicationRendererScheme(globalThis.location?.protocol))
    : null;
  const schedule = useMarkdownImageSchedule(trustedSource);
  const placeholder = (reason: string, overflow = false): React.JSX.Element => {
    const message = unavailableAlt
      ? `${unavailableAlt} (${reason})`
      : reason.charAt(0).toUpperCase() + reason.slice(1);
    return unavailableAlt ? (
      <span
        className="response-markdown-image-unavailable"
        role="img"
        aria-label={unavailableAlt}
        data-markdown-image-overflow={overflow ? "true" : undefined}
        title={title}
      >
        {message}
      </span>
    ) : (
      <span
        className="response-markdown-image-unavailable"
        aria-hidden="true"
        data-markdown-image-overflow={overflow ? "true" : undefined}
        title={title}
      >
        {message}
      </span>
    );
  };
  if (!trustedSource) {
    return placeholder("image unavailable");
  }
  return (
    <span
      ref={schedule.shellRef}
      className="response-markdown-image-shell"
      data-markdown-image-state={schedule.state}
    >
      {schedule.state === "loading" || schedule.state === "loaded" ? (
        <img
          src={trustedSource}
          alt={alt}
          title={title}
          className={className}
          loading="lazy"
          decoding="async"
          onLoad={() => schedule.complete(false)}
          onError={() => schedule.complete(true)}
        />
      ) : schedule.state === "overflow"
        ? placeholder("image not loaded: document image limit reached", true)
        : schedule.state === "error"
          ? placeholder("image unavailable")
          : placeholder("image waiting to load")}
    </span>
  );
}

function MarkdownParagraph(props: ComponentProps<"p">): React.JSX.Element {
  const { streaming } = useMarkdownRenderContext();
  return <p {...props}>{streaming
    ? Children.map(props.children, (child) => typeof child === "string"
      ? child.split(/(\s+)/u).map((word, index) => /\S/u.test(word)
        ? <span className="response-stream-word" key={index}>{word}</span>
        : word)
      : child)
    : props.children}</p>;
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
  p: MarkdownParagraph,
  pre: MarkdownCodeBlock,
  table: MarkdownTable,
  details: MarkdownDetails,
  img: MarkdownImage,
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
  markdownBasePath = "",
  defaultCodeWrap,
  streaming = false,
  announceCopyFeedback = true,
  onOpenProjectFile,
}: ResponseMarkdownProps): React.JSX.Element {
  const renderedContent = streaming ? stabilizeStreamingMarkdown(content) : content;
  const imageSchedulerIdentity = [
    projectRoot,
    projectId,
    conversationId ?? "",
    markdownBasePath,
  ].join("\0");
  const renderContext = useMemo<MarkdownRenderContextValue>(() => ({
    projectRoot,
    projectId,
    conversationId,
    markdownBasePath,
    defaultCodeWrap,
    streaming,
    announceCopyFeedback,
    onOpenProjectFile,
  }), [
    announceCopyFeedback,
    conversationId,
    defaultCodeWrap,
    markdownBasePath,
    onOpenProjectFile,
    projectId,
    projectRoot,
    streaming,
  ]);
  return (
    <MarkdownRenderContext.Provider value={renderContext}>
      <MarkdownImageSchedulerProvider key={imageSchedulerIdentity}>
        <div className={`response-markdown${streaming ? " is-streaming" : ""}`}>
          <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_PLUGINS}
            components={RESPONSE_MARKDOWN_COMPONENTS}
          >
            {renderedContent}
          </ReactMarkdown>
        </div>
      </MarkdownImageSchedulerProvider>
    </MarkdownRenderContext.Provider>
  );
}

export const ResponseMarkdown = memo(ResponseMarkdownComponent);
