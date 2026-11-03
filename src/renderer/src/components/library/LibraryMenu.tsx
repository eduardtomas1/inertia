import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, Plus } from "lucide-react";
import clsx from "clsx";

import { navigateMenuItems } from "../../utils/menuKeyboard";
import "./LibraryMenu.css";

export interface LibraryMenuAnchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export type LibraryMenuEntry =
  | {
      kind: "item";
      id: string;
      label: string;
      icon?: ReactNode;
      checked?: boolean;
      danger?: boolean;
      disabled?: boolean;
      restoreFocus?: boolean;
      keepOpen?: boolean;
      onSelect: () => void;
    }
  | { kind: "heading"; id: string; label: string; detail?: string }
  | { kind: "separator"; id: string }
  | {
      kind: "create";
      id: string;
      label: string;
      inputLabel: string;
      disabled?: boolean;
      onCreate: (name: string) => Promise<string | null>;
    };

export interface LibraryMenuProps {
  label: string;
  anchor: LibraryMenuAnchor;
  entries: readonly LibraryMenuEntry[];
  trigger: HTMLElement | null;
  align?: "start" | "end";
  className?: string;
  onDismiss: () => void;
}

const MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;

export function anchorFromElement(element: Element): LibraryMenuAnchor {
  const { left, right, top, bottom } = element.getBoundingClientRect();
  return { left, right, top, bottom };
}

export function anchorFromPoint(x: number, y: number): LibraryMenuAnchor {
  return { left: x, right: x, top: y, bottom: y };
}

function focusTrigger(trigger: HTMLElement | null): void {
  if (trigger?.isConnected) trigger.focus({ preventScroll: true });
}

export function LibraryMenu({
  label,
  anchor,
  entries,
  trigger,
  align = "start",
  className,
  onDismiss,
}: LibraryMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const triggerRef = useRef(trigger);
  triggerRef.current = trigger;
  const errorId = useId();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const preferredLeft = align === "end" ? anchor.right - width : anchor.left;
    const left = Math.max(VIEWPORT_MARGIN, Math.min(preferredLeft, window.innerWidth - width - VIEWPORT_MARGIN));
    const below = anchor.bottom + MENU_GAP;
    const above = anchor.top - MENU_GAP - height;
    const top = below + height <= window.innerHeight - VIEWPORT_MARGIN || above < VIEWPORT_MARGIN
      ? Math.max(VIEWPORT_MARGIN, Math.min(below, window.innerHeight - height - VIEWPORT_MARGIN))
      : above;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  });

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const checked = menu.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)');
    (checked ?? menu.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus({ preventScroll: true });
  }, []);

  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const inside = (target: EventTarget | null): boolean => !mounted.current || target instanceof Node
      && (menuRef.current?.contains(target) === true || triggerRef.current?.contains(target) === true);
    const onFocusIn = (event: FocusEvent): void => {
      if (!inside(event.target)) dismissRef.current();
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (!inside(event.target)) dismissRef.current();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!mounted.current || event.key !== "Escape" || event.isComposing) return;
      if (event.target === inputRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      focusTrigger(triggerRef.current);
      dismissRef.current();
    };
    const onResize = (): void => {
      if (mounted.current) dismissRef.current();
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  useLayoutEffect(() => {
    if (creating) inputRef.current?.focus({ preventScroll: true });
  }, [creating]);

  const select = useCallback((entry: Extract<LibraryMenuEntry, { kind: "item" }>): void => {
    if (entry.disabled) return;
    if (entry.keepOpen) {
      entry.onSelect();
      return;
    }
    if (entry.restoreFocus !== false) focusTrigger(triggerRef.current);
    dismissRef.current();
    entry.onSelect();
  }, []);

  const stopCreating = (): void => {
    setCreating(false);
    setName("");
    setError(null);
    window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>("[data-library-menu-create]")?.focus({ preventScroll: true });
    });
  };

  const submit = async (entry: Extract<LibraryMenuEntry, { kind: "create" }>): Promise<void> => {
    const value = name.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    const failure = await entry.onCreate(value);
    setBusy(false);
    if (failure) {
      setError(failure);
      inputRef.current?.focus({ preventScroll: true });
      return;
    }
    focusTrigger(triggerRef.current);
    dismissRef.current();
  };

  return createPortal(
    <div
      ref={menuRef}
      className={clsx("conversation-menu library-menu", className)}
      role="menu"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.target === inputRef.current) return;
        if (event.key === "Tab") {
          event.preventDefault();
          focusTrigger(triggerRef.current);
          dismissRef.current();
          return;
        }
        navigateMenuItems(event);
      }}
    >
      {entries.map((entry) => {
        if (entry.kind === "separator") return <div key={entry.id} role="separator" />;
        if (entry.kind === "heading") {
          return (
            <div key={entry.id} className="library-menu-heading" role="presentation">
              <span>{entry.label}</span>
              {entry.detail && <small>{entry.detail}</small>}
            </div>
          );
        }
        if (entry.kind === "create") {
          if (!creating) {
            return (
              <button
                type="button"
                key={entry.id}
                role="menuitem"
                tabIndex={-1}
                disabled={entry.disabled}
                data-library-menu-create=""
                onClick={() => setCreating(true)}
              >
                <Plus size={14} aria-hidden="true" />
                {entry.label}
              </button>
            );
          }
          return (
            <div key={entry.id} className="library-menu-create" role="none">
              <input
                ref={inputRef}
                type="text"
                value={name}
                maxLength={60}
                aria-label={entry.inputLabel}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                placeholder="Category name"
                disabled={busy}
                onChange={(event) => {
                  setName(event.target.value);
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submit(entry);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    stopCreating();
                  }
                }}
              />
              {error && <p id={errorId} className="library-menu-error" role="alert">{error}</p>}
            </div>
          );
        }
        const radio = entry.checked !== undefined;
        return (
          <button
            type="button"
            key={entry.id}
            role={radio ? "menuitemradio" : "menuitem"}
            aria-checked={radio ? entry.checked : undefined}
            tabIndex={-1}
            disabled={entry.disabled}
            className={clsx(entry.danger && "is-danger")}
            onClick={() => select(entry)}
          >
            {entry.icon}
            <span className="library-menu-label">{entry.label}</span>
            {entry.checked && <Check size={14} className="library-menu-check" aria-hidden="true" />}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
