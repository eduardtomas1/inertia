/**
 * Visual replies: an agent publishes one self-contained HTML page (a chart,
 * table, diagram or interface mockup) through the `inertia_render_html` host
 * tool, and Inertia shows it inline in the conversation inside a sandboxed
 * frame, above the agent's written reply for that turn.
 *
 * This module is the contract every process boundary shares: the stored
 * reference carried on a system message, the bounds the tool and the frame
 * enforce, the `postMessage` protocol between the frame and the renderer,
 * and the bootstrap the main process injects when it serves the page.
 */

export const HTML_RENDER_TOOL_NAME = "inertia_render_html";

/** Upper bound on the authored page in UTF-8 bytes, before the bootstrap is injected. */
export const HTML_RENDER_MAX_HTML_BYTES = 256 * 1024;
export const HTML_RENDER_MAX_TITLE_LENGTH = 120;
export const HTML_RENDER_MIN_HEIGHT = 80;
export const HTML_RENDER_MAX_HEIGHT = 2_000;
export const HTML_RENDER_DEFAULT_HEIGHT = 360;

/** Host of the privileged protocol route that serves a page: `inertia://render/<renderId>`. */
export const HTML_RENDER_PROTOCOL_HOST = "render";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

/** What a turn-scoped system message carries so clients can show the page. */
export interface HtmlRenderReference {
  renderId: string;
  title: string;
  /** Frame height in CSS pixels the agent asked for, already clamped. */
  height: number;
}

export function isHtmlRenderId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isHtmlRenderTitle(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= HTML_RENDER_MAX_TITLE_LENGTH
    && value.trim() === value
    && !CONTROL_CHARACTERS.test(value);
}

export function clampHtmlRenderHeight(height: number): number {
  if (!Number.isFinite(height)) return HTML_RENDER_DEFAULT_HEIGHT;
  return Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(height)));
}

export function isHtmlRenderReference(value: unknown): value is HtmlRenderReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 3
    && isHtmlRenderId(row.renderId)
    && isHtmlRenderTitle(row.title)
    && typeof row.height === "number"
    && Number.isSafeInteger(row.height)
    && row.height >= HTML_RENDER_MIN_HEIGHT
    && row.height <= HTML_RENDER_MAX_HEIGHT;
}

/** Fallback text for clients that predate visual replies. */
export function htmlRenderPlaceholderText(title: string): string {
  return `Rendered page: ${title}`;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

export type HtmlRenderScheme = "light" | "dark";

/** The resolved theme a client hands a page. Variable names are the page-facing aliases. */
export interface HtmlRenderTheme {
  scheme: HtmlRenderScheme;
  variables: Readonly<Record<string, string>>;
}

/**
 * Page-facing variable → the app token it mirrors. The renderer reads the
 * computed value of each app token and forwards it under the alias, so a page
 * styles against stable names while the app keeps its own vocabulary.
 */
export const HTML_RENDER_THEME_VARIABLES: ReadonlyArray<readonly [alias: string, appToken: string]> = [
  ["--background", "--conversation-canvas-surface"],
  ["--foreground", "--text"],
  ["--muted", "--surface-muted"],
  ["--muted-foreground", "--text-muted"],
  ["--card", "--surface"],
  ["--card-foreground", "--text"],
  ["--border", "--border"],
  ["--accent", "--accent"],
  ["--accent-foreground", "--accent-text"],
  ["--accent-strong", "--accent-strong"],
  ["--destructive", "--danger"],
  ["--warning", "--warning"],
  ["--success", "--success"],
  ["--info", "--blue"],
  ["--code-background", "--code-surface"],
  ["--radius", "--radius-content"],
  ["--font-sans", "--font-sans"],
  ["--font-mono", "--font-mono"],
];

const VARIABLE_NAME = /^--[a-z0-9-]{1,64}$/u;
const MAX_VARIABLE_VALUE_LENGTH = 512;
const MAX_THEME_VARIABLES = 64;

/** Keeps a theme to known-safe custom property names and values before it reaches CSS. */
export function sanitizeHtmlRenderTheme(value: unknown): HtmlRenderTheme | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.scheme !== "light" && row.scheme !== "dark") return null;
  if (!row.variables || typeof row.variables !== "object" || Array.isArray(row.variables)) return null;
  const entries = Object.entries(row.variables as Record<string, unknown>);
  if (entries.length > MAX_THEME_VARIABLES) return null;
  const variables: Record<string, string> = {};
  for (const [name, raw] of entries) {
    if (!VARIABLE_NAME.test(name) || typeof raw !== "string") continue;
    const cleaned = raw.replace(/[;{}<>]/gu, "").trim();
    if (cleaned.length === 0 || cleaned.length > MAX_VARIABLE_VALUE_LENGTH) continue;
    variables[name] = cleaned;
  }
  return { scheme: row.scheme, variables };
}

