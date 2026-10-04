import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { AppView } from "../appView";
import type { SettingsSection, SettingsTarget } from "../lib/settingsTarget";

const ESCAPE_OWNERS = 'select:open, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], .xterm';
const TEXT_ENTRY = 'textarea, [contenteditable="true"], input:not([type]), input[type="text"], input[type="search"], '
  + 'input[type="password"], input[type="email"], input[type="url"], input[type="number"], input[type="tel"]';

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

function holdsUnsavedInput(target: Element): boolean {
  if (target.closest("[data-escape-leaves]")) return false;
  return target.matches(TEXT_ENTRY) || Boolean(target.closest("form"));
}

export function settingsEscapeAction(event: KeyboardEvent): "leave" | "release" | null {
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return null;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return null;
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return "leave";
  if (target.closest(ESCAPE_OWNERS)) return null;
  return holdsUnsavedInput(target) ? "release" : "leave";
}

export function escapeLeavesSettings(event: KeyboardEvent): boolean {
  return settingsEscapeAction(event) === "leave";
}

function releaseSettingsFocus(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.closest(".settings-view")) active.blur();
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
    releaseSettingsFocus();
    navigateToView(returnView.current === "settings" ? "workspace" : returnView.current);
  }, [navigateToView]);

  const toggleSettings = useCallback(() => {
    if (previousView.current === "settings") closeSettings();
    else openSettings();
  }, [closeSettings, openSettings]);

  useEffect(() => {
    if (view !== "settings") return;
    const onKeyDown = (event: KeyboardEvent): void => {
      const action = settingsEscapeAction(event);
      if (!action) return;
      event.preventDefault();
      if (action === "release") releaseSettingsFocus();
      else closeSettings();
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
