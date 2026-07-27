import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useDismissibleMenu } from "../../hooks/useDismissibleMenu";
import {
  chooseHorizontalSubmenuSide,
  type HorizontalSubmenuSide,
} from "../../utils/dismissibleMenu";
import { menuId } from "./config";
import type { ComposerMenu, MoreSection } from "./types";

export interface ComposerMenuController {
  menu: ComposerMenu | null;
  toggleMenu: (menu: ComposerMenu) => void;
  dismissMenu: (reason: "escape" | "selection" | "context-change") => void;
  setMenuTrigger: (menu: ComposerMenu, node: HTMLButtonElement | null) => void;
  setMenuPopover: (menu: ComposerMenu, node: HTMLDivElement | null) => void;
  moreSection: MoreSection | null;
  moreSubmenuSide: HorizontalSubmenuSide | null;
  morePopoverMaxHeight: number | null;
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
    setMenuPopover,
  } = useDismissibleMenu<ComposerMenu>();
  const [moreSection, setMoreSection] = useState<MoreSection | null>(null);
  const [moreSubmenuSide, setMoreSubmenuSide] =
    useState<HorizontalSubmenuSide | null>(null);
  const [morePopoverMaxHeight, setMorePopoverMaxHeight] =
    useState<number | null>(null);
  const morePopoverRef = useRef<HTMLDivElement>(null);
  const moreSectionTriggerRefs =
    useRef(new Map<MoreSection, HTMLButtonElement>());
  const moreHoverTimerRef = useRef<number | null>(null);

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
    if (menu !== "more") {
      setMorePopoverMaxHeight(null);
      return;
    }
    const updateAvailableHeight = () => {
      const popover = morePopoverRef.current;
      if (!popover) return;
      const header = popover.closest(".workspace-frame")
        ?.querySelector<HTMLElement>(".workspace-header");
      const safeTop = Math.max(
        8,
        (header?.getBoundingClientRect().bottom ?? 0) + 8,
      );
      setMorePopoverMaxHeight(Math.max(
        80,
        Math.floor(popover.getBoundingClientRect().bottom - safeTop),
      ));
    };
    updateAvailableHeight();
    window.addEventListener("resize", updateAvailableHeight);
    return () => window.removeEventListener("resize", updateAvailableHeight);
  }, [menu]);

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
    const popover = morePopoverRef.current;
    if (!popover) return null;
    return chooseHorizontalSubmenuSide(
      popover.getBoundingClientRect(),
      window.innerWidth,
      288,
    );
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
  ) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      "button:not(:disabled)",
    )];
    if (items.length === 0) return;
    event.preventDefault();
    const currentIndex = items.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    if (event.key === "Home") items[0]?.focus();
    else if (event.key === "End") items.at(-1)?.focus();
    else if (event.key === "ArrowDown") {
      items[(currentIndex + 1 + items.length) % items.length]?.focus();
    } else {
      items[(currentIndex - 1 + items.length) % items.length]?.focus();
    }
  };

  const focusComposerMenuEdge = (
    menuName: ComposerMenu,
    edge: "first" | "last" = "first",
  ): void => {
    window.requestAnimationFrame(() => {
      const items = [...(document.getElementById(menuId(menuName))
        ?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      (edge === "first" ? items[0] : items.at(-1))?.focus();
    });
  };

  const handleComposerMenuNavigation = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ): void => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      ":scope > button:not(:disabled)",
    )];
    if (items.length === 0) return;
    event.preventDefault();
    const currentIndex = items.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    if (event.key === "Home") items[0]?.focus();
    else if (event.key === "End") items.at(-1)?.focus();
    else if (event.key === "ArrowDown") {
      items[(currentIndex + 1 + items.length) % items.length]?.focus();
    } else {
      items[(currentIndex - 1 + items.length) % items.length]?.focus();
    }
  };

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
    morePopoverMaxHeight,
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
