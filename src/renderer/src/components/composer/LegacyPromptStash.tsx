import { useState } from "react";
import { ArchiveRestore } from "lucide-react";
import type { PromptStashEntry } from "../../utils/promptStash";

/** Ownerless v54 entries stay intact; a user can explicitly copy their text. */
export default function LegacyPromptStash({ entries }: { entries: readonly PromptStashEntry[] }): React.JSX.Element | null {
  const [message, setMessage] = useState<string | null>(null);
  const copy = async (entry: PromptStashEntry): Promise<void> => {
    try {
      if (!await window.inertia.copyText(entry.content)) throw new Error("Clipboard unavailable");
      setMessage("Copied. Paste into the chat of your choice.");
    } catch { setMessage("Could not copy this prompt. Try again."); }
  };
  const label = "Prompts saved before this update";
  return entries.length === 0 ? null : <div className="prompt-stash-list" role="group" aria-label={label}>
    <div className="popover-title">{label}</div>
    {entries.map((entry) => <div className="prompt-stash-entry" key={entry.id}>
      <button type="button" role="menuitem" title={entry.content} onClick={() => { void copy(entry); }}>
        <ArchiveRestore size={14} /><span className="prompt-stash-entry-copy">
          <strong className="prompt-stash-entry-preview">{entry.content}</strong>
          <small>Copy prompt · {entry.route.modelId}</small>
        </span>
      </button>
    </div>)}
    {message && <p role="status">{message}</p>}
  </div>;
}
