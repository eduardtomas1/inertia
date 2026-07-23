export type DismissibleMenuAction<Menu extends string> =
  | { type: "toggle"; menu: Menu }
  | { type: "inside-pointer" }
  | { type: "outside-pointer" }
  | { type: "escape" }
  | { type: "selection" }
  | { type: "context-change" };

export type HorizontalSubmenuSide = "left" | "right";

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
