import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Maximize2 } from "lucide-react";
import {
  clampHtmlRenderHeight,
  htmlRenderThemeFragment,
  type HtmlRenderFrameMessage,
  type HtmlRenderReference,
} from "@shared/html-render";
import { useHtmlRenderTheme } from "../../hooks/useHtmlRenderTheme";
import { useNativePreviewSuspension } from "../../hooks/useNativePreviewSuspension";
import { htmlRenderUrl } from "../../utils/htmlRenderUrl";
import type { ResponseTurn } from "../../utils/responseTimeline";
import { IconButton } from "../ui";
import { useHtmlRenderFrameBridge, useHtmlRenderLinkOpener } from "./html-render-bridge";
import "./HtmlRender.css";

/** A page that never reports its size is still shown after this delay. */
export const HTML_RENDER_REVEAL_FALLBACK_MS = 1_500;

const LazyHtmlRenderDialog = lazy(async () => ({
  default: (await import("./html-render-dialog")).HtmlRenderDialog,
}));

function DeferredHtmlRenderDialog(props: {
  reference: HtmlRenderReference;
  onClose: () => void;
}): React.JSX.Element {
  // Reserve the trusted overlay before the deferred dialog arrives.
  useNativePreviewSuspension(true);
  return (
    <Suspense fallback={null}>
      <LazyHtmlRenderDialog {...props} />
    </Suspense>
  );
}

/** The turn's visual replies, in message order, above its final answer. */
export function TurnHtmlRenders({
  turn,
}: {
  turn: Pick<ResponseTurn, "htmlRenders">;
}): React.JSX.Element | null {
  const [fullSize, setFullSize] = useState<HtmlRenderReference | null>(null);
  const closeFullSize = useCallback(() => setFullSize(null), []);
  if (turn.htmlRenders.length === 0) return null;
  return (
    <div className="turn-html-renders" data-turn-layer="html-renders">
      {turn.htmlRenders.map((message) => message.htmlRender && (
        <HtmlRenderFrame
          key={`${message.id}:${message.htmlRender.renderId}`}
          reference={message.htmlRender}
          onOpenFullSize={setFullSize}
        />
      ))}
      {fullSize && (
        <DeferredHtmlRenderDialog reference={fullSize} onClose={closeFullSize} />
      )}
    </div>
  );
}

export function HtmlRenderFrame({
  reference,
  onOpenFullSize,
}: {
  reference: HtmlRenderReference;
  onOpenFullSize: (reference: HtmlRenderReference) => void;
}): React.JSX.Element {
  const theme = useHtmlRenderTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  // The fragment themes first paint; later changes arrive as messages so the
  // page is never reloaded.
  const [src] = useState(() => htmlRenderUrl(reference.renderId) + htmlRenderThemeFragment(theme));
  const [height, setHeight] = useState(() => clampHtmlRenderHeight(reference.height));
  const [revealed, setRevealed] = useState(false);
  const openLink = useHtmlRenderLinkOpener(frameRef);
  const receive = useCallback((message: HtmlRenderFrameMessage) => {
    if (message.type === "size") {
      setHeight(clampHtmlRenderHeight(message.height));
      setRevealed(true);
    } else if (message.type === "open-link") {
      openLink(message.url);
    }
    // `escape` only closes the full-size dialog.
  }, [openLink]);
  const handleLoad = useHtmlRenderFrameBridge(frameRef, theme, receive);

  useEffect(() => {
    if (revealed) return;
    const timer = window.setTimeout(() => setRevealed(true), HTML_RENDER_REVEAL_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [revealed]);

  return (
    <figure
      className="html-render"
      aria-label={reference.title}
      data-testid="html-render"
      data-render-id={reference.renderId}
      data-html-render-state={revealed ? "ready" : "pending"}
    >
      <IconButton
        label={`Open ${reference.title} full size`}
        className="html-render-open"
        data-testid="html-render-open"
        onClick={() => onOpenFullSize(reference)}
      >
        <Maximize2 size={14} aria-hidden="true" />
      </IconButton>
      <iframe
        ref={frameRef}
        className="html-render-frame"
        data-testid="html-render-frame"
        title={reference.title}
        src={src}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        loading="lazy"
        allow=""
        style={{ height, colorScheme: theme.scheme }}
        onLoad={handleLoad}
      />
    </figure>
  );
}
