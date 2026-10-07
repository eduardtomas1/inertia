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

/** Blocks every subframe navigation except a visual reply; main-frame navigation keeps its own guards. */
export function guardSubframeNavigation(contents: Pick<WebContents, "on">, scheme: string): void {
  contents.on("will-frame-navigate", (details: Event<WebContentsWillFrameNavigateEventParams>) => {
    if (details.isMainFrame) return;
    if (!allowedSubframeUrl(scheme, details.url)) details.preventDefault();
  });
}
