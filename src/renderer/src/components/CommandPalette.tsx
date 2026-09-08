import { Folder, FolderPlus, MessageSquare, Search, Settings, SquarePen, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Conversation, Project } from "@shared/contracts";
import { MESSAGE_SEARCH_QUERY_MAX, messageSearchPattern, type MessageSearchHit } from "@shared/message-search";
import { useMessageSearch, type MessageSearchCommand } from "../hooks/useMessageSearch";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { captureModalFocus, trapModalFocus } from "../utils/modalFocus";
import { IconButton } from "./ui";

type CommandPaletteProps = {
  open: boolean;
  projects: Project[];
  conversations: Conversation[];
  newThreadShortcut: string;
  onClose: () => void;
  onSelectProject: (project: Project) => void;
  onSelectConversation: (conversation: Conversation) => void;
  sendCommand?: MessageSearchCommand;
  onSelectMessage?: (hit: MessageSearchHit, signal?: AbortSignal) => Promise<boolean>;
  onNewThread: () => void;
  onAddProject: () => void;
  onOpenSettings: () => void;
};

type PaletteItem = {
  id: string;
  group: "Actions" | "Projects" | "Threads" | "Messages";
  label: string;
  detail?: string;
  icon: React.JSX.Element;
  shortcut?: string;
  match?: MessageSearchHit;
  run?: () => void;
};

function score(label: string, detail: string | undefined, query: string): number {
  const target = `${label} ${detail ?? ""}`.toLocaleLowerCase();
  if (!query) return 1;
  if (label.toLocaleLowerCase().startsWith(query)) return 4;
  if (target.split(/\s+/u).some((word) => word.startsWith(query))) return 3;
  return target.includes(query) ? 2 : 0;
}

const groupOrder = ["Actions", "Projects", "Threads", "Messages"] as const;

function filterItems(items: PaletteItem[], query: string): PaletteItem[] {
  const needle = query.trim().toLocaleLowerCase();
  return items
    .map((item) => ({ item, rank: score(item.label, item.detail, needle) }))
    .filter(({ rank }) => rank > 0)
    .sort((left, right) => right.rank - left.rank)
    .slice(0, needle ? 18 : 14)
    .map(({ item }) => item)
    .sort((left, right) => groupOrder.indexOf(left.group) - groupOrder.indexOf(right.group));
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return text;
  const pattern = new RegExp(messageSearchPattern(query.trim()), "giu");
  let offset = 0;
  const parts: React.ReactNode[] = [];
  for (const match of text.matchAll(pattern)) {
    parts.push(text.slice(offset, match.index), <mark key={match.index}>{match[0]}</mark>);
    offset = match.index + match[0].length;
  }
  return <>{parts}{text.slice(offset)}</>;
}

