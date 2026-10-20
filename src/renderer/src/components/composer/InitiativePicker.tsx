import { useId, useLayoutEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Flag, Plus } from "lucide-react";
import { compareInitiatives } from "@shared/initiatives";

import { useDismissibleMenu } from "../../hooks/useDismissibleMenu";
import { requestNewInitiative } from "../../utils/initiativeDialog";
import { navigateMenuItems } from "../../utils/menuKeyboard";
import { InitiativeDot } from "../initiatives/InitiativeMark";
import type { NewChatInitiativePicker } from "./types";

const MENU = "initiative";

/**
 * Chooses the initiative a new chat joins. It sits beside the project picker
 * and never changes the chat's project, checkout or route.
 */
export function InitiativePicker({ picker }: { picker: NewChatInitiativePicker }): React.JSX.Element {
  const menuId = useId();
  const { menu, toggleMenu, dismissMenu, setMenuTrigger, setMenuPopover } = useDismissibleMenu<typeof MENU>();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const popover = useRef<HTMLDivElement | null>(null);
  const open = menu === MENU && !picker.disabled;
  const active = useMemo(
    () => picker.initiatives.filter(({ status }) => status === "active").sort(compareInitiatives),
    [picker.initiatives],
  );
  const selected = active.find(({ id }) => id === picker.selectedId) ?? null;
  const label = selected?.name ?? "No initiative";

  useLayoutEffect(() => {
    if (!open) return;
    const node = popover.current;
    const anchor = trigger.current?.getBoundingClientRect();
    if (!node || !anchor) return;
    const height = node.offsetHeight;
    const width = node.offsetWidth;
    const above = anchor.top - height - 4;
    node.style.top = `${Math.max(8, above >= 8 ? above : Math.min(anchor.bottom + 4, window.innerHeight - height - 8))}px`;
    node.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))}px`;
    (node.querySelector<HTMLButtonElement>('[aria-checked="true"]')
      ?? node.querySelector<HTMLButtonElement>("button"))?.focus({ preventScroll: true });
  }, [open]);

  const choose = (initiativeId: string | null): void => {
    dismissMenu("selection");
    if (initiativeId !== picker.selectedId) picker.onChange(initiativeId);
  };

  return (
    <div className="composer-project-picker composer-initiative-picker">
      <button
        ref={(node) => { trigger.current = node; setMenuTrigger(MENU, node); }}
        type="button"
        className="composer-project-picker-trigger"
        aria-label={`Initiative: ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={picker.disabled}
        onClick={() => toggleMenu(MENU)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          if (!open) toggleMenu(MENU);
        }}
      >
        {selected ? <InitiativeDot color={selected.color} /> : <Flag size={14} aria-hidden="true" />}
        <span>{label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && createPortal(
        <div
          ref={(node) => { popover.current = node; setMenuPopover(MENU, node); }}
          id={menuId}
          className="composer-popover initiative-picker-menu"
          role="menu"
          aria-label="Choose initiative"
          onKeyDown={(event) => navigateMenuItems(event)}
        >
          <button type="button" role="menuitemradio" tabIndex={-1} aria-checked={selected === null} onClick={() => choose(null)}>
            <span className="menu-check">{selected === null && <Check size={14} aria-hidden="true" />}</span>
            <span>No initiative</span>
          </button>
          {active.map((initiative) => (
            <button key={initiative.id} type="button" role="menuitemradio" tabIndex={-1}
              aria-checked={selected?.id === initiative.id} onClick={() => choose(initiative.id)}>
              <span className="menu-check">{selected?.id === initiative.id && <Check size={14} aria-hidden="true" />}</span>
              <InitiativeDot color={initiative.color} />
              <span>{initiative.name}</span>
            </button>
          ))}
          <div role="separator" />
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => {
            dismissMenu("context-change");
            requestNewInitiative({
              onCreated: (initiativeId) => picker.onChange(initiativeId),
              returnFocus: trigger.current,
            });
          }}>
            <span className="menu-check"><Plus size={14} aria-hidden="true" /></span>
            <span>New initiative…</span>
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
