import { useEffect } from "react";

function focusStayedWithMenu(menu: HTMLElement, menuId: string): boolean {
  const active = document.activeElement;
  if (!active || active === document.body) return true;
  if (menu.contains(active)) return true;
  return active.getAttribute("aria-controls") === menuId;
}

export function FocusFirstMenuItem({ menuId }: { menuId: string }): null {
  useEffect(() => {
    let frame = 0;
    let attempts = 0;
    const focusFirst = (): void => {
      const menu = document.getElementById(menuId);
      if (!menu || menu.contains(document.activeElement)) return;
      if (!focusStayedWithMenu(menu, menuId)) return;
      const item = menu.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])');
      if (item) {
        item.focus();
        return;
      }
      attempts += 1;
      if (attempts < 30) frame = window.requestAnimationFrame(focusFirst);
    };
    frame = window.requestAnimationFrame(focusFirst);
    return () => window.cancelAnimationFrame(frame);
  }, [menuId]);
  return null;
}
