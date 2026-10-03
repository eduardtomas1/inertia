import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArchiveRestore } from "lucide-react";

import type { Conversation, ProviderInfo } from "@shared/contracts";
import { INTERFACE_LOCALE } from "../../../lib/locale";
import { SettingsGroup } from "../SettingsLayout";

export const ARCHIVED_CHATS_PAGE_SIZE = 20;

function newestFirst(left: Conversation, right: Conversation): number {
  const archived = (right.archivedAt ?? "").localeCompare(left.archivedAt ?? "", "en");
  return archived !== 0 ? archived : left.id.localeCompare(right.id, "en");
}

export function ArchivedChats({
  archived,
  providers,
  disabled,
  onUnarchive,
}: {
  archived: Conversation[];
  providers: ProviderInfo[];
  disabled: boolean;
  onUnarchive: (conversation: Conversation) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(ARCHIVED_CHATS_PAGE_SIZE);
  const firstNewRow = useRef<number | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const providerLabels = useMemo(() => new Map(providers.map((provider) => [provider.id, provider.label])), [providers]);
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(INTERFACE_LOCALE);
    return archived
      .filter((chat) => !needle
        || chat.title.toLocaleLowerCase(INTERFACE_LOCALE).includes(needle)
        || (providerLabels.get(chat.providerId) ?? chat.providerId).toLocaleLowerCase(INTERFACE_LOCALE).includes(needle))
      .sort(newestFirst);
  }, [archived, providerLabels, query]);
  const shown = matches.slice(0, limit);
  const remaining = matches.length - shown.length;
  useLayoutEffect(() => {
    const index = firstNewRow.current;
    if (index === null) return;
    firstNewRow.current = null;
    list.current?.querySelectorAll<HTMLButtonElement>("button")[index]?.focus();
  }, [limit]);
  return (
    <SettingsGroup title="Archived chats" headingId="archive-heading">
      <div className="archived-chats" data-setting-id="archived-threads">
        {archived.length > 0 && (
          <input
            className="setting-input archived-chats-filter"
            type="search"
            aria-label="Filter archived chats"
            placeholder="Filter archived chats"
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setLimit(ARCHIVED_CHATS_PAGE_SIZE);
            }}
          />
        )}
        {archived.length === 0
          ? <p className="settings-card-note">No archived chats.</p>
          : matches.length === 0
            ? <p className="settings-card-note">No archived chats match this filter.</p>
            : (
              <ul ref={list} className="archive-list" aria-label="Archived chats">
                {shown.map((chat) => (
                  <li className="archive-row" key={chat.id}>
                    <span>
                      <strong title={chat.title}>{chat.title}</strong>
                      <small>{providerLabels.get(chat.providerId) ?? chat.providerId}</small>
                    </span>
                    <button type="button" className="secondary-button" aria-label={`Restore ${chat.title}`} disabled={disabled} onClick={() => onUnarchive(chat)}>
                      <ArchiveRestore size={14} aria-hidden="true" />Restore
                    </button>
                  </li>
                ))}
              </ul>
            )}
        {matches.length > 0 && (
          <div className="archived-chats-footer">
            <small aria-live="polite">{`Showing ${shown.length} of ${matches.length}`}</small>
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
