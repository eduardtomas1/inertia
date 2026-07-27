export type DismissibleMenuAction<Menu extends string> =
  | { type: "toggle"; menu: Menu }
  | { type: "inside-pointer" }
  | { type: "outside-pointer" }
  | { type: "escape" }
  | { type: "selection" }
  | { type: "context-change" };

export type HorizontalSubmenuSide = "left" | "right";

export const OUTSIDE_POINTER_FOCUS_TARGET_SELECTOR = [
  "button:not(:disabled)",
  "a[href]",
  "input:not(:disabled)",
  "textarea:not(:disabled)",
  "select:not(:disabled)",
  "summary",
  "label",
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

type ClosestTarget = {
  closest: (selectors: string) => unknown;
};

function hasClosestTarget(value: EventTarget | null): value is EventTarget & ClosestTarget {
  return Boolean(
    value
    && typeof (value as EventTarget & Partial<ClosestTarget>).closest
      === "function",
  );
}

/**
 * A blank outside click needs to return focus to the control that opened the
 * disclosure. A click aimed at another focus destination must be left alone so
 * the browser can move focus there without a later animation frame stealing it.
 */
export function outsidePointerShouldRestoreFocus(
  target: EventTarget | null,
): boolean {
  return !hasClosestTarget(target)
    || !target.closest(OUTSIDE_POINTER_FOCUS_TARGET_SELECTOR);
}

export function chooseHorizontalSubmenuSide(
  bounds: Pick<DOMRect, "left" | "right">,
  viewportWidth: number,
  requiredSpace: number,
): HorizontalSubmenuSide | null {
  if (viewportWidth - bounds.right >= requiredSpace) return "right";
  if (bounds.left >= requiredSpace) return "left";
  return null;
}

export function dismissibleMenuTransition<Menu extends string>(
  current: Menu | null,
  action: DismissibleMenuAction<Menu>,
): Menu | null {
  if (action.type === "toggle") return current === action.menu ? null : action.menu;
  if (action.type === "inside-pointer") return current;
  return null;
}
