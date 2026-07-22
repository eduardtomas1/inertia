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

export function CommandPalette({ open, projects, conversations, onClose, onSelectProject, onSelectConversation, onNewThread, onAddProject, onOpenSettings }: CommandPaletteProps): React.JSX.Element | null {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setQuery(""); window.setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose, open]);
  const results = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return {
      projects: projects.filter((project) => !needle || project.name.toLocaleLowerCase().includes(needle)).slice(0, 6),
      threads: conversations.filter((thread) => thread.archivedAt === null && (!needle || thread.title.toLocaleLowerCase().includes(needle))).slice(0, 10),
    };
  }, [conversations, projects, query]);
  if (!open) return null;
  const closeThen = (action: () => void) => { onClose(); action(); };
  return (
    <div className="palette-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-search"><Search size={16} /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects, threads, or actions" aria-label="Search commands" /><IconButton label="Close command palette" onClick={onClose}><X size={15} /></IconButton></div>
        {!query && <div className="palette-actions"><button type="button" onClick={() => closeThen(onNewThread)}><SquarePen size={15} /><span>New thread</span><kbd>⌘N</kbd></button><button type="button" onClick={() => closeThen(onAddProject)}><FolderPlus size={15} /><span>Add project</span></button><button type="button" onClick={() => closeThen(onOpenSettings)}><Settings size={15} /><span>Settings</span></button></div>}
        <div className="palette-results">
          {results.projects.length > 0 && <div className="palette-group"><span>Projects</span>{results.projects.map((project) => <button type="button" key={project.id} onClick={() => closeThen(() => onSelectProject(project))}><Folder size={14} /><span>{project.name}</span></button>)}</div>}
          {results.threads.length > 0 && <div className="palette-group"><span>Threads</span>{results.threads.map((thread) => <button type="button" key={thread.id} onClick={() => closeThen(() => onSelectConversation(thread))}><MessageSquare size={14} /><span>{thread.title}</span></button>)}</div>}
          {results.projects.length === 0 && results.threads.length === 0 && <div className="palette-empty">No matches</div>}
        </div>
      </section>
    </div>
  );
}
