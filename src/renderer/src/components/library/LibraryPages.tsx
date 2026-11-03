import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { htmlRenderThemeFragment, type HtmlRenderFrameMessage } from "@shared/html-render";
import type { LibraryPage } from "@shared/library";

import { useHtmlRenderTheme } from "../../hooks/useHtmlRenderTheme";
import { formatFullDateTime, formatRelativeTime } from "../../lib/format";
import { htmlRenderUrl } from "../../utils/htmlRenderUrl";
import { useHtmlRenderFrameBridge } from "../response-timeline/html-render-bridge";
import { TooltipText } from "../TooltipText";
import { pageThumbnailSeed } from "./libraryModel";

export const MAX_MOUNTED_PAGE_PREVIEWS = 12;
const PREVIEW_VIEWPORT_WIDTH = 640;
const PREVIEW_VIEWPORT_HEIGHT = 400;

type PreviewState = "loading" | "ready" | "failed";

function PageThumbnail({ renderId }: { renderId: string }): React.JSX.Element {
  const [a, b, c, d, e, f] = pageThumbnailSeed(renderId) as [number, number, number, number, number, number];
  const style = {
    "--thumb-title": `${42 + a * 34}%`,
    "--thumb-line-1": `${62 + b * 30}%`,
    "--thumb-line-2": `${44 + c * 40}%`,
    "--thumb-block": `${Math.round(30 + d * 14)}px`,
    "--thumb-tint": `${Math.round(10 + e * 14)}%`,
    "--thumb-columns": f > 0.5 ? "1.4fr 1fr 0.8fr" : "1fr 1fr 1fr",
  } as CSSProperties;
  return (
    <span className="library-page-placeholder" style={style} aria-hidden="true">
      <span className="library-page-thumbnail-bar" />
      <span className="library-page-thumbnail-title" />
      <span className="library-page-thumbnail-line" />
      <span className="library-page-thumbnail-line is-short" />
      <span className="library-page-thumbnail-grid">
        <span />
        <span />
        <span />
      </span>
    </span>
  );
}

function PagePreview({ renderId, onFailed }: { renderId: string; onFailed: () => void }): React.JSX.Element {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const theme = useHtmlRenderTheme();
  const [src] = useState(() => htmlRenderUrl(renderId) + htmlRenderThemeFragment(theme));
  const [state, setState] = useState<PreviewState>("loading");
  const [scale, setScale] = useState(0);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = (): void => setScale(viewport.clientWidth / PREVIEW_VIEWPORT_WIDTH);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const receive = useCallback((message: HtmlRenderFrameMessage) => {
    if (message.type === "unavailable") {
      setState("failed");
      onFailed();
    } else if (message.type === "size") {
      setState((current) => current === "loading" ? "ready" : current);
    }
  }, [onFailed]);
  const bridgeLoad = useHtmlRenderFrameBridge(frameRef, theme, receive);

  return (
    <span ref={viewportRef} className="library-page-preview" data-preview-state={state} aria-hidden="true" inert>
      <iframe
        ref={frameRef}
        className="library-page-preview-frame"
        data-testid="library-page-preview"
        title=""
        src={src}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        allow=""
        tabIndex={-1}
        style={{
          width: PREVIEW_VIEWPORT_WIDTH,
          height: PREVIEW_VIEWPORT_HEIGHT,
          colorScheme: theme.scheme,
          transform: `scale(${scale})`,
        }}
        onLoad={() => {
          bridgeLoad();
          setState((current) => current === "loading" ? "ready" : current);
        }}
      />
    </span>
  );
}

const PREVIEW_THRESHOLDS = [0, 0.25, 0.5, 0.75, 1];

