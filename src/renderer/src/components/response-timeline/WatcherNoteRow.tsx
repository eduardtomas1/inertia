import type { WatcherNoteAttribution } from "@shared/watcher";
import { watcherPresetName } from "../../utils/watcherLinks";
import "./ContextCompactionRow.css";
import "./ProviderHandoffRow.css";

export const WATCHER_NOTE_TITLE = "Note from watcher";

export function watcherNoteLabel(note: Pick<WatcherNoteAttribution, "preset" | "watcherLabel">): string {
  return `${WATCHER_NOTE_TITLE} · ${watcherPresetName(note.preset)} · ${note.watcherLabel}`;
}

/**
 * Marks where a forwarded watcher note starts a turn, so the note is never
 * read as the user's own words. Attribution comes from the persisted message.
 */
export function WatcherNoteRow({
  id,
  note,
}: {
  id: string;
  note: WatcherNoteAttribution;
}): React.JSX.Element {
  const label = watcherNoteLabel(note);
  return (
    <section className="context-compaction-row provider-handoff-row watcher-note-row" data-response-row-id={id} tabIndex={-1} aria-label={label}>
      <div className="context-compaction-separator provider-handoff-separator" role="separator" aria-label={label}>
        <span aria-hidden="true" />
        <small className="context-compaction-marker provider-handoff-marker" aria-hidden="true">
          <span>{WATCHER_NOTE_TITLE}</span>
          <i>·</i>
          <span>{watcherPresetName(note.preset)}</span>
          <i>·</i>
          <span>{note.watcherLabel}</span>
        </small>
        <span aria-hidden="true" />
      </div>
    </section>
  );
}
