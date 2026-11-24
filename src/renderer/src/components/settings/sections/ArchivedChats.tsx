import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArchiveRestore } from "lucide-react";

import type { Conversation, ProviderInfo } from "@shared/contracts";
import {
  ARCHIVED_CONVERSATIONS_PAGE_SIZE,
  type ArchivedConversationsCursor,
  type ArchivedConversationsPage,
  type ArchivedConversationsRequest,
} from "@shared/archived-conversations";
import { INTERFACE_LOCALE } from "../../../lib/locale";
import { SettingsGroup } from "../SettingsLayout";

export const ARCHIVED_CHATS_PAGE_SIZE = ARCHIVED_CONVERSATIONS_PAGE_SIZE;
export const ARCHIVED_CHATS_LOAD_FAILED = "Archived chats could not be loaded.";

export type ArchivedConversationsLoader = (request: ArchivedConversationsRequest) => Promise<ArchivedConversationsPage>;

interface LoadedArchive {
  key: string;
  needle: string;
  items: Conversation[];
  total: number;
  next: ArchivedConversationsCursor | null;
}

export function ArchivedChats({
  count,
  load,
  providers,
  disabled,
  onUnarchive,
}: {
  count: number;
  load: ArchivedConversationsLoader | undefined;
  providers: ProviderInfo[];
  disabled: boolean;
  onUnarchive: (conversation: Conversation) => void | Promise<unknown>;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(ARCHIVED_CHATS_PAGE_SIZE);
  const [loaded, setLoaded] = useState<LoadedArchive | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [restored, setRestored] = useState<ReadonlySet<string>>(() => new Set());
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const firstNewRow = useRef<number | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const filter = useRef<HTMLInputElement>(null);
  const empty = useRef<HTMLParagraphElement>(null);
  const restoring = useRef<{ id: string; index: number } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const providerLabels = useMemo(() => new Map(providers.map((provider) => [provider.id, provider.label])), [providers]);
  const needle = query.trim().toLocaleLowerCase(INTERFACE_LOCALE);
  const providerIds = useMemo(() => needle
    ? providers.filter(({ label }) => label.toLocaleLowerCase(INTERFACE_LOCALE).includes(needle)).map(({ id }) => id)
    : [], [needle, providers]);
  const key = `${count}\u0000${needle}`;

  useEffect(() => {
    if (!load || (count === 0 && !needle)) {
      setLoaded(null);
      setFailed(false);
      return;
    }
    const base = loadedRef.current?.key === key ? loadedRef.current : null;
    if (base && (base.items.length >= limit || base.next === null)) return;
    let current = true;
    setFailed(false);
    void (async () => {
      let items = base?.items ?? [];
      let total = base?.total ?? 0;
      let next: ArchivedConversationsCursor | null | undefined = base ? base.next : undefined;
      while (next !== null && items.length < limit) {
        const page = await load({
          ...(needle ? { query: needle, providerIds } : {}),
          after: next ?? null,
          limit: Math.min(ARCHIVED_CHATS_PAGE_SIZE, limit - items.length),
        });
        if (!current) return;
        const known = new Set(items.map(({ id }) => id));
        items = [...items, ...page.conversations.filter(({ id }) => !known.has(id))];
        total = page.total;
        next = page.next;
      }
      if (!base) setRestored(new Set());
      setLoaded({ key, needle, items, total, next: next ?? null });
    })().catch(() => {
      if (current) setFailed(true);
    });
    return () => { current = false; };
  }, [attempt, count, key, limit, load, needle, providerIds]);

  const matching = loaded?.needle === needle ? loaded : null;
  const shown = useMemo(() => (matching?.items ?? [])
    .filter(({ id }) => !restored.has(id))
    .slice(0, limit), [matching, limit, restored]);
  const hidden = (matching?.items ?? []).filter(({ id }) => restored.has(id)).length;
  const total = matching ? Math.max(0, matching.total - hidden) : needle ? 0 : count;
  const hasArchived = needle ? true : total > 0;
  const remaining = Math.max(0, total - shown.length);

  useLayoutEffect(() => {
    const index = firstNewRow.current;
    if (index === null || shown.length <= index) return;
    firstNewRow.current = null;
    list.current?.querySelectorAll<HTMLButtonElement>("button")[index]?.focus();
  }, [shown]);
  useLayoutEffect(() => {
    const pending = restoring.current;
    if (!pending || shown.some((chat) => chat.id === pending.id)) return;
    restoring.current = null;
    if (document.activeElement !== document.body) return;
    const rows = list.current?.querySelectorAll<HTMLButtonElement>("button");
    (rows?.[Math.min(pending.index, rows.length - 1)] ?? filter.current ?? empty.current)?.focus();
  }, [shown]);

  const resetQuery = useCallback((value: string) => {
    setQuery(value);
    setLimit(ARCHIVED_CHATS_PAGE_SIZE);
  }, []);
  const pending = Boolean(load) && hasArchived && !failed && (!matching || matching.key !== key) && shown.length === 0;

  return (
    <SettingsGroup title="Archived chats" headingId="archive-heading">
      <div className="archived-chats" data-setting-id="archived-threads">
        {(hasArchived || query) && (
          <input
            ref={filter}
            className="setting-input archived-chats-filter"
            type="search"
            aria-label="Filter archived chats"
            placeholder="Filter archived chats"
            value={query}
            onChange={(event) => resetQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || !query || event.nativeEvent.isComposing) return;
              event.preventDefault();
              resetQuery("");
            }}
          />
        )}
        {failed ? (
          <p className="archived-chats-empty" role="alert">
            {`${ARCHIVED_CHATS_LOAD_FAILED} `}
            <button type="button" className="secondary-button" onClick={() => setAttempt((value) => value + 1)}>Retry</button>
          </p>
        ) : !hasArchived && !query
          ? <p ref={empty} className="archived-chats-empty" tabIndex={-1}>No archived chats.</p>
          : pending
            ? <p className="archived-chats-empty" role="status">Loading archived chats…</p>
            : shown.length === 0
              ? <p ref={empty} className="archived-chats-empty" tabIndex={-1}>{needle ? "No archived chats match this filter." : "No archived chats."}</p>
              : (
                <ul ref={list} className="archive-list" aria-label="Archived chats">
                  {shown.map((chat, index) => (
                    <li className="archive-row" key={chat.id}>
                      <span className="setting-copy">
                        <strong title={chat.title}>{chat.title}</strong>
                        <small>{providerLabels.get(chat.providerId) ?? chat.providerId}</small>
                      </span>
                      <button type="button" className="secondary-button" aria-label={`Restore ${chat.title}`} disabled={disabled} onClick={() => {
                        restoring.current = { id: chat.id, index };
                        setRestored((current) => new Set([...current, chat.id]));
                        void Promise.resolve(onUnarchive(chat)).catch(() => {
                          if (!mounted.current) return;
                          if (restoring.current?.id === chat.id) restoring.current = null;
                          setRestored((current) => {
                            if (!current.has(chat.id)) return current;
                            const next = new Set(current);
                            next.delete(chat.id);
                            return next;
                          });
                        });
                      }}>
                        <ArchiveRestore size={14} aria-hidden="true" />Restore
                      </button>
                    </li>
                  ))}
                </ul>
              )}
        {!failed && shown.length > 0 && (
          <div className="archived-chats-footer">
            <small aria-live="polite">{`Showing ${shown.length} of ${total}`}</small>
            {remaining > 0 && (
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  firstNewRow.current = shown.length;
                  setLimit((current) => current + ARCHIVED_CHATS_PAGE_SIZE);
                }}
              >
                {`Show ${Math.min(remaining, ARCHIVED_CHATS_PAGE_SIZE)} more`}
              </button>
            )}
          </div>
        )}
      </div>
    </SettingsGroup>
  );
}
