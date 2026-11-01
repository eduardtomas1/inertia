import {
  useMemo,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { CircleHelp, MessageSquarePlus, X } from "lucide-react";
import type { WorkspaceFilePreview } from "@shared/contracts";
import { IconButton } from "./ui";
import { COMPOSER_PREFILL_UNAVAILABLE, requestComposerPrefill } from "../utils/composerPrefill";
import {
  buildFileSelectionPrompt,
  fileSelectionRangeLabel,
  nextFilePreviewSelection,
  type FilePreviewLineSelection,
  type FileSelectionPromptMode,
} from "../utils/filePreviewSelection";

export interface FilePreviewLineSelectionOptions {
  preview: WorkspaceFilePreview | null;
  /** Preview lines split on "\n", exactly as rendered. */
  previewLines: readonly string[];
  /** Composer target; without a chat there is nothing to prefill. */
  conversationId?: string;
  /** False for rendered Markdown and while the editing dialog is open. */
  enabled: boolean;
  renderedLineNumbers: readonly number[];
  preferredLine: number | null;
  codeRef: RefObject<HTMLPreElement | null>;
  scrollToLine: (line: number) => void;
  onComposerPrefill?: (mode: FileSelectionPromptMode) => void;
}

export interface FilePreviewLineSelectionController {
  selectableLineCount: number;
  selection: FilePreviewLineSelection | null;
  /** Set when the selection could not reach a message box and was kept. */
  notice: string | null;
  rovingLine: number | null;
  setFocusedLine: (line: number) => void;
  chooseLine: (line: number, extend: boolean) => void;
  clear: () => void;
  send: (mode: FileSelectionPromptMode) => void;
  onLineKeyDown: (event: KeyboardEvent<HTMLButtonElement>, line: number) => void;
  onCodeKeyDown: (event: KeyboardEvent<HTMLPreElement>) => void;
}

/**
 * Line-range selection for the source preview. Only whole, loaded lines of a
 * text preview are selectable: a truncated preview's final line may be
 * partial, and binary content is never offered.
 */
export function useFilePreviewLineSelection({
  preview,
  previewLines,
  conversationId,
  enabled,
  renderedLineNumbers,
  preferredLine,
  codeRef,
  scrollToLine,
  onComposerPrefill,
}: FilePreviewLineSelectionOptions): FilePreviewLineSelectionController {
  const [lineSelection, setLineSelection] =
    useState<FilePreviewLineSelection | null>(null);
  const [focusedLine, setFocusedLine] = useState<number | null>(null);
  const [undelivered, setUndelivered] =
    useState<FilePreviewLineSelection | null>(null);
  const binary = useMemo(
    () => preview?.content.includes("\0") === true,
    [preview],
  );
  const identity = preview ? `${preview.path}\0${preview.contentDigest}` : "";
  const selectableLineCount = preview && conversationId && enabled && !binary
    ? preview.truncated
      ? Math.max(0, previewLines.length - 1)
      : previewLines.length
    : 0;
  const selection = lineSelection
    && lineSelection.identity === identity
    && lineSelection.end <= selectableLineCount
    ? lineSelection
    : null;
  const candidate = selection?.end ?? focusedLine ?? preferredLine;
  const rovingLine = candidate !== null
    && candidate <= selectableLineCount
    && renderedLineNumbers.includes(candidate)
    ? candidate
    : renderedLineNumbers.find((line) => line <= selectableLineCount) ?? null;

  const focusLine = (line: number): void => {
    if (line < 1 || line > selectableLineCount) return;
    setFocusedLine(line);
    scrollToLine(line);
    const attempt = (remaining: number): void => {
      const button = codeRef.current?.querySelector<HTMLButtonElement>(
        `[data-line-select="${line}"]`,
      );
      if (button) button.focus();
      else if (remaining > 0) {
        window.requestAnimationFrame(() => attempt(remaining - 1));
      }
    };
    attempt(3);
  };

  const chooseLine = (line: number, extend: boolean): void => {
    setLineSelection((current) => nextFilePreviewSelection(
      current,
      identity,
      line,
      extend,
      selectableLineCount,
    ));
    setFocusedLine(line);
  };

  const clear = (): void => {
    const line = selection?.end ?? null;
    setLineSelection(null);
    if (line !== null) focusLine(line);
  };

  const onLineKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    line: number,
  ): void => {
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      chooseLine(line, true);
      return;
    }
    const target = event.key === "ArrowDown"
      ? line + 1
      : event.key === "ArrowUp"
        ? line - 1
        : event.key === "Home" && event.ctrlKey
          ? 1
          : event.key === "End" && event.ctrlKey
            ? selectableLineCount
            : null;
    if (target === null || target < 1 || target > selectableLineCount) return;
    event.preventDefault();
    if (event.shiftKey) chooseLine(target, true);
    focusLine(target);
  };

  const onCodeKeyDown = (event: KeyboardEvent<HTMLPreElement>): void => {
    if (event.key !== "Escape" || !selection) return;
    event.preventDefault();
    event.stopPropagation();
    clear();
  };

  const send = (mode: FileSelectionPromptMode): void => {
    if (!preview || !selection || !conversationId) return;
    const prompt = buildFileSelectionPrompt({
      path: preview.path,
      lines: previewLines,
      start: selection.start,
      end: selection.end,
      mode,
    });
    if (!requestComposerPrefill({ conversationId, text: prompt.text })) {
      setUndelivered(selection);
      return;
    }
    setUndelivered(null);
    setLineSelection(null);
    onComposerPrefill?.(mode);
  };

  return {
    selectableLineCount,
    selection,
    notice: selection !== null && undelivered === selection ? COMPOSER_PREFILL_UNAVAILABLE : null,
    rovingLine,
    setFocusedLine,
    chooseLine,
    clear,
    send,
    onLineKeyDown,
    onCodeKeyDown,
  };
}

