import { Folder, FolderPlus, MessageSquare, Search, Settings, SquarePen, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { Conversation, Project } from "@shared/contracts";
import { IconButton } from "./ui";

type CommandPaletteProps = {
  open: boolean;
  projects: Project[];
  conversations: Conversation[];
  onClose: () => void;
  onSelectProject: (project: Project) => void;
  onSelectConversation: (conversation: Conversation) => void;
  onNewThread: () => void;
  onAddProject: () => void;
  onOpenSettings: () => void;
};

type PaletteItem = {
  id: string;
  group: "Actions" | "Projects" | "Threads";
  label: string;
  detail?: string;
  icon: React.JSX.Element;
  shortcut?: string;
  run: () => void;
};

function score(label: string, detail: string | undefined, query: string): number {
  const target = `${label} ${detail ?? ""}`.toLocaleLowerCase();
  if (!query) return 1;
  if (label.toLocaleLowerCase().startsWith(query)) return 4;
  if (target.split(/\s+/u).some((word) => word.startsWith(query))) return 3;
  return target.includes(query) ? 2 : 0;
}

function filterItems(items: PaletteItem[], query: string): PaletteItem[] {
  const needle = query.trim().toLocaleLowerCase();
  return items
    .map((item) => ({ item, rank: score(item.label, item.detail, needle) }))
    .filter(({ rank }) => rank > 0)
    .sort((left, right) => right.rank - left.rank)
    .slice(0, needle ? 18 : 14)
    .map(({ item }) => item);
}

export function CommandPalette({ open, projects, conversations, onClose, onSelectProject, onSelectConversation, onNewThread, onAddProject, onOpenSettings }: CommandPaletteProps): React.JSX.Element | null {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const allItems = useMemo(() => {
    const actions: PaletteItem[] = [
      { id: "action:new-thread", group: "Actions", label: "New thread", detail: "Start work in the current project", icon: <SquarePen size={15} />, shortcut: "⌘N", run: onNewThread },
      { id: "action:add-project", group: "Actions", label: "Add project", detail: "Choose a local folder", icon: <FolderPlus size={15} />, run: onAddProject },
      { id: "action:settings", group: "Actions", label: "Open settings", detail: "Appearance, providers, and defaults", icon: <Settings size={15} />, run: onOpenSettings },
    ];
    const projectItems: PaletteItem[] = projects.map((project) => ({ id: `project:${project.id}`, group: "Projects", label: project.name, detail: project.path, icon: <Folder size={15} />, run: () => onSelectProject(project) }));
    const projectNames = new Map(projects.map((project) => [project.id, project.name]));
    const threadItems: PaletteItem[] = conversations.filter(({ archivedAt }) => archivedAt === null).map((thread) => ({ id: `thread:${thread.id}`, group: "Threads", label: thread.title, detail: projectNames.get(thread.projectId) ?? "Thread", icon: <MessageSquare size={15} />, run: () => onSelectConversation(thread) }));
    return [...actions, ...projectItems, ...threadItems];
  }, [conversations, onAddProject, onNewThread, onOpenSettings, onSelectConversation, onSelectProject, projects]);
  const items = useMemo(() => filterItems(allItems, query), [allItems, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => setActiveIndex((current) => Math.min(current, Math.max(0, items.length - 1))), [items.length]);
  if (!open) return null;

  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };
  const groups = (["Actions", "Projects", "Threads"] as const).map((group) => ({ group, items: items.map((item, index) => ({ item, index })).filter(({ item }) => item.group === group) })).filter(({ items: groupItems }) => groupItems.length > 0);

  return (
    <div className="palette-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="Search Inertia">
        <div className="palette-search">
          <Search size={17} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.preventDefault(); onClose(); }
              if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((current) => items.length ? (current + 1) % items.length : 0); }
              if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((current) => items.length ? (current - 1 + items.length) % items.length : 0); }
              if (event.key === "Enter") {
                event.preventDefault();
                const currentQuery = event.currentTarget.value;
                const currentItems = filterItems(allItems, currentQuery);
                run(currentItems[currentQuery === query ? activeIndex : 0]);
              }
            }}
            placeholder="Search commands, projects, and threads…"
            aria-label="Search commands, projects, and threads"
            aria-controls="palette-results"
            aria-activedescendant={items[activeIndex] ? `palette-${items[activeIndex].id}` : undefined}
            role="combobox"
            aria-expanded="true"
            autoComplete="off"
          />
          <IconButton label="Close search" onClick={onClose}><X size={15} /></IconButton>
        </div>
        <div className="palette-results" id="palette-results" role="listbox">
          {groups.map(({ group, items: groupItems }) => (
            <div className="palette-group" key={group}>
              <span>{group}</span>
              {groupItems.map(({ item, index }) => (
                <button type="button" id={`palette-${item.id}`} role="option" aria-selected={activeIndex === index} className={activeIndex === index ? "is-active" : undefined} key={item.id} onMouseEnter={() => setActiveIndex(index)} onClick={() => run(item)}>
                  {item.icon}<span><strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}
                </button>
              ))}
            </div>
          ))}
          {items.length === 0 && <div className="palette-empty"><Search size={18} /><strong>No matches</strong><span>Try a project, thread, or command name.</span></div>}
        </div>
        <footer className="palette-footer"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>Enter</kbd> Open</span><span><kbd>Esc</kbd> Close</span></footer>
      </section>
    </div>
  );
}
