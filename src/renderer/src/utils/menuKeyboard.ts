import type { KeyboardEvent } from "react";

import {
  isSidebarNavigationKey,
  nextSidebarNavigationIndex,
} from "./sidebarModel";

export function navigateMenuItems(
  event: KeyboardEvent<HTMLElement>,
  selector = "button:not(:disabled)",
): void {
  if (!isSidebarNavigationKey(event.key)) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
    selector,
  )];
  if (items.length === 0) return;
  const current = items.findIndex((item) => item === document.activeElement);
  const next = nextSidebarNavigationIndex(
    current,
    event.key,
    items.length,
  );
  event.preventDefault();
  event.stopPropagation();
  items[next]?.focus({ preventScroll: true });
}
