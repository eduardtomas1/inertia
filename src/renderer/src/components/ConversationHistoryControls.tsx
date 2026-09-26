import { useEffect, useRef, useState } from "react";
import type { ConversationContentResult, ConversationDeferredContent, ConversationDetail } from "@shared/contracts";
import "./ConversationHistoryControls.css";

export interface ConversationHistoryControlsProps {
  history?: ConversationDetail["history"];
  deferredContent?: ConversationDeferredContent[];
  loading: boolean;
  historyError?: string | null;
  viewingHistory?: boolean;
  onOlder?: () => void;
  onNewer?: () => void;
  onLatest?: () => void;
  readContent?: (cursor: string) => Promise<ConversationContentResult>;
}

/** Both history windows and expanded text segments replace their predecessor. */
export function ConversationHistoryControls({ history, deferredContent = [], loading, historyError, viewingHistory, onOlder, onNewer, onLatest, readContent }: ConversationHistoryControlsProps) {
  const [selected, setSelected] = useState<ConversationDeferredContent | null>(null);
  const [cursors, setCursors] = useState<string[]>([]);
  const [content, setContent] = useState<ConversationContentResult | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  useEffect(() => () => { epoch.current += 1; }, []);
  const close = () => { epoch.current += 1; setSelected(null); setContent(null); setError(null); setPending(false); };
  const load = async (item: ConversationDeferredContent, pages: string[]) => {
    if (!readContent) return;
    const version = ++epoch.current;
    setSelected(item); setCursors(pages); setContent(null); setPending(true); setError(null);
    try {
      const result = await readContent(pages.at(-1)!);
      if (epoch.current === version) setContent(result);
    } catch {
      if (epoch.current === version) setError("This content changed or could not be loaded. Reopen it from the latest history.");
    } finally {
      if (epoch.current === version) setPending(false);
    }
  };
  if (!history?.olderCursor && !history?.newerCursor && deferredContent.length === 0 && !historyError && !viewingHistory) return null;
  return <section className="conversation-history-controls" aria-label="Conversation history">
    {historyError && <p role="alert">{historyError}</p>}
    {(history?.olderCursor || history?.newerCursor || historyError || viewingHistory) && <nav aria-label="History pages">
      {history?.olderCursor && <button type="button" disabled={loading || !onOlder} onClick={onOlder}>Older history</button>}
      {history?.newerCursor && <button type="button" disabled={loading || !onNewer} onClick={onNewer}>Newer history</button>}
      {(history?.newerCursor || historyError || viewingHistory) && <button type="button" disabled={loading || !onLatest} onClick={onLatest}>Latest history</button>}
    </nav>}
    {deferredContent.length > 0 && <details>
      <summary>Long content is previewed ({deferredContent.length})</summary>
      <ul>{deferredContent.map((item) => <li key={`${item.kind}:${item.id}`}>
        <button type="button" disabled={!readContent} onClick={() => { void load(item, [item.cursor]); }}>Read full {item.label}</button>
      </li>)}</ul>
    </details>}
    {selected && <section aria-label={`Full ${selected.label}`} className="conversation-content-reader" aria-busy={pending}>
      <div><strong>{selected.label}</strong><button type="button" onClick={close}>Close full content</button></div>
      {pending && <p role="status">Loading content…</p>}
      {error && <p role="alert">{error}</p>}
      {content && <>
        <p>Part {cursors.length} · {content.totalBytes.toLocaleString()} bytes total</p>
        <pre tabIndex={0} aria-label="Stored text segment">{content.text}</pre>
        <nav aria-label="Full content pages">
          {cursors.length > 1 && <button type="button" onClick={() => { void load(selected, cursors.slice(0, -1)); }}>Previous part</button>}
          {content.nextCursor && <button type="button" onClick={() => { void load(selected, [...cursors, content.nextCursor!]); }}>Next part</button>}
        </nav>
      </>}
    </section>}
  </section>;
}
