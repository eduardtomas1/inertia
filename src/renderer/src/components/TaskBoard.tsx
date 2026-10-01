import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Circle, GitBranch, LayoutGrid, LoaderCircle, Pin, Plus, Search, StickyNote, X } from "lucide-react";
import type { AppSnapshot, Conversation } from "@shared/contracts";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import { TASK_BOARD_COLUMNS, canSettleBoardCard, taskBoardCards, type TaskBoardColumn } from "../utils/taskBoard";
import { useSnoozeClock } from "../hooks/useSnoozeClock";
import { ProjectIcon } from "./ProjectIcon";
import { ConversationNotes, type ConversationNotesProps } from "./ConversationNotes";
import { LoadingMark } from "./ui";
import "./TaskBoard.css";

interface TaskBoardProps {
  snapshot: AppSnapshot | null;
  online: boolean;
  projectId: string | null;
  onProjectChange: (id: string | null) => void;
  onOpen: (conversation: Conversation) => void;
  run: (key: string, command: CommandWithoutId, options?: { reportError?: boolean }) => Promise<unknown>;
  sendCommand: ConversationNotesProps["sendCommand"];
}

const PAGE_SIZE = 40;
const statusLabels = { working: "Agent working", approval: "Approval needed", input: "Answer needed", failed: "Run failed", completed: "Ready to review", idle: "Ready to start" };
const EMPTY_CONVERSATIONS: Conversation[] = [];

