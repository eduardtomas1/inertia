import {
  Children,
  createContext,
  isValidElement,
  memo,
  useEffect,
  useMemo,
  useState,
  useContext,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  Check,
  Code2,
  Copy,
  Database,
  FileCode2,
} from "lucide-react";
import ReactMarkdown, { defaultUrlTransform, type ExtraProps } from "react-markdown";
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
import { useCopiedState } from "../hooks/useCopiedState";
import {
  contextMenuHandlers,
  hasNativeMenuTarget,
  isContextMenuId,
  projectPathContextMenu,
  selectionInside,
  showEditorPickMenu,
} from "../utils/contextMenu";
import { isEditorId } from "@shared/editor-ids";
import { useEditorPreference } from "../hooks/useAvailableEditors";
import { highlightedSourceHtml } from "../utils/sourceHighlighting";
import { createBoundedCache } from "../utils/boundedCache";
import {
  classifyWorkspaceMediaPath,
  type WorkspaceMediaPreviewTarget,
} from "@shared/workspace-media-preview";
import { markdownHeadingDomId } from "../utils/markdownHeading";
import { encodedLocalFilePath, localFileLocationSuffix, localFileUrl, parseLocalFileUrl } from "@shared/local-file-url";
import { MarkdownImageSchedulerProvider } from "./markdown/MarkdownImageScheduler";
import {
  MarkdownMediaEmbed,
  workspaceMediaIcon,
  workspaceMediaPreviewTargetForPath,
} from "./markdown/MarkdownMedia";
import { TooltipButton } from "./TooltipButton";
import { TooltipText } from "./TooltipText";
import { FileChip } from "./response-timeline/FileChip";
import {
  fileChipReference,
  MAX_FILE_CHIPS_PER_DOCUMENT,
} from "../utils/fileChipReference";

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
    href: ["http", "https", "mailto", "file"],
    src: ["http", "https", "file"],
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
> = [rehypeRaw, stableHeadingIds, [rehypeSanitize, sanitizeSchema], markFileChips];
type ResponseMarkdownProps = {
  content: string;
  projectRoot: string;
  projectBaseRoot?: string;
  projectId: string;
  conversationId?: string;
  markdownBasePath?: string;
  defaultCodeWrap: boolean;
  streaming?: boolean;
  announceCopyFeedback?: boolean;
  fileChips?: boolean;
  onOpenProjectFile?: (
    path: string,
    location?: WorkspaceFileLocation,
    literalPath?: boolean,
    headingId?: string,
  ) => void;
  onPreviewMedia?: (target: WorkspaceMediaPreviewTarget) => void;
};

