import { HTML_RENDER_MAX_HTML_BYTES, isHtmlRenderId, isHtmlRenderTitle } from "../shared/html-render.js";

/**
 * Main asks the supervised runtime for one stored visual reply so the
 * privileged protocol route can serve it to a sandboxed frame. The runtime
 * owns the database; main never reads it directly.
 */
export interface RuntimeHtmlRenderReadCommand {
  type: "runtime.read-html-render";
  requestId: string;
  renderId: string;
}

export interface RuntimeHtmlRenderDocument {
  conversationId: string;
  title: string;
  html: string;
}

export type RuntimeHtmlRenderEvent =
  | { type: "runtime.html-render-resolved"; requestId: string; render: RuntimeHtmlRenderDocument | null }
  | { type: "runtime.html-render-rejected"; requestId: string; message: string };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRuntimeHtmlRenderReadCommand(value: unknown): RuntimeHtmlRenderReadCommand | null {
  if (
    !plainObject(value)
    || value.type !== "runtime.read-html-render"
    || Object.keys(value).length !== 3
    || typeof value.requestId !== "string"
    || !UUID_PATTERN.test(value.requestId)
    || !isHtmlRenderId(value.renderId)
  ) return null;
  return { type: "runtime.read-html-render", requestId: value.requestId, renderId: value.renderId };
}

function parseDocument(value: unknown): RuntimeHtmlRenderDocument | null {
  if (
    !plainObject(value)
    || Object.keys(value).length !== 3
    || typeof value.conversationId !== "string"
    || !UUID_PATTERN.test(value.conversationId)
    || !isHtmlRenderTitle(value.title)
    || typeof value.html !== "string"
    || value.html.length === 0
    // UTF-16 length is a cheap upper bound; the runtime enforced the byte limit when it stored the page.
    || value.html.length > HTML_RENDER_MAX_HTML_BYTES
  ) return null;
  return { conversationId: value.conversationId, title: value.title, html: value.html };
}

export function parseRuntimeHtmlRenderEvent(value: unknown): RuntimeHtmlRenderEvent | null {
  if (!plainObject(value) || typeof value.requestId !== "string" || !UUID_PATTERN.test(value.requestId)) return null;
  if (value.type === "runtime.html-render-resolved" && Object.keys(value).length === 3) {
    if (value.render === null) return { type: "runtime.html-render-resolved", requestId: value.requestId, render: null };
    const render = parseDocument(value.render);
    return render ? { type: "runtime.html-render-resolved", requestId: value.requestId, render } : null;
  }
  if (
    value.type === "runtime.html-render-rejected"
    && Object.keys(value).length === 3
    && typeof value.message === "string"
  ) {
    const message = value.message.trim();
    return message && message.length <= 1_000
      ? { type: "runtime.html-render-rejected", requestId: value.requestId, message }
      : null;
  }
  return null;
}