export function TaskBoard({ snapshot, online, projectId, onProjectChange, onOpen, run, sendCommand }: TaskBoardProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [includeSnoozed, setIncludeSnoozed] = useState(false);
  const [limits, setLimits] = useState<Partial<Record<TaskBoardColumn, number>>>({});
  const [noteId, setNoteId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [newProjectId, setNewProjectId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const root = useRef<HTMLElement>(null);
  const newTaskButton = useRef<HTMLButtonElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const closeNotesButton = useRef<HTMLButtonElement>(null);
  const wasCreating = useRef(false);
  const id = useId();
  const conversations = snapshot?.conversations ?? EMPTY_CONVERSATIONS;
  const now = useSnoozeClock(conversations);
  const cards = useMemo(() => taskBoardCards({ conversations, projects: snapshot?.projects ?? [], runs: snapshot?.runs ?? [], projectId, query, includeSnoozed, now }),
    [conversations, snapshot?.projects, snapshot?.runs, projectId, query, includeSnoozed, now]);
  const noteConversation = conversations.find((chat) => chat.id === noteId && !chat.archivedAt);
  useEffect(() => { closeNotesButton.current?.focus(); }, [noteConversation?.id]);
  useEffect(() => { setLimits({}); }, [projectId, query, includeSnoozed]);
  useEffect(() => {
    if (snapshot && projectId && !snapshot.projects.some((project) => project.id === projectId)) onProjectChange(null);
  }, [snapshot, projectId, onProjectChange]);
  useEffect(() => {
    if (creating) titleInput.current?.focus();
    else if (wasCreating.current) newTaskButton.current?.focus();
    wasCreating.current = creating;
  }, [creating]);

  const mutate = async (key: string, command: CommandWithoutId): Promise<boolean> => {
    if (pending.current || !online) return false;
    pending.current = true; setBusy(key); setError(null);
    try { await run(key, command, { reportError: false }); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "This task could not be updated."); return false; }
    finally { pending.current = false; setBusy(null); }
  };
  const closeCreate = (): void => { setCreating(false); };
  const closeNotes = (): void => {
    const previous = noteId;
    setNoteId(null);
    window.requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>(`[data-task-id="${previous}"] [data-task-notes]`)?.focus());
  };

  return <section className={`task-board${noteConversation ? " has-notes" : ""}`} ref={root} aria-label="Task board">
    <div className="task-board-main">
      <header className="task-board-heading"><div><div className="task-board-eyebrow"><LayoutGrid size={14} aria-hidden="true" />YOUR WORK</div>
        <h2>Keep the next step in sight.</h2><p>Follow your chats from the first idea to settled work.</p></div>
        <button ref={newTaskButton} type="button" className="primary-button" disabled={!online || !snapshot?.projects.length || Boolean(busy)} onClick={() => {
          setNewProjectId(projectId ?? snapshot?.activeProjectId ?? snapshot?.projects[0]?.id ?? ""); setTitle(""); setCreating(true); setError(null);
        }}><Plus size={15} aria-hidden="true" />New task</button>
      </header>
      <div className="task-board-filters">
        <label className="task-board-search"><Search size={15} aria-hidden="true" /><input aria-label="Search tasks" placeholder="Search tasks, projects, or branches…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <select aria-label="Task board project" value={projectId ?? ""} onChange={(event) => onProjectChange(event.target.value || null)}>
          <option value="">All projects</option>{snapshot?.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        <label className="task-board-snoozed"><input type="checkbox" checked={includeSnoozed} onChange={(event) => setIncludeSnoozed(event.target.checked)} />Show snoozed</label>
      </div>
      {!online && <p className="task-board-notice" role="status">Offline. Reconnect to create or update tasks.</p>}
      {error && <p className="task-board-error" role="alert">{error}</p>}
      {creating && <form className="task-board-create" aria-label="New task" onSubmit={(event) => {
        event.preventDefault();
        if (!title.trim() || !snapshot?.projects.some((project) => project.id === newProjectId)) return;
        void mutate("task.create", { type: "conversation.create", payload: { projectId: newProjectId, title: title.trim(), activate: false } })
          .then((success) => { if (success) { setQuery(""); onProjectChange(newProjectId); closeCreate(); } });
      }}>
        <label>Task title<input ref={titleInput} aria-label="Task title" maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} required disabled={Boolean(busy)} /></label>
        <label>Project<select aria-label="New task project" value={newProjectId} onChange={(event) => setNewProjectId(event.target.value)} disabled={Boolean(busy)}>{snapshot?.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <p>Create a chat to plan your work. The agent starts when you send a message.</p>
        <div><button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={closeCreate}>Cancel</button><button type="submit" className="primary-button" disabled={!online || Boolean(busy) || !title.trim()}>Create task</button></div>
      </form>}
      {!snapshot ? <LoadingMark label="Loading tasks" /> : <div className="task-board-columns">
        {TASK_BOARD_COLUMNS.map((column) => {
          const entries = cards.filter((card) => card.column === column.id);
          const limit = limits[column.id] ?? PAGE_SIZE;
          return <section className={`task-board-column is-${column.id}`} key={column.id} aria-labelledby={`${id}-${column.id}`}>
            <header><span className="task-board-column-dot" /><h3 id={`${id}-${column.id}`}>{column.label}</h3><span className="task-board-count">{entries.length}</span></header>
            <p className="task-board-column-description">{column.description}</p>
            <div className="task-board-cards">
              {entries.length === 0 && <p className="task-board-empty">{query ? "No matching tasks" : column.id === "ready" ? "Room for your next idea" : "Nothing here yet"}</p>}
              {entries.slice(0, limit).map((card) => {
                const chat = card.conversation;
                const done = card.column === "done";
                return <article className="task-board-card" key={chat.id} data-task-id={chat.id}>
                  <div className="task-board-card-project"><ProjectIcon project={card.project} size={14} /><span>{card.project.name}</span>{chat.pinnedAt && <Pin size={12} aria-label="Pinned" />}</div>
                  <button type="button" className="task-board-open" onClick={() => onOpen(chat)}>{chat.title}</button>
                  <div className={`task-board-card-status is-${card.status}`}>{done ? <Check size={12} /> : card.status === "working" ? <LoaderCircle size={12} /> : <Circle size={9} />}<span>{done ? "Settled" : statusLabels[card.status]}</span></div>
                  {chat.branch && <div className="task-board-branch"><GitBranch size={12} aria-hidden="true" /><span>{chat.branch}</span></div>}
                  {chat.snoozedUntil && Date.parse(chat.snoozedUntil) > now && <span className="task-board-snooze-label">Snoozed</span>}
                  <footer><span className="task-board-provider">{chat.providerId}</span>
                    <button type="button" data-task-notes aria-label={`Notes for ${chat.title}`} aria-pressed={noteId === chat.id} onClick={() => setNoteId(chat.id)}><StickyNote size={14} />Notes</button>
                    <button type="button" data-task-action disabled={!online || Boolean(busy) || !canSettleBoardCard(card)}
                      title={!canSettleBoardCard(card) ? "Finish or stop the active turn before settling this task." : undefined}
                      aria-label={`${done ? "Reopen" : "Settle"} ${chat.title}`} onClick={() => {
                        void mutate(`task.settle:${chat.id}`, { type: done ? "conversation.unsettle" : "conversation.settle", payload: { conversationId: chat.id } }).then((success) => {
                          if (success) window.requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>(`[data-task-id="${chat.id}"] [data-task-action]`)?.focus());
                        });
                      }}>{busy === `task.settle:${chat.id}` ? "Saving…" : done ? "Reopen" : "Settle"}</button>
                  </footer>
                </article>;
              })}
              {entries.length > limit && <button className="secondary-button" type="button" onClick={() => setLimits((current) => ({ ...current, [column.id]: limit + PAGE_SIZE }))}>Show more in {column.label} ({entries.length - limit})</button>}
            </div>
          </section>;
        })}
      </div>}
      {snapshot && cards.length === 0 && <p className="task-board-notice">{query || projectId || includeSnoozed ? "Try another search or project filter." : "Create a task or open an existing chat to get started."}</p>}
    </div>
    {noteConversation && <aside className="task-board-notes" aria-label={`Notes for ${noteConversation.title}`}>
      <button ref={closeNotesButton} type="button" className="task-board-close-notes" aria-label="Close task notes" onClick={closeNotes}><X size={16} /></button>
      <ConversationNotes conversationId={noteConversation.id} title={noteConversation.title} online={online} sendCommand={sendCommand} />
    </aside>}
  </section>;
}
