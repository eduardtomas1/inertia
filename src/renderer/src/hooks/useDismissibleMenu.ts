import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
} from "react";
import {
  dismissibleMenuTransition,
  outsidePointerShouldRestoreFocus,
  type DismissibleMenuAction,
} from "../utils/dismissibleMenu";

const MAX_FOCUS_ATTEMPTS = 30;

export function useDismissibleMenu<Menu extends string>(): {
  menu: Menu | null;
  toggleMenu: (menu: Menu) => void;
  dismissMenu: (reason: Exclude<DismissibleMenuAction<Menu>["type"], "toggle" | "inside-pointer" | "outside-pointer">) => void;
  setMenuTrigger: (menu: Menu, node: HTMLButtonElement | null) => void;
  setMenuPopover: (menu: Menu, node: HTMLDivElement | null) => void;
} {
  const [menu, dispatch] = useReducer(dismissibleMenuTransition<Menu>, null);
  const menuRef = useRef<Menu | null>(null);
  const focusGeneration = useRef(0);
  const pendingFocusCleanup = useRef<(() => void) | null>(null);
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
    pendingFocusCleanup.current?.();
    pendingFocusCleanup.current = null;
    focusGeneration.current += 1;
    const generation = focusGeneration.current;
    let attempts = 0;
    const finish = (): void => {
      pendingFocusCleanup.current?.();
      pendingFocusCleanup.current = null;
    };
    let removeIntentListeners = (): void => undefined;
    const intentTimer = window.setTimeout(() => {
      if (generation !== focusGeneration.current) return;
      const cancel = (): void => {
        if (generation !== focusGeneration.current) return;
        focusGeneration.current += 1;
        finish();
      };
      const cancelOnFocusMove = (event: FocusEvent): void => {
        if (event.target !== triggers.current.get(name)) cancel();
      };
      document.addEventListener("pointerdown", cancel, true);
      document.addEventListener("focusin", cancelOnFocusMove, true);
      removeIntentListeners = () => {
        document.removeEventListener("pointerdown", cancel, true);
        document.removeEventListener("focusin", cancelOnFocusMove, true);
      };
    }, 0);
    pendingFocusCleanup.current = () => {
      window.clearTimeout(intentTimer);
      removeIntentListeners();
    };
    const focusWhenReady = (): void => {
      if (generation !== focusGeneration.current) return;
      const trigger = triggers.current.get(name);
      if (trigger?.isConnected && !trigger.disabled) {
        finish();
        trigger.focus();
        return;
      }
      attempts += 1;
      if (attempts < MAX_FOCUS_ATTEMPTS) {
        window.requestAnimationFrame(focusWhenReady);
      } else {
        finish();
      }
    };
    window.requestAnimationFrame(focusWhenReady);
  }, []);

  const cancelPendingFocus = useCallback(() => {
    focusGeneration.current += 1;
    pendingFocusCleanup.current?.();
    pendingFocusCleanup.current = null;
  }, []);

  const dismissMenu = useCallback((reason: "escape" | "selection" | "context-change") => {
    const activeMenu = menuRef.current;
    dispatch({ type: reason });
    if (reason === "escape" || reason === "selection") restoreTriggerFocus(activeMenu);
    else cancelPendingFocus();
  }, [cancelPendingFocus, restoreTriggerFocus]);

  const toggleMenu = useCallback((name: Menu) => {
    cancelPendingFocus();
    dispatch({ type: "toggle", menu: name });
  }, [cancelPendingFocus]);

  useEffect(() => cancelPendingFocus, [cancelPendingFocus]);

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
      if (outsidePointerShouldRestoreFocus(target)) restoreTriggerFocus(menu);
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
  }, [dismissMenu, menu, restoreTriggerFocus]);

  return { menu, toggleMenu, dismissMenu, setMenuTrigger, setMenuPopover };
}
