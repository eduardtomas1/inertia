/**
 * Visual replies: the stored reference and the bounds every process enforces.
 * Kept apart from the frame protocol and bootstrap in `html-render.ts` (which
 * re-exports it) so code that only validates a reference, such as the chat
 * message schema on the renderer's startup path, does not pull the rest in.
 */

export const HTML_RENDER_TOOL_NAME = "inertia_render_html";

/** Upper bound on the authored page in UTF-8 bytes, before the bootstrap is injected. */
export const HTML_RENDER_MAX_HTML_BYTES = 256 * 1024;
export const HTML_RENDER_MAX_TITLE_LENGTH = 120;
export const HTML_RENDER_MIN_HEIGHT = 80;
export const HTML_RENDER_MAX_HEIGHT = 2_000;
export const HTML_RENDER_DEFAULT_HEIGHT = 360;
/** Pages one agent turn may publish; further calls are refused. */
export const HTML_RENDER_MAX_PER_TURN = 8;

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

export function htmlRenderContextLine(title: string): string {
  return `[page: ${title}]`;
}

/** Fallback text for clients that predate visual replies. */
export function htmlRenderPlaceholderText(title: string): string {
  return `Rendered page: ${title}`;
}
