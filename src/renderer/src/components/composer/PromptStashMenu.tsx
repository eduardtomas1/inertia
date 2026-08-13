import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import { COMPOSER_LABELS } from "../../lib/interfaceLabels";
import type { PromptStashEntry } from "../../utils/promptStash";
import { menuId } from "./config";
import type { ComposerMenuController } from "./useComposerMenus";

export function PromptStashMenu({
  entries,
  canStash,
  blockedReason,
  restoreBlockedReason,
  menuController,
  onStash,
  onRestore,
  onRemove,
  onSetRecurrence,
}: {
  entries: readonly PromptStashEntry[];
  canStash: boolean;
  blockedReason: string | null;
  restoreBlockedReason: (entry: PromptStashEntry) => string | null;
  menuController: ComposerMenuController;
  onStash: () => void;
  onRestore: (entry: PromptStashEntry) => void;
  onRemove: (entryId: string) => void;
  onSetRecurrence: (
    entryId: string,
    recurrence: PromptStashEntry["recurrence"],
  ) => void;
}): React.JSX.Element {
  const {
    menu,
    toggleMenu,
    dismissMenu,
    setMenuTrigger,
    setMenuPopover,
    handleComposerMenuTriggerKeyDown,
    handleMoreMenuNavigation,
  } = menuController;
  const entryDeleteLabel = (entry: PromptStashEntry): string => {
    const content = entry.content.replace(/\s+/gu, " ").trim();
    const summary = content.length > 80
      ? `${content.slice(0, 77)}…`
      : content;
    return `Delete saved prompt: ${summary}`;
  };
  return (
    <div className="popover-anchor prompt-stash-control">
      <button
        ref={(node) => setMenuTrigger("stash", node)}
        type="button"
        className="icon-button"
        aria-label={`${COMPOSER_LABELS.scratchPrompts}${entries.length ? `, ${entries.length} saved` : ""}`}
        aria-haspopup="menu"
        aria-controls={menuId("stash")}
        aria-expanded={menu === "stash"}
        title={COMPOSER_LABELS.scratchPrompts}
        onClick={() => toggleMenu("stash")}
        onKeyDown={(event) =>
          handleComposerMenuTriggerKeyDown("stash", event)}
      >
        <Archive size={15} />
      </button>
      {menu === "stash" && (
        <div
          ref={(node) => setMenuPopover("stash", node)}
          id={menuId("stash")}
          className="composer-popover prompt-stash-popover"
          role="menu"
          aria-label={COMPOSER_LABELS.scratchPrompts}
          onKeyDown={handleMoreMenuNavigation}
        >
          <div className="popover-title" role="presentation">
            {COMPOSER_LABELS.scratchPrompts}
          </div>
          <button
            type="button"
            role="menuitem"
            aria-disabled={!canStash}
            title={blockedReason ?? "Save this text and model route"}
            onClick={() => {
              if (!canStash) return;
              onStash();
              dismissMenu("selection");
            }}
          >
            <Archive size={14} />
            <span>
              <strong>{COMPOSER_LABELS.saveScratchPrompt}</strong>
              <small>{blockedReason ?? "Text and route only"}</small>
            </span>
          </button>
          {entries.length === 0 ? (
            <p className="popover-empty">
              {COMPOSER_LABELS.noScratchPrompts}
            </p>
          ) : (
            <div
              className="prompt-stash-list"
              role="group"
              aria-label={COMPOSER_LABELS.savedScratchPrompts}
            >
              {entries.map((entry) => {
                const restoreReason = restoreBlockedReason(entry);
                const deleteLabel = entryDeleteLabel(entry);
                const nextRecurrence = entry.recurrence === "daily"
                  ? "weekly"
                  : entry.recurrence === "weekly" ? undefined : "daily";
                const recurrenceLabel = entry.recurrence
                  ? `${entry.recurrence === "daily" ? "Daily" : "Weekly"} recurring prompt`
                  : "Repeat daily";
                const recurrenceDue = entry.nextDueAt
                  && Date.parse(entry.nextDueAt) <= Date.now();
                return (
                <div className="prompt-stash-entry" key={entry.id}>
                  <button
                    type="button"
                    role="menuitem"
                    aria-disabled={restoreReason !== null}
                    title={restoreReason ?? entry.content}
                    onClick={() => {
                      if (restoreReason) return;
                      onRestore(entry);
                      dismissMenu("selection");
                    }}
                  >
                    <ArchiveRestore size={14} />
                    <span className="prompt-stash-entry-copy">
                      <strong className="prompt-stash-entry-preview">
                        {entry.content}
                      </strong>
                      <small>
                        {restoreReason ?? (
                          <>
                            {entry.route.modelId}
                            {entry.route.reasoningEffort
                              ? ` · ${entry.route.reasoningEffort}`
                              : ""}
                            {entry.route.fastMode === undefined
                              ? ""
                              : ` · ${entry.route.fastMode ? "Fast" : "Standard"}`}
                            {entry.recurrence
                              ? ` · repeats ${entry.recurrence}${recurrenceDue ? " · due" : ""}`
                              : ""}
                          </>
                        )}
                      </small>
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="prompt-stash-recurrence"
                    aria-label={`${recurrenceLabel}: ${entry.content}`}
                    title={entry.recurrence
                      ? `${recurrenceLabel}; activate to ${nextRecurrence ? "change cadence" : "turn off"}`
                      : "Keep this prompt recurring; it will never run automatically"}
                    onClick={() => onSetRecurrence(entry.id, nextRecurrence)}
                  >
                    <span aria-hidden="true">↻</span>
                    {entry.recurrence && <small>{entry.recurrence === "daily" ? "1d" : "7d"}</small>}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="prompt-stash-remove"
                    aria-label={deleteLabel}
                    title={deleteLabel}
                    onClick={() => onRemove(entry.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
