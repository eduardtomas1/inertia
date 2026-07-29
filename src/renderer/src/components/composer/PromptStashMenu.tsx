import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
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
}: {
  entries: readonly PromptStashEntry[];
  canStash: boolean;
  blockedReason: string | null;
  restoreBlockedReason: (entry: PromptStashEntry) => string | null;
  menuController: ComposerMenuController;
  onStash: () => void;
  onRestore: (entry: PromptStashEntry) => void;
  onRemove: (entryId: string) => void;
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
  return (
    <div className="popover-anchor prompt-stash-control">
      <button
        ref={(node) => setMenuTrigger("stash", node)}
        type="button"
        className="icon-button"
        aria-label={`Prompt stash${entries.length ? `, ${entries.length} saved` : ""}`}
        aria-haspopup="menu"
        aria-controls={menuId("stash")}
        aria-expanded={menu === "stash"}
        title="Prompt stash"
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
          aria-label="Prompt stash"
          onKeyDown={handleMoreMenuNavigation}
        >
          <div className="popover-title">Prompt stash</div>
          <button
            type="button"
            role="menuitem"
            disabled={!canStash}
            title={blockedReason ?? "Save this text and model route"}
            onClick={() => {
              onStash();
              dismissMenu("selection");
            }}
          >
            <Archive size={14} />
            <span>
              <strong>Stash current prompt</strong>
              <small>{blockedReason ?? "Text and route only"}</small>
            </span>
          </button>
          {entries.length === 0 ? (
            <p className="popover-empty">No saved prompts yet.</p>
          ) : (
            <div className="prompt-stash-list">
              {entries.map((entry) => (
                <div className="prompt-stash-entry" key={entry.id}>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={restoreBlockedReason(entry) !== null}
                    title={restoreBlockedReason(entry) ?? entry.content}
                    onClick={() => {
                      onRestore(entry);
                      dismissMenu("selection");
                    }}
                  >
                    <ArchiveRestore size={14} />
                    <span>
                      <strong>{entry.content}</strong>
                      <small>
                        {entry.route.modelId}
                        {entry.route.reasoningEffort
                          ? ` · ${entry.route.reasoningEffort}`
                          : ""}
                      </small>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="prompt-stash-remove"
                    aria-label="Delete saved prompt"
                    title="Delete saved prompt"
                    onClick={() => onRemove(entry.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
