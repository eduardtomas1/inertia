import { useLayoutEffect, useRef, useState } from "react";
import { ArchiveRestore } from "lucide-react";
import type { PromptStashEntry } from "../../utils/promptStash";

/** Ownerless v54 entries stay intact; a user can explicitly copy their text. */
export default function LegacyPromptStash({ entries, focusOnMount }: {
  entries: readonly PromptStashEntry[]; focusOnMount: React.RefObject<boolean>;
}): React.JSX.Element | null {
  const [message, setMessage] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // The focused loading item represents the requested last menu item.
    // Its ref cleanup records focus only if navigation has not moved away.
    if (!focusOnMount.current) return;
    focusOnMount.current = false;
    root.current?.querySelectorAll<HTMLButtonElement>("button").item(entries.length - 1)?.focus();
  }, [entries.length, focusOnMount]);
  const copy = async (entry: PromptStashEntry): Promise<void> => {
    try {
      if (!await window.inertia.copyText(entry.content)) throw new Error("Clipboard unavailable");
      setMessage("Copied. Paste into the chat of your choice.");
    } catch { setMessage("Could not copy this prompt. Try again."); }
  };
  const label = "Prompts saved before this update";
  return entries.length === 0 ? null : <div ref={root} className="prompt-stash-list" role="group" aria-label={label}>
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