type ProjectLink =
  | { kind: "external"; url: string }
  | { kind: "local"; path: string; url: string }
  | {
      kind: "project";
      relativePath: string;
      action: "reveal";
      owner?: "project";
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

const FILE_CHIP_PROPERTY = "dataResponseFileChip";
const FILE_CHIP_BOUNDARIES = new Set(["a", "pre", "summary"]);

function markFileChips() {
  return (tree: MarkdownHtmlNode) => {
    let chips = 0;
    const visit = (node: MarkdownHtmlNode): void => {
      if (chips >= MAX_FILE_CHIPS_PER_DOCUMENT) return;
      if (node.type === "element") {
        if (FILE_CHIP_BOUNDARIES.has(node.tagName ?? "")) return;
        if (node.tagName === "code") {
          const [text, ...rest] = node.children ?? [];
          if (
            rest.length === 0
            && text?.type === "text"
            && typeof text.value === "string"
            && fileChipReference(text.value)
          ) {
            node.properties = { ...node.properties, [FILE_CHIP_PROPERTY]: "" };
            chips += 1;
          }
          return;
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

function preserveCodeMeta() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode): void => {
      if ((node.type === "link" || node.type === "image") && typeof node.url === "string") {
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

function windowsStyleRoot(root: string): boolean {
  return /^[a-z]:\//iu.test(root) || root.startsWith("//");
}

function aliasedLocalPath(candidate: string, root: string, literalPath: boolean): boolean {
  const location = literalPath ? "" : localFileLocationSuffix(candidate);
  const path = location ? candidate.slice(0, -location.length) : candidate;
  if (path.includes("::$")) return true;
  if (!windowsStyleRoot(root) && !/^(?:[a-z]:\/|\/\/)/iu.test(path)) return false;
  const rest = path.replace(/^(?:[a-z]:\/|\/\/|\/)/iu, "");
  return rest.split("/").some((segment) => segment.includes(":")
    || /~\d/u.test(segment)
    || /[. ]$/u.test(segment));
}

function relativeWithinRoot(candidate: string, root: string): string | null {
  const insensitive = windowsStyleRoot(root);
  const comparableRoot = insensitive ? root.toLocaleLowerCase("en-US") : root;
  const comparableCandidate = insensitive ? candidate.toLocaleLowerCase("en-US") : candidate;
  if (comparableCandidate === comparableRoot) return ".";
  return comparableCandidate.startsWith(`${comparableRoot}/`) ? candidate.slice(root.length + 1) : null;
}

function safeDecodeUriPath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value.replace(/(?:%[0-9a-f]{2})+/giu, (sequence) => {
      try {
        return decodeURIComponent(sequence);
      } catch {
        return sequence;
      }
    });
  }
}

export function resolveResponseLink(
  projectRoot: string,
  rawHref: string,
  syntax: "markdown" | "file" = "markdown",
  markdownBasePath = "",
  projectBaseRoot = "",
): ProjectLink {
  let href = rawHref.trim();
  if (!href || href.includes("\0")) return { kind: "unsafe" };
  if (/^file:/iu.test(href)) {
    const url = parseLocalFileUrl(href, { allowSearch: true });
    if (!url) return { kind: "unsafe" };
    href = encodedLocalFilePath(url) + url.hash;
  }
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
        return url.username || url.password
          ? { kind: "unsafe" }
          : { kind: "external", url: url.toString() };
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
  const decoded = safeDecodeUriPath(rawPath);
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
  const projectTarget = (relativePath: string, owner?: "project"): ProjectLink => (
    relativePath
      ? {
          kind: "project",
          relativePath,
          action: "reveal",
          ...(owner ? { owner } : {}),
          ...(location ? { location } : {}),
          ...(encodedPathDelimiter ? { literalPath: true } : {}),
          ...(headingId ? { headingId } : {}),
        }
      : { kind: "unsafe" }
  );
  const insideRoot = relativeWithinRoot(candidate, root);
  if (insideRoot !== null) return projectTarget(insideRoot);
  if (isAbsolute && projectBaseRoot) {
    const baseRoot = normalizedPath(projectBaseRoot).replace(/\/+$/u, "");
    const sameRoot = baseRoot && (windowsStyleRoot(baseRoot)
      ? baseRoot.toLocaleLowerCase("en-US") === root.toLocaleLowerCase("en-US")
      : baseRoot === root);
    const insideBase = baseRoot && !sameRoot ? relativeWithinRoot(candidate, baseRoot) : null;
    if (insideBase !== null) return projectTarget(insideBase, "project");
  }
  if (aliasedLocalPath(candidate, root, encodedPathDelimiter)) return { kind: "unsafe" };
  const url = localFileUrl(candidate, encodedPathDelimiter);
  return url ? { kind: "local", path: candidate, url } : { kind: "unsafe" };
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
  if (isValidElement<{ children?: ReactNode; alt?: string; src?: string }>(node)) {
    const nested = nodeText(node.props.children);
    if (nested) return nested;
    if (typeof node.props.alt === "string" && node.props.alt.trim()) return node.props.alt;
    if (typeof node.props.src === "string" && node.props.src.trim()) return node.props.src;
  }
  return "";
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

function MarkdownTable({ children, node: _node, ...props }: ComponentProps<"table"> & ExtraProps): React.JSX.Element {
  const { announceCopyFeedback } = useMarkdownRenderContext();
  const rows = useMemo(() => tableRowsFromNode(children), [children]);
  const markdownCopy = useCopiedState();
  const csvCopy = useCopiedState();
  return (
    <div className="response-table-shell">
      <div className="response-table-scroll"><table {...props}>{children}</table></div>
      <div className="response-table-toolbar">
        <button type="button" disabled={markdownCopy.pending} onClick={() => void markdownCopy.copy(tableAsMarkdown(rows))}>{markdownCopy.copied ? <Check size={14} /> : <Copy size={14} />}<span>{markdownCopy.pending ? "Copying Markdown" : markdownCopy.copied ? "Copied Markdown" : "Markdown"}</span></button>
        <button type="button" disabled={csvCopy.pending} onClick={() => void csvCopy.copy(tableAsCsv(rows))}>{csvCopy.copied ? <Check size={14} /> : <Copy size={14} />}<span>{csvCopy.pending ? "Copying CSV" : csvCopy.copied ? "Copied CSV" : "CSV"}</span></button>
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
  const { announceCopyFeedback, conversationId, projectBaseRoot } = useMarkdownRenderContext();
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
    ? resolveResponseLink(projectRoot, meta.file, "file", "", projectBaseRoot)
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
  const codeMenu = contextMenuHandlers<HTMLDivElement>(
    (target, surface) => hasNativeMenuTarget(target, surface) ? null : {
      kind: "code",
      ...(isContextMenuId(conversationId) ? { conversationId } : {}),
      hasSelection: selectionInside(surface),
    },
    (action) => {
      if (action === "copy-code") void clipboard.copy(code);
    },
  );
  const fileLabel = (
    <>
      <HeaderIcon size={14} />
      {meta.file ?? meta.label}
    </>
  );
  return (
    <div
      className="response-code-block"
      data-language-family={sourceLanguage.family}
      onContextMenu={codeMenu.onContextMenu}
    >
      <header>
        {fileTarget?.kind === "local"
          ? <LocalFileLink path={fileTarget.path} url={fileTarget.url} className="response-code-file-link">{meta.file}</LocalFileLink>
          : fileTarget?.kind === "project" && fileTarget.owner !== "project" && onOpenProjectFile
          ? (
              <TooltipButton
                className="response-code-file-link"
                tooltip={`Open ${fileTarget.relativePath} in Files`}
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
              </TooltipButton>
            )
          : (
              <span
                title={meta.file ?? undefined}
                data-language-family={sourceLanguage.family}
              >
                {meta.file ? fileLabel : (
                  <>
                    <HeaderIcon size={14} />
                    {sourceLanguage.label === "Text"
                      ? meta.label
                      : sourceLanguage.label}
                  </>
                )}
              </span>
            )}
        <div>
          <TooltipButton aria-pressed={wrap} tooltip={wrap ? "Disable code wrapping" : "Wrap long code lines"} onClick={() => setWrap((value) => !value)}><span>Wrap</span></TooltipButton>
          <TooltipButton tooltip="Copy code" disabled={clipboard.pending} onClick={() => void clipboard.copy(code)}>{clipboard.copied ? <Check size={14} /> : <Copy size={14} />}<span>{clipboard.pending ? "Copying" : clipboard.copied ? "Copied" : "Copy"}</span></TooltipButton>
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
  projectBaseRoot?: string;
  projectId: string;
  conversationId?: string;
  markdownBasePath: string;
  defaultCodeWrap: boolean;
  streaming: boolean;
  announceCopyFeedback: boolean;
  fileChips: boolean;
  onOpenProjectFile?: (
    path: string,
    location?: WorkspaceFileLocation,
    literalPath?: boolean,
    headingId?: string,
  ) => void;
  onPreviewMedia?: (target: WorkspaceMediaPreviewTarget) => void;
}

const MarkdownRenderContext = createContext<MarkdownRenderContextValue | null>(
  null,
);
const InsideMarkdownLinkContext = createContext(false);

function useMarkdownRenderContext(): MarkdownRenderContextValue {
  const context = useContext(MarkdownRenderContext);
  if (!context) throw new Error("Markdown renderer context is unavailable.");
  return context;
}

function LocalFileLink({ path, url, children, ...props }: ComponentProps<"a"> & {
  path: string;
  url: string;
}): React.JSX.Element {
  const [error, setError] = useState(false);
  const language = sourceLanguageForFile(path);
  return <>
    <a {...props} href={url}
      className={[props.className, "response-project-file-link"].filter(Boolean).join(" ")}
      data-language-family={language.family}
      data-link-path={path}
      title={props.title}
      onClick={(event) => {
        event.preventDefault();
        setError(false);
        void window.inertia.openExternal(url).catch(() => setError(true));
      }}>
      <FileCode2 className="response-project-file-icon" size={14} aria-hidden="true" />
      <span>
        <InsideMarkdownLinkContext.Provider value={true}>
          {children}
        </InsideMarkdownLinkContext.Provider>
      </span>
    </a>
    {error && <span className="response-copy-error" role="alert">The local file could not be opened.</span>}
  </>;
}

function WebLink({ url, children, ...props }: ComponentProps<"a"> & {
  url: string;
}): React.JSX.Element {
  const [error, setError] = useState(false);
  return <>
    <a
      {...props}
      className={[props.className, "response-web-link"].filter(Boolean).join(" ")}
      href={url}
      rel="noreferrer noopener"
      target="_blank"
      onClick={(event) => {
        event.preventDefault();
        setError(false);
        void window.inertia.openExternal(url).catch(() => setError(true));
      }}
    >
      <InsideMarkdownLinkContext.Provider value={true}>
        {children}
      </InsideMarkdownLinkContext.Provider>
    </a>
    {error && <span className="response-copy-error" role="alert">The link could not be opened.</span>}
  </>;
}

const BLOCKED_LINK_REASON = "This link was blocked because its address is invalid or uses an unsafe protocol.";

function MarkdownLink({
  href = "",
  children,
  node: _node,
  ...props
}: ComponentProps<"a"> & ExtraProps): React.JSX.Element {
  const {
    projectRoot,
    projectBaseRoot,
    projectId,
    conversationId,
    markdownBasePath,
    onOpenProjectFile,
    onPreviewMedia,
  } = useMarkdownRenderContext();
  const { preferredEditor, detectedEditors } = useEditorPreference();
  const target = resolveResponseLink(
    projectRoot,
    href,
    "markdown",
    markdownBasePath,
    projectBaseRoot,
  );
  if (target.kind === "local") {
    return <LocalFileLink {...props} path={target.path} url={target.url}>{children}</LocalFileLink>;
  }
  if (target.kind === "external") {
    return <WebLink {...props} url={target.url}>{children}</WebLink>;
  }
  if (target.kind === "project") {
    const effectiveConversationId = target.owner === "project" ? undefined : conversationId;
    const effectiveProjectRoot = target.owner === "project" && projectBaseRoot
      ? projectBaseRoot
      : projectRoot;
    const parsedReference = !target.literalPath && !target.location
      ? workspaceFileReference(target.relativePath)
      : null;
    const editorRelativePath = parsedReference ? parsedReference.path : target.relativePath;
    const editorLocation = target.location ?? parsedReference?.location;
    const mediaDescriptor = classifyWorkspaceMediaPath(editorRelativePath);
    const mediaTarget = editorLocation && mediaDescriptor?.isTextDualView
      ? null
      : workspaceMediaPreviewTargetForPath(projectId, effectiveConversationId, editorRelativePath);
    const language = sourceLanguageForFile(
      workspaceFileReferenceFallback(target.relativePath)
        ?? target.relativePath,
    );
    const projectLinkClass = [props.className, "response-project-file-link"]
      .filter(Boolean)
      .join(" ");
    const FileIcon = mediaTarget
      ? workspaceMediaIcon(mediaTarget.kind)
      : language.id === "sql" ? Database : FileCode2;
    const openInConversationFiles = target.owner === "project" ? undefined : onOpenProjectFile;
    const openDefault = (): void => {
      if (openInConversationFiles) {
        if (target.headingId) {
          openInConversationFiles(
            target.relativePath,
            target.location,
            target.literalPath,
            target.headingId,
          );
        } else if (target.literalPath) {
          openInConversationFiles(
            target.relativePath,
            target.location ?? undefined,
            true,
          );
        } else if (target.location) {
          openInConversationFiles(target.relativePath, target.location);
        } else {
          openInConversationFiles(target.relativePath);
        }
        return;
      }
      void window.inertia.openProjectPath({
        projectId,
        ...(effectiveConversationId ? { conversationId: effectiveConversationId } : {}),
        relativePath: target.relativePath,
        action: target.action,
      }).catch(() => undefined);
    };
    const openLink = (event?: React.MouseEvent<HTMLAnchorElement>): void => {
      if (mediaTarget && onPreviewMedia) {
        onPreviewMedia(mediaTarget);
        return;
      }
      if (isEditorId(preferredEditor)) {
        void window.inertia.openProjectPath({
          projectId,
          ...(effectiveConversationId ? { conversationId: effectiveConversationId } : {}),
          relativePath: editorRelativePath,
          action: "open-in-editor",
          editor: preferredEditor,
          ...(editorLocation ? {
            line: editorLocation.startLine,
            ...(editorLocation.startColumn !== undefined ? { column: editorLocation.startColumn } : {}),
          } : {}),
        }).catch(() => undefined);
        return;
      }
      if (preferredEditor === "ask" && detectedEditors.length > 0 && event) {
        showEditorPickMenu(
          {
            projectId,
            conversationId: effectiveConversationId,
            relativePath: editorRelativePath,
            location: editorLocation,
            open: openDefault,
          },
          event.currentTarget,
          event.detail > 0 ? { x: event.clientX, y: event.clientY } : undefined,
        );
        return;
      }
      openDefault();
    };
    const linkMenu = projectPathContextMenu<HTMLAnchorElement>("project-link", {
      projectId,
      conversationId: effectiveConversationId,
      projectRoot: effectiveProjectRoot,
      relativePath: editorRelativePath,
      location: editorLocation,
      open: mediaTarget && onPreviewMedia ? () => onPreviewMedia(mediaTarget) : openDefault,
    });
    return (
      <a
        {...props}
        className={projectLinkClass}
        data-language-family={language.family}
        data-link-path={target.relativePath}
        href={href}
        onClick={(event) => {
          event.preventDefault();
          openLink(event);
        }}
        onContextMenu={linkMenu?.onContextMenu}
        onKeyDown={linkMenu?.onKeyDown}
      >
        <FileIcon
          className="response-project-file-icon"
          size={14}
          aria-hidden="true"
        />
        <span>
          <InsideMarkdownLinkContext.Provider value={true}>
            {children}
          </InsideMarkdownLinkContext.Provider>
        </span>
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
    }}><InsideMarkdownLinkContext.Provider value={true}>{children}</InsideMarkdownLinkContext.Provider></a>;
  }
  return <>
    <TooltipText className="response-unsafe-link" tooltip={BLOCKED_LINK_REASON}>{children}</TooltipText>
    <span className="visually-hidden">{BLOCKED_LINK_REASON}</span>
  </>;
}

function MarkdownImage({
  src = "",
  alt = "",
  title,
  className,
}: ComponentProps<"img">): React.JSX.Element {
  const {
    projectRoot,
    projectBaseRoot,
    projectId,
    conversationId,
    markdownBasePath,
    onOpenProjectFile,
    onPreviewMedia,
  } = useMarkdownRenderContext();
  const insideLink = useContext(InsideMarkdownLinkContext);
  const target = resolveResponseLink(
    projectRoot,
    src,
    "markdown",
    markdownBasePath,
    projectBaseRoot,
  );
  const openInConversationFiles = target.kind === "project" && target.owner === "project"
    ? undefined
    : onOpenProjectFile;
  return (
    <MarkdownMediaEmbed
      target={target}
      alt={alt}
      title={title}
      className={className}
      projectId={projectId}
      conversationId={conversationId}
      interactive={!insideLink}
      onOpenProjectFile={openInConversationFiles}
      onPreviewMedia={onPreviewMedia}
    />
  );
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

function MarkdownCode({
  children,
  node,
  ...props
}: ComponentProps<"code"> & ExtraProps): React.JSX.Element {
  const {
    projectRoot,
    projectBaseRoot,
    projectId,
    conversationId,
    announceCopyFeedback,
    fileChips,
    onOpenProjectFile,
    onPreviewMedia,
  } = useMarkdownRenderContext();
  const { "data-response-file-chip": _marker, ...codeProps } = props as typeof props & {
    "data-response-file-chip"?: unknown;
  };
  const reference = fileChips
    && node?.properties?.[FILE_CHIP_PROPERTY] !== undefined
    && typeof children === "string"
    ? fileChipReference(children)
    : null;
  const target = reference && projectRoot && (onOpenProjectFile || onPreviewMedia)
    ? resolveResponseLink(projectRoot, reference.path, "file", "", projectBaseRoot)
    : null;
  const relativePath = target?.kind === "project" && target.relativePath !== "."
    ? target.relativePath
    : null;
  const effectiveConversationId = target?.kind === "project" && target.owner === "project"
    ? undefined
    : conversationId;
  const effectiveProjectRoot = target?.kind === "project" && target.owner === "project" && projectBaseRoot
    ? projectBaseRoot
    : projectRoot;
  const openInConversationFiles = target?.kind === "project" && target.owner === "project"
    ? undefined
    : onOpenProjectFile;
  const mediaDescriptor = relativePath ? classifyWorkspaceMediaPath(relativePath) : null;
  const mediaTarget = relativePath && onPreviewMedia && !(reference?.location && mediaDescriptor?.isTextDualView)
    ? workspaceMediaPreviewTargetForPath(projectId, effectiveConversationId, relativePath)
    : null;
  if (!reference || relativePath === null || (!openInConversationFiles && !mediaTarget)) {
    return <code {...codeProps}>{children}</code>;
  }
  return (
    <FileChip
      reference={reference}
      relativePath={relativePath}
      projectRoot={effectiveProjectRoot}
      projectId={projectId}
      conversationId={effectiveConversationId}
      announceCopyFeedback={announceCopyFeedback}
      onOpenProjectFile={openInConversationFiles}
      onPreviewMedia={mediaTarget && onPreviewMedia ? () => onPreviewMedia(mediaTarget) : undefined}
    />
  );
}

function MarkdownDetails({
  children,
  node: _node,
  ...props
}: ComponentProps<"details"> & ExtraProps): React.JSX.Element {
  return <details {...props} className="response-details">{children}</details>;
}

function MarkdownSummary({
  children,
  node: _node,
  ...props
}: ComponentProps<"summary"> & ExtraProps): React.JSX.Element {
  return (
    <InsideMarkdownLinkContext.Provider value={true}>
      <summary {...props}>{children}</summary>
    </InsideMarkdownLinkContext.Provider>
  );
}

const RESPONSE_MARKDOWN_COMPONENTS: NonNullable<
  ComponentProps<typeof ReactMarkdown>["components"]
> = {
  a: MarkdownLink,
  code: MarkdownCode,
  pre: MarkdownCodeBlock,
  table: MarkdownTable,
  details: MarkdownDetails,
  summary: MarkdownSummary,
  img: MarkdownImage,
};

const settledMarkdownTrees = createBoundedCache<ReactNode>(
  500,
  4_000_000,
  (content) => content.length * 16,
);

function responseUrlTransform(url: string, key: string): string {
  return (key === "href" || key === "src") && parseLocalFileUrl(url, { allowSearch: true })
    ? url
    : defaultUrlTransform(url);
}

function renderMarkdownTree(content: string): ReactNode {
  return ReactMarkdown({
    children: content,
    urlTransform: responseUrlTransform,
    remarkPlugins: REMARK_PLUGINS,
    rehypePlugins: REHYPE_PLUGINS,
    components: RESPONSE_MARKDOWN_COMPONENTS,
  });
}

function settledMarkdownTree(content: string): ReactNode {
  const cached = settledMarkdownTrees.get(content);
  if (cached !== undefined) return cached;
  const tree = renderMarkdownTree(content);
  settledMarkdownTrees.set(content, tree);
  return tree;
}

export function stabilizeStreamingMarkdown(content: string): string {
  const fences = content.match(/^ {0,3}(?:```|~~~)/gmu) ?? [];
  if (fences.length % 2 === 0) return content;
  const marker = fences.at(-1)?.trim().startsWith("~~~") ? "~~~" : "```";
  return `${content}\n${marker}`;
}

function ResponseMarkdownComponent({
  content,
  projectRoot,
  projectBaseRoot,
  projectId,
  conversationId,
  markdownBasePath = "",
  defaultCodeWrap,
  streaming = false,
  announceCopyFeedback = true,
  fileChips = true,
  onOpenProjectFile,
  onPreviewMedia,
}: ResponseMarkdownProps): React.JSX.Element {
  const renderedContent = streaming ? stabilizeStreamingMarkdown(content) : content;
  const markdownTree = useMemo(
    () => streaming ? renderMarkdownTree(renderedContent) : settledMarkdownTree(renderedContent),
    [renderedContent, streaming],
  );
  const imageSchedulerIdentity = [
    projectRoot,
    projectBaseRoot ?? "",
    projectId,
    conversationId ?? "",
    markdownBasePath,
  ].join("\0");
  const renderContext = useMemo<MarkdownRenderContextValue>(() => ({
    projectRoot,
    projectBaseRoot,
    projectId,
    conversationId,
    markdownBasePath,
    defaultCodeWrap,
    streaming,
    announceCopyFeedback,
    fileChips,
    onOpenProjectFile,
    onPreviewMedia,
  }), [
    announceCopyFeedback,
    conversationId,
    defaultCodeWrap,
    fileChips,
    markdownBasePath,
    onOpenProjectFile,
    onPreviewMedia,
    projectBaseRoot,
    projectId,
    projectRoot,
    streaming,
  ]);
  return (
    <MarkdownRenderContext.Provider value={renderContext}>
      <MarkdownImageSchedulerProvider key={imageSchedulerIdentity}>
        <div className={`response-markdown${streaming ? " is-streaming" : ""}`}>
          {markdownTree}
        </div>
      </MarkdownImageSchedulerProvider>
    </MarkdownRenderContext.Provider>
  );
}

export const ResponseMarkdown = memo(ResponseMarkdownComponent);
