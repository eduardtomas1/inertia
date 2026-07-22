export type DismissibleMenuAction<Menu extends string> =
  | { type: "toggle"; menu: Menu }
  | { type: "inside-pointer" }
  | { type: "outside-pointer" }
  | { type: "escape" }
  | { type: "selection" }
  | { type: "context-change" };

export function dismissibleMenuTransition<Menu extends string>(
  current: Menu | null,
  action: DismissibleMenuAction<Menu>,
): Menu | null {
  if (action.type === "toggle") return current === action.menu ? null : action.menu;
  if (action.type === "inside-pointer") return current;
  return null;
}