export function PreviewLineNumber({
  line,
  className,
  selected,
  controller,
}: {
  line: number;
  className: string;
  selected: boolean;
  controller: FilePreviewLineSelectionController;
}): React.JSX.Element {
  if (line > controller.selectableLineCount) {
    return <span className={className} aria-hidden="true">{line}</span>;
  }
  return (
    <button
      type="button"
      className={className}
      data-line-select={line}
      tabIndex={line === controller.rovingLine ? 0 : -1}
      aria-label={`Select line ${line}`}
      aria-pressed={selected}
      aria-keyshortcuts="Shift+Enter Escape"
      onFocus={() => controller.setFocusedLine(line)}
      onClick={(event) => controller.chooseLine(line, event.shiftKey)}
      onKeyDown={(event) => controller.onLineKeyDown(event, line)}
    >
      {line}
    </button>
  );
}

export interface FilesPanelLineSelectionProps {
  path: string;
  start: number;
  end: number;
  notice?: string | null;
  onSend: (mode: FileSelectionPromptMode) => void;
  onClear: () => void;
}

export function FilesPanelLineSelection({
  path,
  start,
  end,
  notice = null,
  onSend,
  onClear,
}: FilesPanelLineSelectionProps): React.JSX.Element {
  const range = fileSelectionRangeLabel(start, end);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClear();
  };
  return (
    <div
      className="file-line-selection-popover"
      role="toolbar"
      aria-label={`Selected ${range} of ${path}`}
      onKeyDown={onKeyDown}
    >
      <span className="file-line-selection-range" aria-hidden="true">
        {range.charAt(0).toUpperCase() + range.slice(1)}
      </span>
      <div className="diff-selection-actions">
        <button type="button" onClick={() => onSend("ask")}>
          <CircleHelp size={14} aria-hidden="true" />
          Ask about
        </button>
        <button type="button" onClick={() => onSend("add")}>
          <MessageSquarePlus size={14} aria-hidden="true" />
          Add to prompt
        </button>
        <IconButton label="Clear line selection" onClick={onClear}>
          <X size={14} />
        </IconButton>
      </div>
      <span className={notice ? "file-line-selection-range has-notice" : "file-line-selection-range"} role="status">
        {notice}
      </span>
    </div>
  );
}
