import type { WatcherNoteAttribution } from "@shared/watcher";
import { WATCHER_NOTE_TITLE, watcherPresetName } from "../../utils/watcherLinks";
import { ProviderBrandIcon } from "../ProviderBrandIcon";
import "./ContextCompactionRow.css";
import "./ProviderHandoffRow.css";

export function watcherNoteLabel(note: Pick<WatcherNoteAttribution, "preset" | "watcherLabel">): string {
  return `${WATCHER_NOTE_TITLE} · ${watcherPresetName(note.preset)} · ${note.watcherLabel}`;
}

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
          {note.providerId ? (
            <span className="provider-handoff-route">
              <ProviderBrandIcon providerId={note.providerId} decorative size={14} />
              <span>{note.watcherLabel}</span>
            </span>
          ) : <span>{note.watcherLabel}</span>}
        </small>
        <span aria-hidden="true" />
      </div>
    </section>
  );
}