export function choosePreviewSlots(
  renderIds: readonly string[],
  ratios: ReadonlyMap<string, number>,
  previous: readonly string[],
  limit: number,
): string[] {
  const ratio = (renderId: string): number => ratios.get(renderId) ?? 0;
  const visible = renderIds.filter((renderId) => ratio(renderId) > 0);
  const byVisibility = [...visible].sort((left, right) => ratio(right) - ratio(left));
  const next = previous.filter((renderId) => ratio(renderId) > 0 && renderIds.includes(renderId));
  for (const renderId of byVisibility) {
    if (next.length >= limit) break;
    if (!next.includes(renderId)) next.push(renderId);
  }
  for (const renderId of byVisibility) {
    if (ratio(renderId) < 1 || next.includes(renderId)) continue;
    const weakest = next.reduce<string | null>((lowest, candidate) => (
      ratio(candidate) < 1 && (lowest === null || ratio(candidate) < ratio(lowest)) ? candidate : lowest
    ), null);
    if (weakest === null) break;
    next[next.indexOf(weakest)] = renderId;
  }
  return next;
}

export function usePagePreviewSlots(
  renderIds: readonly string[],
  limit = MAX_MOUNTED_PAGE_PREVIEWS,
): { observe: (renderId: string, element: Element | null) => void; mounted: ReadonlySet<string> } {
  const [ratios, setRatios] = useState<ReadonlyMap<string, number>>(() => new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const elements = useRef(new Map<string, Element>());
  const previousSlots = useRef<readonly string[]>([]);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      setRatios((current) => {
        let next: Map<string, number> | null = null;
        for (const entry of entries) {
          const renderId = (entry.target as HTMLElement).dataset.renderId;
          if (!renderId) continue;
          const ratio = entry.isIntersecting ? Math.max(entry.intersectionRatio, 0.01) : 0;
          if ((current.get(renderId) ?? 0) === ratio) continue;
          next ??= new Map(current);
          if (ratio > 0) next.set(renderId, ratio);
          else next.delete(renderId);
        }
        return next ?? current;
      });
    }, { threshold: PREVIEW_THRESHOLDS });
    observerRef.current = observer;
    for (const element of elements.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, []);

  const observe = useCallback((renderId: string, element: Element | null): void => {
    const previous = elements.current.get(renderId);
    if (previous === element) return;
    if (previous) observerRef.current?.unobserve(previous);
    if (element) {
      elements.current.set(renderId, element);
      observerRef.current?.observe(element);
    } else {
      elements.current.delete(renderId);
      setRatios((current) => {
        if (!current.has(renderId)) return current;
        const next = new Map(current);
        next.delete(renderId);
        return next;
      });
    }
  }, []);

  const mounted = useMemo(() => {
    const slots = choosePreviewSlots(renderIds, ratios, previousSlots.current, limit);
    previousSlots.current = slots;
    return new Set(slots);
  }, [limit, renderIds, ratios]);
  return { observe, mounted };
}

export const LibraryPageCard = memo(function LibraryPageCard({
  page,
  previewMounted,
  observe,
  onOpen,
}: {
  page: LibraryPage;
  previewMounted: boolean;
  observe: (renderId: string, element: Element | null) => void;
  onOpen: (page: LibraryPage) => void;
}): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  const markFailed = useCallback(() => setFailed(true), []);
  const ref = useCallback((element: HTMLLIElement | null) => observe(page.renderId, element), [observe, page.renderId]);
  return (
    <li ref={ref} className="library-page" data-render-id={page.renderId}>
      <span className="library-page-thumbnail" aria-hidden="true">
        <PageThumbnail renderId={page.renderId} />
        {previewMounted && !failed && <PagePreview renderId={page.renderId} onFailed={markFailed} />}
      </span>
      <button
        type="button"
        className="library-page-open"
        aria-describedby={`library-page-meta-${page.renderId}`}
        onClick={() => onOpen(page)}
      >
        {page.title}
      </button>
      <p className="library-page-meta" id={`library-page-meta-${page.renderId}`}>
        <span className="library-page-chat">{page.conversationTitle}</span>
        <TooltipText tooltip={formatFullDateTime(page.createdAt)}>
          <time dateTime={page.createdAt}>{formatRelativeTime(page.createdAt)}</time>
        </TooltipText>
        {page.archived && <span className="library-archived">Archived</span>}
      </p>
    </li>
  );
});