export function CommandPalette({ open, projects, conversations, newThreadShortcut, onClose, onSelectProject, onSelectConversation, sendCommand, onSelectMessage, onNewThread, onAddProject, onOpenSettings }: CommandPaletteProps): React.JSX.Element | null {
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [openError, setOpenError] = useState(false);
  const opening = useRef<AbortController | null>(null);
  const restorePriorFocus = useRef(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const search = useMessageSearch(open, query, sendCommand);
  useNativePreviewSuspension(open);

  useLayoutEffect(() => {
    if (!open) return;
    restorePriorFocus.current = true;
    const restoreFocus = captureModalFocus(false);
    searchRef.current?.focus();
    return () => {
      opening.current?.abort();
      if (restorePriorFocus.current) restoreFocus();
    };
  }, [open]);

  const allItems = useMemo(() => {
    const actions: PaletteItem[] = [
      ...(projects.length > 0
        ? [{ id: "action:new-thread", group: "Actions" as const, label: "New chat", detail: "Start work in the current project", icon: <SquarePen size={15} />, shortcut: newThreadShortcut, run: onNewThread }]
        : []),
      { id: "action:add-project", group: "Actions", label: "Add project", detail: "Choose a local folder", icon: <FolderPlus size={15} />, run: onAddProject },
      { id: "action:settings", group: "Actions", label: "Open settings", detail: "Appearance, providers, and defaults", icon: <Settings size={15} />, run: onOpenSettings },
    ];
    const projectItems: PaletteItem[] = projects.map((project) => ({ id: `project:${project.id}`, group: "Projects", label: project.name, detail: project.path, icon: <Folder size={15} />, run: () => onSelectProject(project) }));
    const projectNames = new Map(projects.map((project) => [project.id, project.name]));
    const threadItems: PaletteItem[] = conversations.filter(({ archivedAt }) => archivedAt === null).map((thread) => ({ id: `thread:${thread.id}`, group: "Threads", label: thread.title, detail: projectNames.get(thread.projectId) ?? "Thread", icon: <MessageSquare size={15} />, run: () => onSelectConversation(thread) }));
    return [...actions, ...projectItems, ...threadItems];
  }, [conversations, newThreadShortcut, onAddProject, onNewThread, onOpenSettings, onSelectConversation, onSelectProject, projects]);
  const messageItems = useMemo<PaletteItem[]>(() => {
    if (!onSelectMessage) return [];
    return (search.result?.hits ?? []).flatMap((hit) => {
      const conversation = conversations.find(({ id, projectId, archivedAt }) => id === hit.conversationId && projectId === hit.projectId && archivedAt === null);
      const project = projects.find(({ id }) => id === hit.projectId);
      if (!conversation || !project) return [];
      return [{ id: `message:${hit.messageId}`, group: "Messages" as const, label: conversation.title,
        detail: `${project.name} · ${hit.role === "user" ? "Your message" : "Agent answer"}`,
        icon: <MessageSquare size={15} />, match: hit }];
    });
  }, [search.result, conversations, projects, onSelectMessage]);
  const items = useMemo(() => [...filterItems(allItems, query), ...messageItems], [allItems, query, messageItems]);
  const activeIndex = Math.max(0, items.findIndex(({ id }) => id === activeId));
  const activeItemId = items[activeIndex]?.id;
  useEffect(() => {
    if (!activeItemId) return;
    document.getElementById(`palette-${activeItemId}`)?.scrollIntoView({ block: "nearest" });
  }, [activeItemId]);

  if (!open) return null;

  const closePalette = () => {
    opening.current?.abort();
    setOpenError(false);
    setQuery("");
    setActiveId(null);
    onClose();
  };
  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    if (item.match && onSelectMessage) {
      opening.current?.abort();
      const controller = new AbortController();
      opening.current = controller;
      setOpenError(false);
      void onSelectMessage(item.match, controller.signal).catch(() => false).then((selected) => {
        if (controller.signal.aborted || opening.current !== controller) return;
        if (selected) {
          // The accepted result owns focus, including a row still mounting.
          // Restoring the old control would cancel that pending handoff.
          restorePriorFocus.current = false;
          closePalette();
        }
        else {
          setOpenError(true);
          searchRef.current?.focus();
        }
      });
      return;
    }
    closePalette();
    item.run?.();
  };
  const groups = groupOrder.map((group) => ({ group, items: items.map((item, index) => ({ item, index })).filter(({ item }) => item.group === group) })).filter(({ items: groupItems }) => groupItems.length > 0);

  return (
    <div className="palette-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closePalette(); }}>
      <section
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Search Inertia"
        onKeyDown={(event) => {
          trapModalFocus(event, event.currentTarget);
        }}
      >
        <div className="palette-search">
          <Search size={17} />
          <input
            ref={searchRef}
            value={query}
            maxLength={MESSAGE_SEARCH_QUERY_MAX}
            onChange={(event) => { opening.current?.abort(); setOpenError(false); setQuery(event.target.value); setActiveId(null); }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Escape") { event.preventDefault(); closePalette(); }
              if (event.key === "ArrowDown") { event.preventDefault(); setActiveId(items[(activeIndex + 1) % items.length]?.id ?? null); }
              if (event.key === "ArrowUp") { event.preventDefault(); setActiveId(items[(activeIndex - 1 + items.length) % items.length]?.id ?? null); }
              if (event.key === "Enter") {
                event.preventDefault();
                const currentQuery = event.currentTarget.value;
                const currentItems = currentQuery === query ? items : filterItems(allItems, currentQuery);
                run(currentItems[currentQuery === query ? activeIndex : 0]);
              }
            }}
            placeholder="Search commands, projects, chats, and messages…"
            aria-label="Search commands, projects, chats, and messages"
            aria-controls="palette-results"
            aria-activedescendant={items[activeIndex] ? `palette-${items[activeIndex].id}` : undefined}
            role="combobox"
            aria-expanded="true"
            autoComplete="off"
          />
          <IconButton label="Close search" onClick={closePalette}><X size={15} /></IconButton>
        </div>
        <div className="palette-results">
          <div id="palette-results" role="listbox" aria-label="Search results">
          {groups.map(({ group, items: groupItems }) => (
            <div className="palette-group" role="group" aria-label={group} key={group}>
              <span>{group}</span>
              {groupItems.map(({ item, index }) => (
                <button type="button" tabIndex={-1} id={`palette-${item.id}`} role="option" aria-selected={activeIndex === index} className={activeIndex === index ? "is-active" : undefined} key={item.id} onPointerMove={() => setActiveId(item.id)} onClick={() => run(item)}>
                  {item.icon}<span><strong><Highlight text={item.label} query={query} /></strong>{item.detail && <small>{item.detail}</small>}{item.match && <span className="palette-message-snippet"><Highlight text={item.match.snippet} query={query} /></span>}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}
                </button>
              ))}
            </div>
          ))}
          </div>
          {openError && <div className="palette-search-status" role="alert">Could not open this message. Try again.</div>}
          {search.loading && <div className="palette-search-status" role="status">Searching messages…</div>}
          {search.error && <div className="palette-search-status" role="status">{search.error} <button type="button" onClick={() => { search.retry(); searchRef.current?.focus(); }}>Retry</button></div>}
          {search.result?.incomplete && <div className="palette-search-status" role="status">Search reached its history limit. Results may be incomplete.</div>}
          {search.result?.hasMore && <div className="palette-search-status" role="status">More message matches are available. Refine your search to find them.</div>}
          {items.length === 0 && !search.loading && !search.error && !search.result?.incomplete && <div className="palette-empty"><Search size={18} /><strong>No matches</strong><span>Try a message phrase, project, chat, or command name.</span></div>}
        </div>
        <footer className="palette-footer"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>Enter</kbd> Open</span><span><kbd>Esc</kbd> Close</span></footer>
      </section>
    </div>
  );
}
