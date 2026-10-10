import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  clampHtmlRenderHeight,
  htmlRenderThemeFragment,
  type HtmlRenderFrameMessage,
  type HtmlRenderReference,
} from "@shared/html-render";
import { useHtmlRenderTheme } from "../../hooks/useHtmlRenderTheme";
import { DialogShell } from "../DialogShell";
import { useNativePreviewSuspension } from "../../hooks/useNativePreviewSuspension";
import { focusModalOnAnimationFrame } from "../../utils/modalFocus";
import { htmlRenderUrl } from "../../utils/htmlRenderUrl";
import { useHtmlRenderFrameBridge, useHtmlRenderLinkOpener, useReportedFrameHeight } from "./html-render-bridge";
import "./HtmlRenderDialog.css";

/** Full-size view of a visual reply: a second frame of the same page. */
export function HtmlRenderDialog({
  reference,
  onClose,
}: {
  reference: HtmlRenderReference;
  onClose: () => void;
}): React.JSX.Element {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const theme = useHtmlRenderTheme();
  const [src] = useState(() => htmlRenderUrl(reference.renderId) + htmlRenderThemeFragment(theme));
  const openLink = useHtmlRenderLinkOpener(frameRef);
  // The dialog shrink-wraps the page as this frame measures it; the stylesheet
  // applies the minimum and the viewport cap, past which the page scrolls.
  const [reportedHeight, reportHeight] = useReportedFrameHeight();
  const contentHeight = reportedHeight ?? clampHtmlRenderHeight(reference.height);
  useNativePreviewSuspension(true);

  const receive = useCallback((message: HtmlRenderFrameMessage) => {
    if (message.type === "escape") onClose();
    else if (message.type === "open-link") openLink(message.url);
    else if (message.type === "size") reportHeight(Math.ceil(message.height));
  }, [onClose, openLink, reportHeight]);
  const handleLoad = useHtmlRenderFrameBridge(frameRef, theme, receive);

  useEffect(() => {
    const restoreFocus = focusModalOnAnimationFrame(() => closeRef.current?.focus());
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("keydown", closeOnEscape, true);
      restoreFocus();
    };
  }, [onClose]);

  // Tabbing out of the frame's document leaves it in parent order, so guards
  // on both sides send focus back into the dialog.
  const focusFirst = (): void => closeRef.current?.focus();
  const focusLast = (): void => frameRef.current?.focus();

  return createPortal(
    <DialogShell
      className="html-render-dialog"
      backdropClassName="attachment-preview-backdrop html-render-dialog-backdrop"
      bodyClassName="is-flush"
      data-testid="html-render-dialog"
      tabIndex={-1}
      titleId={titleId}
      title={reference.title}
      closeLabel={`Close ${reference.title}`}
      closeRef={closeRef}
      onClose={onClose}
      onDismiss={onClose}
      before={<span className="html-render-dialog-guard" tabIndex={0} aria-hidden="true" onFocus={focusLast} />}
      after={<span className="html-render-dialog-guard" tabIndex={0} aria-hidden="true" onFocus={focusFirst} />}
    >
      <iframe
        ref={frameRef}
        className="html-render-dialog-frame"
        data-testid="html-render-dialog-frame"
        title={reference.title}
        src={src}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        allow=""
        style={{
          colorScheme: theme.scheme,
          "--html-render-content-height": `${contentHeight}px`,
        } as CSSProperties}
        onLoad={handleLoad}
      />
    </DialogShell>,
    document.body,
  );
}
