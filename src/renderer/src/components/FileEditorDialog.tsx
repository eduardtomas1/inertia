import { Save } from "lucide-react";
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
import { DialogShell } from "./DialogShell";
import { LoadingMark } from "./ui";
import { SyntaxTextarea } from "./SyntaxTextarea";

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
  current,
  canSave,
  onClose,
  onSave,
  onReload,
}: {
  file: WorkspaceFilePreview;
  current?: WorkspaceFilePreview | null;
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
  onReload?: () => void;
}): React.JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [base, setBase] = useState(file);
  const originalEditorText = normalizedEditorText(base.content);
  const [content, setContent] = useState(originalEditorText);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadFrom, setReloadFrom] = useState<WorkspaceFilePreview | null | undefined>(undefined);
  if (reloadFrom !== undefined && current && current !== reloadFrom && current.path === base.path && !current.truncated) {
    setBase(current);
    setReloadFrom(undefined);
    setError(null);
  }
  const changed = content !== originalEditorText;
  const serializedContent = serializeEditorText(base.content, content);
  const withinTransportLimit = canSave(
    base.path,
    serializedContent,
    base.contentDigest,
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
        base.path,
        serializedContent,
        base.contentDigest,
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
    <DialogShell
      className="file-editor-dialog"
      bodyClassName="is-flush"
      titleId={titleId}
      title={`Edit ${file.path.split("/").at(-1)}`}
      description={<span title={file.path}>{file.path}</span>}
      descriptionId={descriptionId}
      closeLabel="Close file editor"
      closeDisabled={saving}
      onClose={closeSafely}
      aria-busy={saving}
      trapFocus={false}
      onKeyDown={trapFocus}
      footerStart={error || sizeError
        ? <span className="dialog-error" role="alert">{error ?? sizeError}</span>
        : "Changes are checked against the version you opened."}
      footer={<>
        {error && onReload && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setReloadFrom(current ?? null);
              onReload();
            }}
          >
            Reload
          </button>
        )}
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
      </>}
    >
      <SyntaxTextarea
        editorRef={editorRef}
        path={file.path}
        value={content}
        disabled={saving}
        onChange={(value) => {
          setContent(value);
          setError(null);
        }}
      />
    </DialogShell>,
    document.body,
  );
}
