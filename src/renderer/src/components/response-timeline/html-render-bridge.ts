import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
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
 * The content height a frame's page last reported, or null before its first
 * report. A page can report many times while it lays out, so reports are
 * applied at most once per animation frame using only the latest one, and a
 * change of less than a pixel is ignored. Returns the height and the reporter.
 */
export function useReportedFrameHeight(): readonly [number | null, (height: number) => void] {
  const [height, setHeight] = useState<number | null>(null);
  const latestRef = useRef<number | null>(null);
  const scheduledRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (scheduledRef.current !== null) window.cancelAnimationFrame(scheduledRef.current);
    scheduledRef.current = null;
  }, []);

  const report = useCallback((next: number) => {
    latestRef.current = next;
    if (scheduledRef.current !== null) return;
    scheduledRef.current = window.requestAnimationFrame(() => {
      scheduledRef.current = null;
      const latest = latestRef.current;
      latestRef.current = null;
      if (latest === null) return;
      setHeight((current) => (current !== null && Math.abs(latest - current) < 1 ? current : latest));
    });
  }, []);

  return [height, report] as const;
}

/**
 * Opens a page's link through the same external-link bridge as chat links.
 * The page's own scripts can post `open-link` at will, so a request needs a
 * fresh user gesture and is limited to one per interval for each frame.
 * Activation also comes from typing or clicking anywhere else in the app, so
 * the gesture only counts while this frame holds focus, which clicking in the
 * page or tabbing into it gives it.
 */
export function useHtmlRenderLinkOpener(
  frameRef: RefObject<HTMLIFrameElement | null>,
): (url: string) => void {
  const lastOpenedAt = useRef(Number.NEGATIVE_INFINITY);
  return useCallback((url: string) => {
    const frame = frameRef.current;
    if (!frame || frame.ownerDocument.activeElement !== frame) return;
    const activation = navigator.userActivation as UserActivation | undefined;
    if (!activation?.isActive) return;
    const now = Date.now();
    if (now - lastOpenedAt.current < LINK_OPEN_INTERVAL_MS) return;
    lastOpenedAt.current = now;
    void window.inertia.openExternal(url).catch(() => undefined);
  }, [frameRef]);
}
