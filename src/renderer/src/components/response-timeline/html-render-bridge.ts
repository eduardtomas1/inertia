import { useCallback, useEffect, useRef, type RefObject } from "react";
import {
  htmlRenderThemeMessage,
  readHtmlRenderFrameMessage,
  type HtmlRenderFrameMessage,
  type HtmlRenderTheme,
} from "@shared/html-render";

const LINK_OPEN_INTERVAL_MS = 1_000;

/**
 * Connects one sandboxed visual-reply frame to the renderer. Messages are
 * accepted only from that frame's own window with an opaque origin and are
 * parsed as untrusted data; the theme is pushed on load and on every change.
 * Returns the frame's `load` handler.
 */
export function useHtmlRenderFrameBridge(
  frameRef: RefObject<HTMLIFrameElement | null>,
  theme: HtmlRenderTheme,
  onMessage: (message: HtmlRenderFrameMessage) => void,
): () => void {
  const themeRef = useRef(theme);
  const loadedRef = useRef(false);
  const onMessageRef = useRef(onMessage);

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    themeRef.current = theme;
    if (!loadedRef.current) return;
    frameRef.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), "*");
  }, [frameRef, theme]);

  useEffect(() => {
    const receive = (event: MessageEvent): void => {
      const source = frameRef.current?.contentWindow;
      if (!source || event.source !== source || event.origin !== "null") return;
      const message = readHtmlRenderFrameMessage(event.data);
      if (message) onMessageRef.current(message);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [frameRef]);

  return useCallback(() => {
    loadedRef.current = true;
    frameRef.current?.contentWindow?.postMessage(htmlRenderThemeMessage(themeRef.current), "*");
  }, [frameRef]);
}

/**
 * Opens a page's link through the same external-link bridge as chat links.
 * The page's own scripts can post `open-link` at will, so a request needs a
 * fresh user gesture (activation propagates up from the frame) and is
 * limited to one per interval for each frame.
 */
export function useHtmlRenderLinkOpener(): (url: string) => void {
  const lastOpenedAt = useRef(Number.NEGATIVE_INFINITY);
  return useCallback((url: string) => {
    const activation = navigator.userActivation as UserActivation | undefined;
    if (activation && !activation.isActive) return;
    const now = Date.now();
    if (now - lastOpenedAt.current < LINK_OPEN_INTERVAL_MS) return;
    lastOpenedAt.current = now;
    void window.inertia.openExternal(url).catch(() => undefined);
  }, []);
}
