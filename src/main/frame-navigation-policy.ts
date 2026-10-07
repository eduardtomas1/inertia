import type { Event, WebContents, WebContentsWillFrameNavigateEventParams } from "electron";

import { HTML_RENDER_PROTOCOL_HOST, isHtmlRenderId } from "../shared/html-render.js";

/**
 * The only document a renderer subframe may navigate to is a visual reply
 * served by the app protocol: `<scheme>://render/<renderId>`, optionally with
 * the theme fragment the renderer appends for first paint.
 */
export function allowedSubframeUrl(scheme: string, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === `${scheme}:`
    && parsed.hostname === HTML_RENDER_PROTOCOL_HOST
    && !parsed.port
    && !parsed.username
    && !parsed.password
    && !parsed.search
    && parsed.pathname.startsWith("/")
    && isHtmlRenderId(parsed.pathname.slice(1));
}

/**
 * Confines what a window's framed pages can reach beyond their CSP: every
 * subframe navigation except a visual reply is blocked (main-frame navigation
 * keeps its own guards), and WebRTC may not open direct UDP connections,
 * which no content security policy governs.
 */
export function guardFramedPages(
  contents: Pick<WebContents, "on" | "setWebRTCIPHandlingPolicy">,
  scheme: string,
): void {
  contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  contents.on("will-frame-navigate", (details: Event<WebContentsWillFrameNavigateEventParams>) => {
    if (details.isMainFrame) return;
    if (!allowedSubframeUrl(scheme, details.url)) details.preventDefault();
  });
}