const DEFAULT_THEMES: Readonly<Record<HtmlRenderScheme, HtmlRenderTheme>> = {
  light: {
    scheme: "light",
    variables: {
      "--background": "#fbfbfa", "--foreground": "#1c1c1a", "--muted": "#f1f0ed",
      "--muted-foreground": "#5f5e5a", "--card": "#ffffff", "--card-foreground": "#1c1c1a",
      "--border": "#e3e1dc", "--accent": "#3b6ef5", "--accent-foreground": "#ffffff",
      "--accent-strong": "#2a55c7", "--destructive": "#c93b3b", "--warning": "#b7791f",
      "--success": "#2d8a4e", "--info": "#2f6fe0", "--code-background": "#f4f3f0",
      "--radius": "12px",
      "--font-sans": '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      "--font-mono": '"SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    },
  },
  dark: {
    scheme: "dark",
    variables: {
      "--background": "#161616", "--foreground": "#ececea", "--muted": "#222222",
      "--muted-foreground": "#a3a29e", "--card": "#1d1d1d", "--card-foreground": "#ececea",
      "--border": "#2e2e2e", "--accent": "#6d8dff", "--accent-foreground": "#0f1424",
      "--accent-strong": "#9ab0ff", "--destructive": "#f07171", "--warning": "#e0a84a",
      "--success": "#5fbf7d", "--info": "#7aa3ff", "--code-background": "#1f1f1f",
      "--radius": "12px",
      "--font-sans": '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
      "--font-mono": '"SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    },
  },
};

export function defaultHtmlRenderTheme(scheme: HtmlRenderScheme): HtmlRenderTheme {
  return DEFAULT_THEMES[scheme];
}

/** Variables the page can rely on, in agent-facing words for tool guidance. */
export const HTML_RENDER_THEME_GUIDE = [
  "Inertia injects its active theme as CSS custom properties on :root, and they follow the user's light/dark mode and color theme live:",
  "--background (the page background, identical to the chat around the frame), --foreground, --muted, --muted-foreground,",
  "--card, --card-foreground, --border, --accent, --accent-foreground (text on the accent), --accent-strong (accent used as text),",
  "--destructive, --warning, --success, --info, --code-background, --radius, --font-sans, --font-mono.",
  "A base stylesheet sets html background/color/font from these and body margin to 0; your own CSS overrides it.",
].join(" ");

export const HTML_RENDER_LAYOUT_GUIDE = [
  "The frame is borderless on the chat's own background, as wide as the reply column, and its left edge lines up with your reply text.",
  "Leave html, body, and the outermost element without a background color unless a box must stand apart; then give it 16px of padding and var(--radius) corners.",
  "Use a fluid width with no outer card, border, or banner title: the page is part of your reply.",
  "Let content set the page's height and avoid viewport-based heights such as 100vh; the frame grows to fit the page up to 2000px, then scrolls inside.",
  "Give charts fixed pixel heights. Write everything inline: the page cannot load remote scripts, styles, fonts, or images, so use inline SVG, <canvas>, or data: URIs.",
].join(" ");

// ---------------------------------------------------------------------------
// Frame ↔ renderer messages
// ---------------------------------------------------------------------------

const MESSAGE_PREFIX = "inertia-html-render:";

/** Messages a framed page posts to its client. */
export type HtmlRenderFrameMessage =
  | { type: "size"; height: number }
  | { type: "open-link"; url: string }
  | { type: "escape" };

const MAX_LINK_LENGTH = 2_048;

/** Parses untrusted `postMessage` data from a frame; anything unexpected is dropped. */
export function readHtmlRenderFrameMessage(data: unknown): HtmlRenderFrameMessage | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  if (typeof row.type !== "string" || !row.type.startsWith(MESSAGE_PREFIX)) return null;
  const type = row.type.slice(MESSAGE_PREFIX.length);
  const keys = Object.keys(row).length;
  if (type === "size" && keys === 2 && typeof row.height === "number" && Number.isFinite(row.height) && row.height > 0) {
    return { type: "size", height: row.height };
  }
  if (type === "open-link" && keys === 2 && typeof row.url === "string" && row.url.length <= MAX_LINK_LENGTH) {
    try {
      const url = new URL(row.url);
      if (url.protocol === "http:" || url.protocol === "https:") return { type: "open-link", url: url.href };
    } catch {
      return null;
    }
    return null;
  }
  if (type === "escape" && keys === 1) return { type: "escape" };
  return null;
}

/** The message a client posts into a mounted frame when the theme changes. */
export function htmlRenderThemeMessage(theme: HtmlRenderTheme): { type: string; theme: HtmlRenderTheme } {
  return { type: `${MESSAGE_PREFIX}theme`, theme };
}

const THEME_FRAGMENT_KEY = "theme";

/** URL fragment that hands a page its theme before first paint. Fragments never reach the protocol handler. */
export function htmlRenderThemeFragment(theme: HtmlRenderTheme): string {
  return `#${THEME_FRAGMENT_KEY}=${encodeURIComponent(JSON.stringify(theme))}`;
}

// ---------------------------------------------------------------------------
// Bootstrap injected by the main process when it serves a page
// ---------------------------------------------------------------------------

const BASE_CSS =
  "html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none}"
  + "html::-webkit-scrollbar{display:none}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}";

function rootRule(theme: HtmlRenderTheme): string {
  const declarations = Object.entries(theme.variables).map(([name, value]) => `${name}:${value};`).join("");
  return `:root{color-scheme:${theme.scheme};${declarations}}`;
}

export const HTML_RENDER_THEME_STYLE_ID = "inertia-html-render-theme";

// Runs synchronously in <head> before the page's own styles and scripts. It
// applies a theme from the URL fragment (first paint) and from the parent's
// theme messages (live changes), reports the page's content height so the
// frame can fit it, hands link clicks to the parent instead of navigating the
// frame, and forwards Escape so a full-size view can close from inside.
const BOOTSTRAP_SCRIPT = [
  "(function(){",
  `var s=document.getElementById(${JSON.stringify(HTML_RENDER_THEME_STYLE_ID)});if(!s)return;`,
  `var b=${JSON.stringify(BASE_CSS)},P=${JSON.stringify(MESSAGE_PREFIX)},parent=window.parent!==window?window.parent:null;`,
  "function apply(t){if(!t||typeof t!=='object'||!t.variables||typeof t.variables!=='object')return;",
  "var c=':root{color-scheme:'+(t.scheme==='light'?'light':'dark')+';';",
  "for(var k in t.variables){if(/^--[a-z0-9-]{1,64}$/.test(k)&&typeof t.variables[k]==='string')c+=k+':'+t.variables[k].replace(/[;{}<>]/g,'').slice(0,512)+';';}",
  "s.textContent=c+'}'+b;}",
  `try{var m=/[#&]${THEME_FRAGMENT_KEY}=([^&]*)/.exec(location.hash);if(m){apply(JSON.parse(decodeURIComponent(m[1])));history.replaceState(history.state,'',location.pathname+location.search);}}catch(e){}`,
  "function post(d){if(parent)parent.postMessage(d,'*');}",
  "window.addEventListener('message',function(e){if(!parent||e.source!==parent)return;var d=e.data;if(d&&d.type===P+'theme')apply(d.theme);});",
  "document.addEventListener('click',function(e){if(!e.isTrusted)return;var a=e.composedPath().find(function(n){return n&&n.matches&&n.matches('a[href]');});if(!a)return;",
  "var u;try{u=new URL(a.getAttribute('href'),document.baseURI);}catch(x){e.preventDefault();return;}",
  "if(u.href.split('#')[0]===location.href.split('#')[0])return;e.preventDefault();",
  "if(/^https?:$/.test(u.protocol))post({type:P+'open-link',url:u.href});},true);",
  "document.addEventListener('keydown',function(e){if(e.key==='Escape')post({type:P+'escape'});},true);",
  "var h=0;function size(){var r=document.documentElement;var v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(v===h||v<=0)return;h=v;post({type:P+'size',height:v});}",
  "if(window.ResizeObserver){var o=new ResizeObserver(size);o.observe(document.documentElement);document.addEventListener('DOMContentLoaded',function(){if(document.body)o.observe(document.body);size();});}",
  "window.addEventListener('load',size);document.addEventListener('DOMContentLoaded',size);",
  "})();",
].join("");

function bootstrapMarkup(scan: string): string {
  const light = rootRule(DEFAULT_THEMES.light);
  const dark = rootRule(DEFAULT_THEMES.dark);
  // Without a client-provided theme (a saved copy, a direct open) the page follows the OS appearance.
  const defaultCss = `${light}@media (prefers-color-scheme: dark){${dark}}${BASE_CSS}`;
  return [
    /<meta\s[^>]*charset/iu.test(scan.slice(0, 4_096)) ? "" : '<meta charset="utf-8">',
    /<meta\s[^>]*name\s*=\s*["']?viewport/iu.test(scan) ? "" : '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="${HTML_RENDER_THEME_STYLE_ID}">${defaultCss}</style>`,
    `<script>${BOOTSTRAP_SCRIPT}</script>`,
  ].join("");
}

// Comments and raw-text elements are blanked to the same length, so offsets
// still line up and a `<head>` inside a script string cannot receive the bootstrap.
function blankNonMarkup(html: string): string {
  return html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|template|xmp|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)/giu,
    (match) => " ".repeat(match.length),
  );
}

/** Inserts the theme bootstrap at the start of the document head, ahead of the page's own styles and scripts. */
export function injectHtmlRenderBootstrap(html: string): string {
  const scan = blankNonMarkup(html);
  const markup = bootstrapMarkup(scan);
  const headOpen = /<head(?:\s[^>]*)?>/iu.exec(scan);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + markup + html.slice(at);
  }
  const htmlOpen = /<html(?:\s[^>]*)?>/iu.exec(scan);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/iu.exec(html);
  if (doctype) {
    const at = doctype[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  return `<!doctype html><head>${markup}</head>${html}`;
}
