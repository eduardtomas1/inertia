import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useDismissibleMenu } from "../../hooks/useDismissibleMenu";
import type { HorizontalSubmenuSide } from "../../utils/dismissibleMenu";
import { menuId, RESPONSE_SPEED_LABEL } from "./config";
import type { ComposerMenu, MoreSection } from "./types";
import { navigateMenuItems } from "../../utils/menuKeyboard";

export interface ComposerMenuController {
  menu: ComposerMenu | null;
  toggleMenu: (menu: ComposerMenu) => void;
  dismissMenu: (reason: "escape" | "selection" | "context-change") => void;
  setMenuTrigger: (menu: ComposerMenu, node: HTMLButtonElement | null) => void;
  setMenuPopover: (menu: ComposerMenu, node: HTMLDivElement | null) => void;
  moreSection: MoreSection | null;
  moreSubmenuSide: HorizontalSubmenuSide | null;
  morePopoverRef: React.RefObject<HTMLDivElement | null>;
  moreSectionTriggerRefs: React.RefObject<Map<MoreSection, HTMLButtonElement>>;
  clearMoreHoverTimer: () => void;
  openMoreSection: (section: MoreSection, focusSubmenu?: boolean) => void;
  previewMoreSection: (section: MoreSection) => void;
  closeMorePreview: () => void;
  returnToMoreRoot: (focusTrigger?: boolean) => void;
  handleMoreMenuNavigation: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  handleComposerMenuNavigation: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  handleComposerMenuTriggerKeyDown: (
    menuName: ComposerMenu,
    event: React.KeyboardEvent<HTMLButtonElement>,
  ) => void;
}

export function moreSectionLabel(section: MoreSection): string {
  return ({
    actions: "Actions",
    reasoning: "Reasoning",
    speed: RESPONSE_SPEED_LABEL,
    mode: "Mode",
    access: "Access",
  })[section];
}

export function useComposerMenus(): ComposerMenuController {
  const {
    menu,
    toggleMenu,
    dismissMenu,
    setMenuTrigger,
    setMenuPopover: setDismissibleMenuPopover,
  } = useDismissibleMenu<ComposerMenu>();
  const [moreSection, setMoreSection] = useState<MoreSection | null>(null);
  const [moreSubmenuSide, setMoreSubmenuSide] =
    useState<HorizontalSubmenuSide | null>(null);
  const morePopoverRef = useRef<HTMLDivElement>(null);
  const moreSectionTriggerRefs =
    useRef(new Map<MoreSection, HTMLButtonElement>());
  const moreHoverTimerRef = useRef<number | null>(null);
  const menuPopoverRef = useRef<HTMLDivElement | null>(null);

  const setMenuPopover = (
    name: ComposerMenu,
    node: HTMLDivElement | null,
  ): void => {
    setDismissibleMenuPopover(name, node);
    if (node) {
      menuPopoverRef.current = node;
    } else menuPopoverRef.current = null;
  };

  useEffect(() => {
    if (menu === "more") return;
    if (moreHoverTimerRef.current !== null) {
      window.clearTimeout(moreHoverTimerRef.current);
    }
    moreHoverTimerRef.current = null;
    setMoreSection(null);
    setMoreSubmenuSide(null);
  }, [menu]);

  useLayoutEffect(() => {
    if (!menu) return;
    const popover = menuPopoverRef.current;
    const trigger = popover?.closest<HTMLElement>(".composer")
      ?.querySelector<HTMLButtonElement>(`[aria-controls="${menuId(menu)}"]`);
    if (!trigger || !popover) return;
    let active = true;
    let stopObserving: (() => void) | null = null;
    void import("../../utils/composerPopoverPlacement").then((module) => {
      if (!active) return;
      stopObserving = module.observeComposerPopover(
        trigger,
        popover,
        (nextSide) => {
          if (menu === "more" && moreSection) {
            setMoreSubmenuSide(nextSide);
          }
        },
      );
    });
    return () => {
      active = false;
      stopObserving?.();
    };
  }, [menu, moreSection]);

  useEffect(() => () => {
    if (moreHoverTimerRef.current !== null) {
      window.clearTimeout(moreHoverTimerRef.current);
    }
  }, []);

  const clearMoreHoverTimer = () => {
    if (moreHoverTimerRef.current === null) return;
    window.clearTimeout(moreHoverTimerRef.current);
    moreHoverTimerRef.current = null;
  };

  const availableMoreSubmenuSide = (): HorizontalSubmenuSide | null => {
    const side = morePopoverRef.current?.parentElement
      ?.dataset.composerSubmenuSide;
    return side === "left" || side === "right" ? side : null;
  };

  const focusFirstMoreSubmenuItem = () => {
    window.requestAnimationFrame(() => {
      morePopoverRef.current?.parentElement
        ?.querySelector<HTMLButtonElement>(
          "[data-more-submenu] button:not(:disabled)",
        )
        ?.focus();
    });
  };

  const openMoreSection = (
    section: MoreSection,
    focusSubmenu = false,
  ) => {
    clearMoreHoverTimer();
    const side = availableMoreSubmenuSide();
    setMoreSection(section);
    setMoreSubmenuSide(side);
    if (focusSubmenu) focusFirstMoreSubmenuItem();
  };

  const previewMoreSection = (section: MoreSection) => {
    clearMoreHoverTimer();
    moreHoverTimerRef.current = window.setTimeout(() => {
      moreHoverTimerRef.current = null;
      const side = availableMoreSubmenuSide();
      if (!side) return;
      setMoreSection(section);
      setMoreSubmenuSide(side);
    }, 140);
  };

  const closeMorePreview = () => {
    clearMoreHoverTimer();
    moreHoverTimerRef.current = window.setTimeout(() => {
      moreHoverTimerRef.current = null;
      setMoreSection(null);
      setMoreSubmenuSide(null);
    }, 180);
  };

  const returnToMoreRoot = (focusTrigger = false) => {
    const previousSection = moreSection;
    clearMoreHoverTimer();
    setMoreSection(null);
    setMoreSubmenuSide(null);
    if (focusTrigger && previousSection) {
      window.requestAnimationFrame(() =>
        moreSectionTriggerRefs.current.get(previousSection)?.focus());
    }
  };

  const handleMoreMenuNavigation = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ) => navigateMenuItems(event, "button:not(:disabled)");

  const focusComposerMenuEdge = (
    menuName: ComposerMenu,
    edge: "first" | "last" = "first",
  ): void => {
    void import("../../utils/composerPopoverPlacement").then((module) =>
      module.focusComposerPopoverEdge(menuId(menuName), edge));
  };

  const handleComposerMenuNavigation = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ): void => navigateMenuItems(event, ":scope > button:not(:disabled)");

  const handleComposerMenuTriggerKeyDown = (
    menuName: ComposerMenu,
    event: React.KeyboardEvent<HTMLButtonElement>,
  ): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (menu !== menuName) toggleMenu(menuName);
    focusComposerMenuEdge(
      menuName,
      event.key === "ArrowUp" ? "last" : "first",
    );
  };

  return {
    menu,
    toggleMenu,
    dismissMenu,
    setMenuTrigger,
    setMenuPopover,
    moreSection,
    moreSubmenuSide,
    morePopoverRef,
    moreSectionTriggerRefs,
    clearMoreHoverTimer,
    openMoreSection,
    previewMoreSection,
    closeMorePreview,
    returnToMoreRoot,
    handleMoreMenuNavigation,
    handleComposerMenuNavigation,
    handleComposerMenuTriggerKeyDown,
  };
}
