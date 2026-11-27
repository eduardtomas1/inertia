import {
  useCallback,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";

const MAX_TEXTAREA_HEIGHT_PX = 200;

export function useTextareaAutosize(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  content: string,
): void {
  const metricsRef = useRef<{
    height: number;
    content: string;
    overflow: "" | "auto" | "hidden";
    width: number;
  }>({ height: 0, content: "", overflow: "", width: -1 });
  const contentRef = useRef(content);
  contentRef.current = content;

  const syncHeight = useCallback((force = false) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const metrics = metricsRef.current;
    const nextContent = contentRef.current;
    if (
      !force
      && metrics.overflow === "auto"
      && metrics.height >= MAX_TEXTAREA_HEIGHT_PX
      && metrics.content.length > 0
      && nextContent.length >= metrics.content.length
      && nextContent.startsWith(metrics.content)
    ) {
      metrics.content = nextContent;
      return;
    }
    textarea.style.height = "0px";
    const contentHeight = textarea.scrollHeight;
    const nextHeight = Math.min(contentHeight, MAX_TEXTAREA_HEIGHT_PX);
    const nextOverflow = contentHeight > MAX_TEXTAREA_HEIGHT_PX
      ? "auto"
      : "hidden";
    textarea.style.height = `${nextHeight}px`;
    if (metrics.overflow !== nextOverflow || textarea.style.overflowY !== nextOverflow) {
      textarea.style.overflowY = nextOverflow;
    }
    metrics.height = nextHeight;
    metrics.content = nextContent;
    metrics.overflow = nextOverflow;
  }, [textareaRef]);

  useLayoutEffect(() => {
    syncHeight(false);
  }, [content, syncHeight]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    metricsRef.current.width = textarea.getBoundingClientRect().width;
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = entry?.contentRect.width ?? metricsRef.current.width;
      if (Math.abs(nextWidth - metricsRef.current.width) < 1) return;
      metricsRef.current.width = nextWidth;
      syncHeight(true);
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [syncHeight, textareaRef]);
}
