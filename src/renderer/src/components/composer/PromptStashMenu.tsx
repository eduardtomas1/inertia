import { Archive, ArchiveRestore, Repeat, Trash2 } from "lucide-react";
import { lazy, Suspense, useRef } from "react";
import { COMPOSER_LABELS } from "../../lib/interfaceLabels";
import { readPromptStash, type PromptStashEntry } from "../../utils/promptStash";
import { menuId } from "./config";
import type { ComposerMenuController } from "./useComposerMenus";
import { TooltipButton } from "../TooltipButton";

const LegacyPromptStash = lazy(() => import("./LegacyPromptStash"));

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
  const label = COMPOSER_LABELS.scratchPrompts;
  const focusLegacy = useRef(false);
  const legacyEntries = menu === "stash" ? readPromptStash(window.localStorage) : [];
  const entryDeleteLabel = (entry: PromptStashEntry): string => {
    const content = entry.content.replace(/\s+/gu, " ").trim();
    const summary = content.length > 80
      ? `${content.slice(0, 77)}…`
      : content;
    return `Delete saved prompt: ${summary}`;
  };
  return (
    <div className="popover-anchor prompt-stash-control">
      <TooltipButton
        ref={(node) => setMenuTrigger("stash", node)}
        type="button"
        className="icon-button"
        aria-label={`${label}${entries.length ? `, ${entries.length} saved` : ""}`}
        aria-haspopup="menu"
        aria-controls={menuId("stash")}
        aria-expanded={menu === "stash"}
        tooltip={label}
        describeTooltip={false}
        onClick={() => { focusLegacy.current = false; toggleMenu("stash"); }}
        onKeyDown={(event) => {
          focusLegacy.current = false;
          handleComposerMenuTriggerKeyDown("stash", event);
        }}
      >
        <Archive size={16} />
      </TooltipButton>
      {menu === "stash" && (
        <div
          ref={(node) => setMenuPopover("stash", node)}
          id={menuId("stash")}
          className="composer-popover prompt-stash-popover"
          role="menu"
          aria-label={label}
          onKeyDown={handleMoreMenuNavigation}
        >
          <button
            type="button"
            role="menuitem"
            aria-disabled={!canStash}
            onClick={() => {
              if (!canStash) return;
              onStash();
              dismissMenu("context-change");
            }}
          >
            <Archive size={14} />
            <span>
              <strong>{COMPOSER_LABELS.saveScratchPrompt}</strong>
              {blockedReason && <small>{blockedReason}</small>}
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
                    title={entry.content}
                    onClick={() => {
                      if (restoreReason) return;
                      onRestore(entry);
                      dismissMenu("context-change");
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
                  <TooltipButton
                    role="menuitem"
                    className="prompt-stash-recurrence"
                    aria-label={`${recurrenceLabel}: ${entry.content}`}
                    tooltip={entry.recurrence
                      ? `${recurrenceLabel}; activate to ${nextRecurrence ? "change cadence" : "turn off"}`
                      : recurrenceLabel}
                    describeTooltip={false}
                    onClick={() => onSetRecurrence(entry.id, nextRecurrence)}
                  >
                    <Repeat size={14} aria-hidden="true" />
                    {entry.recurrence && <small>{entry.recurrence === "daily" ? "1d" : "7d"}</small>}
                  </TooltipButton>
                  <TooltipButton
                    role="menuitem"
                    className="prompt-stash-remove"
                    aria-label={deleteLabel}
                    tooltip="Delete saved prompt"
                    describeTooltip={false}
                    onClick={() => onRemove(entry.id)}
                  >
                    <Trash2 size={14} />
                  </TooltipButton>
                </div>
                );
              })}
            </div>
          )}
          {legacyEntries.length > 0 && <Suspense fallback={<button type="button" role="menuitem" aria-disabled="true"
            ref={(node) => { if (node) return () => { focusLegacy.current = document.activeElement === node; }; }}>
            Loading earlier prompts…
          </button>}><LegacyPromptStash entries={legacyEntries} focusOnMount={focusLegacy} /></Suspense>}
        </div>
      )}
    </div>
  );
}
