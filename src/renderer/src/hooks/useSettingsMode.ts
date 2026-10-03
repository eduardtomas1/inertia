import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { AppView } from "../appView";
import type { SettingsSection, SettingsTarget } from "../lib/settingsTarget";

const ESCAPE_OWNERS = 'select, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], .xterm';

export interface SettingsMode {
  settingsTarget: SettingsTarget | null;
  lastSection: SettingsSection;
  openSettings: (target?: SettingsTarget) => void;
  closeSettings: () => void;
  toggleSettings: () => void;
  rememberSection: (section: SettingsSection) => void;
}

function focusAfterSettings(opener: HTMLElement | null, view: AppView): void {
  if (opener?.isConnected && !opener.closest("[inert]")) {
    opener.focus();
    if (document.activeElement === opener) return;
  }
  const composer = view === "workspace"
    ? document.querySelector<HTMLElement>('section[aria-label="Message composer"] textarea')
    : null;
  const target = composer ?? document.getElementById("main-workspace");
  target?.focus();
}

export function escapeLeavesSettings(event: KeyboardEvent): boolean {
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return false;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return false;
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return true;
  return !target.closest(ESCAPE_OWNERS);
}

export function useSettingsMode({
  view,
  navigateToView,
}: {
  view: AppView;
  navigateToView: (view: AppView) => void;
}): SettingsMode {
  const [settingsTarget, setSettingsTarget] = useState<SettingsTarget | null>(null);
  const [lastSection, setLastSection] = useState<SettingsSection>("appearance");
  const returnView = useRef<AppView>("workspace");
  const opener = useRef<HTMLElement | null>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const previousView = useRef(view);

  useEffect(() => {
    const remember = (event: FocusEvent): void => {
      if (event.target instanceof HTMLElement && !event.target.closest(".settings-view")) {
        lastFocused.current = event.target;
      }
    };
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, []);

  useLayoutEffect(() => {
    const before = previousView.current;
    previousView.current = view;
    if (before === view) return;
    if (view === "settings") {
      returnView.current = before;
      opener.current = lastFocused.current;
      return;
    }
    if (before !== "settings") return;
    setSettingsTarget(null);
    const restore = opener.current;
    opener.current = null;
    const frame = window.requestAnimationFrame(() => focusAfterSettings(restore, view));
    return () => window.cancelAnimationFrame(frame);
  }, [view]);

  const openSettings = useCallback((target?: SettingsTarget) => {
    if (target) setSettingsTarget(target);
    navigateToView("settings");
  }, [navigateToView]);

  const closeSettings = useCallback(() => {
    navigateToView(returnView.current === "settings" ? "workspace" : returnView.current);
  }, [navigateToView]);

  const toggleSettings = useCallback(() => {
    if (previousView.current === "settings") closeSettings();
    else openSettings();
  }, [closeSettings, openSettings]);

  useEffect(() => {
    if (view !== "settings") return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!escapeLeavesSettings(event)) return;
      event.preventDefault();
      closeSettings();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeSettings, view]);

  return {
    settingsTarget,
    lastSection,
    openSettings,
    closeSettings,
    toggleSettings,
    rememberSection: setLastSection,
  };
}
