import { FilePenLine, Save, X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

import type { WorkspaceFilePreview } from "@shared/contracts";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import {
  focusModalOnAnimationFrame,
  trapModalFocus,
} from "../utils/modalFocus";
import { LoadingMark } from "./ui";

function normalizedEditorText(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

export function serializeEditorText(
  source: string,
  edited: string,
): string {
  const crlfLines = source.match(/\r\n/gu)?.length ?? 0;
  const lfLines = source.match(/(?<!\r)\n/gu)?.length ?? 0;
  const normalized = normalizedEditorText(edited);
  return crlfLines > lfLines
    ? normalized.replace(/\n/gu, "\r\n")
    : normalized;
}

export function FileEditorDialog({
  file,
  canSave,
  onClose,
  onSave,
}: {
  file: WorkspaceFilePreview;
  canSave: (
    path: string,
    content: string,
    expectedDigest: string,
  ) => boolean;
  onClose: () => void;
  onSave: (
    path: string,
    content: string,
    expectedDigest: string,
  ) => Promise<WorkspaceFilePreview>;
}): React.JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const originalEditorText = normalizedEditorText(file.content);
  const [content, setContent] = useState(originalEditorText);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = content !== originalEditorText;
  const serializedContent = serializeEditorText(file.content, content);
  const withinTransportLimit = canSave(
    file.path,
    serializedContent,
    file.contentDigest,
  );
  const sizeError = changed && !withinTransportLimit
    ? "This edit is too large to send safely. Shorten the file before saving."
    : null;
  useNativePreviewSuspension(true);

  useEffect(() => {
    return focusModalOnAnimationFrame(() => editorRef.current?.focus());
  }, []);

  const closeSafely = (): void => {
    if (saving) return;
    if (
      changed
      && !window.confirm("Discard the unsaved changes to this file?")
    ) return;
    onClose();
  };

  const save = async (): Promise<void> => {
    if (!changed || saving || !withinTransportLimit) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(
        file.path,
        serializedContent,
        file.contentDigest,
      );
      onClose();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "The file could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  };

  const trapFocus = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeSafely();
      return;
    }
    if (
      event.key.toLocaleLowerCase("en-US") === "s"
      && (event.metaKey || event.ctrlKey)
    ) {
      event.preventDefault();
      void save();
      return;
    }
    trapModalFocus(event, event.currentTarget);
  };

  return createPortal(
    <div className="dialog-backdrop file-editor-backdrop" role="presentation">
      <section
        className="file-editor-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={saving}
        onKeyDown={trapFocus}
      >
        <header>
          <span className="dialog-icon">
            <FilePenLine size={18} aria-hidden="true" />
          </span>
          <div>
            <h2 id={titleId}>Edit {file.path.split("/").at(-1)}</h2>
            <p id={descriptionId} title={file.path}>{file.path}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close file editor"
            disabled={saving}
            onClick={closeSafely}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <textarea
          ref={editorRef}
          value={content}
          aria-label={`Edit contents of ${file.path}`}
          spellCheck={false}
          disabled={saving}
          onChange={(event) => {
            setContent(event.currentTarget.value);
            setError(null);
          }}
        />
        {(error || sizeError) && (
          <p className="file-editor-error" role="alert">
            {error ?? sizeError}
          </p>
        )}
        <footer>
          <span>Changes are checked against the version you opened.</span>
          <button
            type="button"
            className="secondary-button"
            disabled={saving}
            onClick={closeSafely}
          >
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!changed || saving || !withinTransportLimit}
            onClick={() => void save()}
          >
            {saving
              ? <LoadingMark label="Saving file" />
              : <Save size={14} aria-hidden="true" />}
            <span>{saving ? "Saving…" : "Save"}</span>
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
