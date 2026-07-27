import {
  useLayoutEffect,
  type RefObject,
} from "react";

const MAX_TEXTAREA_HEIGHT_PX = 176;

export function useTextareaAutosize(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  content: string,
): void {
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const syncHeight = () => {
      textarea.style.height = "0px";
      const contentHeight = textarea.scrollHeight;
      textarea.style.height = `${Math.min(contentHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
      textarea.style.overflowY = contentHeight > MAX_TEXTAREA_HEIGHT_PX
        ? "auto"
        : "hidden";
    };
    let observedWidth = textarea.getBoundingClientRect().width;
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = entry?.contentRect.width ?? observedWidth;
      if (Math.abs(nextWidth - observedWidth) < 1) return;
      observedWidth = nextWidth;
      syncHeight();
    });
    syncHeight();
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [content, textareaRef]);
}
