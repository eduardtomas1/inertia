import { useLayoutEffect, useRef, type RefObject } from "react";

const CHAT_MINIMUM_HEIGHT_PROPERTY = "--chat-minimum-height";

function pixels(value: string): number {
  return Number.parseFloat(value) || 0;
}

function paddingAndBorder(style: CSSStyleDeclaration): number {
  return pixels(style.paddingTop) + pixels(style.paddingBottom)
    + pixels(style.borderTopWidth) + pixels(style.borderBottomWidth);
}

export function measureChatMinimumHeight(workspace: Element): number {
  let total = paddingAndBorder(getComputedStyle(workspace));
  for (const child of Array.from(workspace.children)) {
    const style = getComputedStyle(child);
    if (style.display === "none" || style.position === "absolute" || style.position === "fixed") continue;
    total += pixels(style.marginTop) + pixels(style.marginBottom);
    total += pixels(style.flexGrow) > 0
      ? paddingAndBorder(style)
      : child.getBoundingClientRect().height;
  }
  return Math.ceil(total);
}

export function useChatMinimumHeight(
  hostRef: RefObject<HTMLElement | null>,
  scopeRef: RefObject<HTMLElement | null> = hostRef,
): void {
  const binding = useRef<{
    host: HTMLElement;
    scope: HTMLElement;
    stop: () => void;
  } | null>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    const scope = scopeRef.current;
    const previous = binding.current;
    // Ref objects survive Settings/split navigation; their DOM nodes do not.
    // Inspect each commit but keep observers while the actual pair is unchanged.
    if (previous?.host === host && previous.scope === scope) return;
    previous?.stop();
    binding.current = null;
    if (!host || !scope || typeof ResizeObserver === "undefined") return;
    let workspace: Element | null = null;
    const measure = (): void => {
      if (workspace?.isConnected) {
        host.style.setProperty(
          CHAT_MINIMUM_HEIGHT_PROPERTY,
          `${measureChatMinimumHeight(workspace)}px`,
        );
      } else {
        host.style.removeProperty(CHAT_MINIMUM_HEIGHT_PROPERTY);
      }
    };
    const resizeObserver = new ResizeObserver(measure);
    const childrenObserver = new MutationObserver(() => bind());
    const bind = (): void => {
      resizeObserver.disconnect();
      childrenObserver.disconnect();
      childrenObserver.observe(scope, { childList: true });
      workspace = scope.querySelector(":scope > .chat-workspace");
      if (workspace) {
        childrenObserver.observe(workspace, { childList: true });
        for (const child of Array.from(workspace.children)) resizeObserver.observe(child);
      }
      measure();
    };
    bind();
    binding.current = {
      host,
      scope,
      stop: () => {
        childrenObserver.disconnect();
        resizeObserver.disconnect();
        host.style.removeProperty(CHAT_MINIMUM_HEIGHT_PROPERTY);
      },
    };
  });
  useLayoutEffect(() => () => {
    binding.current?.stop();
    binding.current = null;
  }, []);
}
