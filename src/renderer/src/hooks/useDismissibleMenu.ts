import { useCallback, useEffect, useReducer, useRef } from "react";
import { dismissibleMenuTransition, type DismissibleMenuAction } from "../utils/dismissibleMenu";

export function useDismissibleMenu<Menu extends string>(): {
  menu: Menu | null;
  toggleMenu: (menu: Menu) => void;
  dismissMenu: (reason: Exclude<DismissibleMenuAction<Menu>["type"], "toggle" | "inside-pointer" | "outside-pointer">) => void;
  setMenuTrigger: (menu: Menu, node: HTMLButtonElement | null) => void;
  setMenuPopover: (menu: Menu, node: HTMLDivElement | null) => void;
} {
  const [menu, dispatch] = useReducer(dismissibleMenuTransition<Menu>, null);
  const menuRef = useRef<Menu | null>(null);
  const triggers = useRef(new Map<Menu, HTMLButtonElement>());
  const popovers = useRef(new Map<Menu, HTMLDivElement>());
  menuRef.current = menu;

  const setMenuTrigger = useCallback((name: Menu, node: HTMLButtonElement | null) => {
    if (node) triggers.current.set(name, node);
    else triggers.current.delete(name);
  }, []);

  const setMenuPopover = useCallback((name: Menu, node: HTMLDivElement | null) => {
    if (node) popovers.current.set(name, node);
    else popovers.current.delete(name);
  }, []);

  const restoreTriggerFocus = useCallback((name: Menu | null) => {
    if (!name) return;
    window.requestAnimationFrame(() => triggers.current.get(name)?.focus());
  }, []);

  const dismissMenu = useCallback((reason: "escape" | "selection" | "context-change") => {
    const activeMenu = menuRef.current;
    dispatch({ type: reason });
    if (reason === "escape" || reason === "selection") restoreTriggerFocus(activeMenu);
  }, [restoreTriggerFocus]);

  const toggleMenu = useCallback((name: Menu) => dispatch({ type: "toggle", menu: name }), []);

  useEffect(() => {
    if (!menu) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggers.current.get(menu)?.contains(target) || popovers.current.get(menu)?.contains(target)) {
        dispatch({ type: "inside-pointer" });
        return;
      }
      dispatch({ type: "outside-pointer" });
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      dismissMenu("escape");
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [dismissMenu, menu]);

  return { menu, toggleMenu, dismissMenu, setMenuTrigger, setMenuPopover };
}
