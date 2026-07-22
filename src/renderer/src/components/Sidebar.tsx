import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  MessageSquare,
  MoreHorizontal,
  Archive,
  Pencil,
  Plus,
  Search,
  Settings,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import clsx from "clsx";
import type { AppSnapshot, Conversation, Project } from "@shared/contracts";
import { formatRelativeTime } from "../lib/format";
import type { ConnectionStatus } from "../hooks/useInertiaConnection";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { IconButton, LoadingMark } from "./ui";

type SidebarProps = {
  snapshot: AppSnapshot | null;
  connectionStatus: ConnectionStatus;
  view: "workspace" | "settings";
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onViewChange: (view: "workspace" | "settings") => void;
  onImportProject: () => void;
  onSelectProject: (project: Project) => void;
  onSelectConversation: (conversation: Conversation) => void;
  onCreateConversation: (project: Project) => void;
  onRenameConversation: (conversation: Conversation, title: string) => void;
  onArchiveConversation: (conversation: Conversation) => void;
  onDeleteConversation: (conversation: Conversation) => void;
  onRemoveProject: (project: Project) => void;
};

export function Sidebar({
  snapshot,
  connectionStatus,
  view,
  open,
  busy,
  onClose,
  onViewChange,
  onImportProject,
  onSelectProject,
  onSelectConversation,
  onCreateConversation,
  onRenameConversation,
  onArchiveConversation,
  onDeleteConversation,
  onRemoveProject,
}: SidebarProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const mobile = useMediaQuery("(max-width: 760px)");
  const [conversationMenu, setConversationMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [projectMenu, setProjectMenu] = useState<string | null>(null);
  const compact = snapshot?.settings.compactSidebar ?? false;

  useEffect(() => {
    if (!snapshot?.activeProjectId) return;
    setExpanded((current) => {
      if (current.has(snapshot.activeProjectId as string)) return current;
      const next = new Set(current);
      next.add(snapshot.activeProjectId as string);
      return next;
    });
  }, [snapshot?.activeProjectId]);

  const visibleProjects = useMemo(() => {
    const projects = snapshot?.projects ?? [];
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return projects;

    return projects.filter((project) => {
      const conversations = snapshot?.conversations.filter((item) => item.projectId === project.id) ?? [];
      return (
        project.name.toLocaleLowerCase().includes(needle) ||
        project.path.toLocaleLowerCase().includes(needle) ||
        conversations.some((conversation) => conversation.title.toLocaleLowerCase().includes(needle))
      );
    });
  }, [query, snapshot]);

  const toggleExpanded = (projectId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const navigate = (nextView: "workspace" | "settings") => {
    onViewChange(nextView);
    onClose();
  };

  return (
    <>
      <button
        type="button"
        aria-label="Close navigation"
        className={clsx("sidebar-scrim", open && "is-open")}
        onClick={onClose}
      />
      <aside
        className={clsx("sidebar", open && "is-open", compact && "is-compact")}
        aria-label="Project navigation"
        aria-hidden={mobile && !open ? true : undefined}
        inert={mobile && !open ? true : undefined}
      >
        <div className="sidebar-brand drag-region">
          <button
            type="button"
            className="brand-lockup no-drag"
            aria-label="Go to workspace"
            onClick={() => navigate("workspace")}
          >
            <img src="./inertia-logo.png" alt="" className="brand-logo" />
            <span className="brand-name">Inertia</span>
          </button>
          <IconButton label="Close navigation" className="mobile-close no-drag" onClick={onClose}>
            <X size={17} />
          </IconButton>
        </div>

        <button
          type="button"
          className="new-thread-button"
          disabled={!snapshot?.activeProjectId || connectionStatus !== "online"}
          onClick={() => {
            const activeProject = snapshot?.projects.find((project) => project.id === snapshot.activeProjectId);
            if (activeProject) onCreateConversation(activeProject);
          }}
        >
          <SquarePen size={16} />
          <span>New thread</span>
        </button>

        <button
          type="button"
          className={clsx("sidebar-destination", view === "workspace" && "is-active")}
          aria-current={view === "workspace" ? "page" : undefined}
          onClick={() => navigate("workspace")}
        >
          <MessageSquare size={16} />
          <span>Workspace</span>
        </button>

        <div className="sidebar-search-wrap">
          <Search size={15} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search projects and conversations"
            placeholder="Search projects"
            type="search"
          />
          {query && (
            <IconButton label="Clear search" className="search-clear" onClick={() => setQuery("")}>
              <X size={13} />
            </IconButton>
          )}
        </div>

        <div className="sidebar-section-title">
          <span>Projects</span>
          <IconButton
            label="Add project"
            disabled={busy || connectionStatus !== "online"}
            onClick={onImportProject}
          >
            {busy ? <LoadingMark label="Adding project" /> : <FolderPlus size={15} />}
          </IconButton>
        </div>

        <div className="project-list" role="list" aria-label="Projects">
          {!snapshot && (
            <div className="sidebar-loading">
              <LoadingMark label="Loading projects" />
              <span>Opening your workspace…</span>
            </div>
          )}

          {snapshot && visibleProjects.length === 0 && (
            <div className="sidebar-empty">
              <Folder size={19} />
              <span>{query ? "No matching projects" : "No projects yet"}</span>
            </div>
          )}

          {visibleProjects.map((project) => {
            const isExpanded = expanded.has(project.id) || Boolean(query);
            const isActive = snapshot?.activeProjectId === project.id;
            const conversations = snapshot?.conversations
              .filter((conversation) => conversation.projectId === project.id && conversation.archivedAt === null)
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) ?? [];

            return (
              <div className="project-group" role="listitem" key={project.id}>
                <div className={clsx("project-row", isActive && view === "workspace" && "is-active")}>
                  <IconButton
                    label={`${isExpanded ? "Collapse" : "Expand"} ${project.name}`}
                    className="project-expand"
                    onClick={() => toggleExpanded(project.id)}
                  >
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </IconButton>
                  <button
                    type="button"
                    className="project-select"
                    onClick={() => {
                      onSelectProject(project);
                      onViewChange("workspace");
                      onClose();
                    }}
                  >
                    <Folder className="project-icon" size={15} />
                    <span className="project-copy">
                      <span className="project-name">{project.name}</span>
                    </span>
                    <span className={clsx("project-status", `status-${project.status}`)} title={project.status} />
                  </button>
                  <IconButton label={`Project actions for ${project.name}`} className="project-menu-button" onClick={() => setProjectMenu(projectMenu === project.id ? null : project.id)}><MoreHorizontal size={14} /></IconButton>
                  {projectMenu === project.id && <div className="project-menu" role="menu"><button type="button" role="menuitem" onClick={() => { setProjectMenu(null); onRemoveProject(project); }}><Trash2 size={13} />Remove project</button></div>}
                </div>

                {isExpanded && (
                  <div className="conversation-list" aria-label={`${project.name} threads`}>
                    {conversations.map((conversation) => (
                      <div className="conversation-item" key={conversation.id}>
                        {renaming === conversation.id ? (
                          <form className="conversation-rename" onSubmit={(event) => { event.preventDefault(); if (renameDraft.trim()) onRenameConversation(conversation, renameDraft.trim()); setRenaming(null); }}>
                            <input value={renameDraft} maxLength={120} autoFocus aria-label={`Rename ${conversation.title}`} onChange={(event) => setRenameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setRenaming(null); }} />
                          </form>
                        ) : (
                          <button
                            type="button"
                            className={clsx("conversation-row", snapshot?.activeConversationId === conversation.id && view === "workspace" && "is-active")}
                            onClick={() => { onSelectConversation(conversation); onViewChange("workspace"); onClose(); }}
                          >
                            <span className={clsx("thread-status-dot", `is-${conversation.status}`)} title={conversation.status} />
                            <span className="conversation-title">{conversation.title}</span>
                            {!compact && <span className="conversation-time">{formatRelativeTime(conversation.updatedAt)}</span>}
                          </button>
                        )}
                        <IconButton label={`Thread actions for ${conversation.title}`} className="conversation-menu-button" onClick={() => setConversationMenu(conversationMenu === conversation.id ? null : conversation.id)}><MoreHorizontal size={13} /></IconButton>
                        {conversationMenu === conversation.id && (
                          <div className="conversation-menu" role="menu">
                            <button type="button" role="menuitem" onClick={() => { setRenameDraft(conversation.title); setRenaming(conversation.id); setConversationMenu(null); }}><Pencil size={13} />Rename</button>
                            <button type="button" role="menuitem" onClick={() => { setConversationMenu(null); onArchiveConversation(conversation); }}><Archive size={13} />Archive</button>
                            <button type="button" role="menuitem" className="is-danger" onClick={() => { setConversationMenu(null); onDeleteConversation(conversation); }}><Trash2 size={13} />Delete</button>
                          </div>
                        )}
                      </div>
                    ))}
                    <button
                      type="button"
                      className="new-conversation-row"
                      onClick={() => onCreateConversation(project)}
                      disabled={connectionStatus !== "online"}
                    >
                      <Plus size={13} />
                      <span>New thread</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="sidebar-footer">
          <button
            type="button"
            className={clsx("sidebar-destination", view === "settings" && "is-active")}
            aria-current={view === "settings" ? "page" : undefined}
            onClick={() => navigate("settings")}
          >
            <Settings size={16} />
            <span>Settings</span>
          </button>
        </div>
      </aside>
    </>
  );
}
