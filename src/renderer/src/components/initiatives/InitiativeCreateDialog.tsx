import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  defaultInitiativeColor,
  MAX_INITIATIVE_NAME_CHARS,
  isInitiativeName,
  type InitiativeColor,
} from "@shared/initiatives";

import { useNativePreviewSuspension } from "../../hooks/useNativePreviewSuspension";
import { captureModalFocus } from "../../utils/modalFocus";
import { DialogShell } from "../DialogShell";
import { PaletteColorPicker } from "../ProjectAppearanceControls";
import "./InitiativeCreateDialog.css";

export interface InitiativeCreateDialogProps {
  /** How many initiatives exist; the default colour rotates through the palette. */
  existingCount: number;
  /** Present when the new initiative will take this chat. */
  chatTitle?: string;
  onCreate: (name: string, color: InitiativeColor) => Promise<void>;
  onClose: () => void;
  /** The control that asked for the dialog; focus returns there on close. */
  returnFocus?: HTMLElement | null;
}

export function InitiativeCreateDialog({
  existingCount,
  chatTitle,
  onCreate,
  onClose,
  returnFocus = null,
}: InitiativeCreateDialogProps): React.JSX.Element {
  const [name, setName] = useState("");
  const [color, setColor] = useState<InitiativeColor>(() => defaultInitiativeColor(existingCount));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const trimmed = name.trim();
  const valid = isInitiativeName(trimmed);
  useNativePreviewSuspension(true);
  useLayoutEffect(() => {
    // Fallback for callers without a requesting control (it can be gone too).
    const restore = captureModalFocus();
    input.current?.focus();
    return () => {
      // A chat row that moved into the new initiative's section can be a new
      // element with the same Work identity.
      const identity = returnFocus?.dataset.workFocusId;
      const target = returnFocus?.isConnected
        ? returnFocus
        : identity
          ? [...document.querySelectorAll<HTMLElement>("[data-work-focus-id]")]
            .find((element) => element.dataset.workFocusId === identity)
          : undefined;
      if (target) target.focus({ preventScroll: true });
      else restore();
    };
  }, [returnFocus]);
  useLayoutEffect(() => {
    if (error && !busy) input.current?.focus();
  }, [busy, error]);
  const submit = async (): Promise<void> => {
    if (saving.current || !valid) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    try {
      await onCreate(trimmed, color);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error && failure.message
        ? failure.message
        : "The initiative could not be created. Try again.");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return createPortal(
    <DialogShell
      className="initiative-create-dialog"
      titleId={titleId}
      title="New initiative"
      description={chatTitle
        ? `Group chats from any project under one name. “${chatTitle}” moves into it.`
        : "Group chats from any project under one name."}
      descriptionId={descriptionId}
      closeLabel="Close new initiative"
      closeDisabled={busy}
      onClose={onClose}
      onDismiss={busy ? undefined : onClose}
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (!saving.current) onClose();
      }}
      footer={<>
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" className="primary-button dialog-primary" disabled={busy || !valid}>
          {busy ? "Creating…" : "Create initiative"}
        </button>
      </>}
    >
      <label className="dialog-field">Name
        <input
          ref={input}
          value={name}
          maxLength={MAX_INITIATIVE_NAME_CHARS}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          placeholder="Checkout redesign"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => setName(event.target.value.replace(/[\t\r\n]/gu, " "))}
        />
      </label>
      <div className="dialog-field initiative-create-color">
        <span>Colour</span>
        <PaletteColorPicker label="Initiative colour" value={color} disabled={busy} onChange={setColor} />
      </div>
      {error && <p id={errorId} className="dialog-error" role="alert">{error}</p>}
    </DialogShell>,
    document.body,
  );
}
