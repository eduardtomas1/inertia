import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, CircleCheck, MessageSquare, Pencil, RotateCcw, Trash2 } from "lucide-react";
import clsx from "clsx";
import type {
  AppSettings,
  AppSnapshot,
  Conversation,
  ConversationShell,
  ModelSelection,
  ServerEvent,
} from "@shared/contracts";
import type { Todo, TodoPatch, TodoPriority } from "@shared/todos";

import type { ConnectionStatus } from "../hooks/useInertiaConnection";
import { useMinuteClock } from "../hooks/useMinuteClock";
import { projectNameFromPath } from "../lib/format";
import {
  buildNewConversationPayload,
  withNewConversationModelSelection,
} from "../lib/newConversation";
import { resultEvent, type CommandWithoutId } from "../lib/runtimeCommands";
import { sidebarThreadViewMap } from "../utils/sidebarModel";
import { todoDueLabel, type TodoDueLabel } from "../utils/todoDates";
import { TaskAgentPanel, type TaskHandoffRender } from "./tasks/TaskAgentPanel";
import {
  TASK_DETAIL_MENU_IDS,
  TaskDetail,
  type TaskDetailMenu,
  type TaskFocusTarget,
} from "./tasks/TaskDetail";
import { TaskHandoff, type TaskStartTarget } from "./tasks/TaskHandoff";
import {
  focusTaskNeighbour,
  focusTaskTitle,
  TASKS_DONE_MENU_ID,
  TaskList,
  taskRowMenuId,
  type TaskCompletionPhase,
  type TaskMenuAnchor,
  type TaskOpenTarget,
  type TaskRowModel,
} from "./tasks/TaskList";
import { TasksMenu, type TasksMenuItem } from "./tasks/TasksMenu";
import { TasksToast, usePendingDeletes, type PendingDelete } from "./tasks/TasksToast";
import {
  compareDoneTodos,
  compareOpenTasks,
  defaultTaskProjectId,
  isTextEntry,
  prefersReducedMotion,
  projectForFolder,
  sameTaskStatus,
  TASK_COMPLETION_COLLAPSE_MS,
  TASK_COMPLETION_HOLD_MS,
  TASK_PRIORITY_LABELS,
  taskProviderLabel,
  todoInScope,
} from "./tasks/taskModel";
import { deriveTaskStatus, tasksSummary, type TaskStatus } from "./tasks/taskStatus";
import { useDialogPresence } from "./DialogPresence";
import { LoadingMark } from "./ui";
import "./TasksView.css";

type TasksMenuName = TaskDetailMenu | "done" | `row:${string}`;

interface OpenMenu {
  name: TasksMenuName;
  anchor: TaskMenuAnchor;
  trigger: HTMLElement | null;
}

interface Completion {
  phase: TaskCompletionPhase;
  status: TaskStatus;
}

type PendingFocus = { kind: "row"; id: string } | { kind: "done-toggle" } | { kind: "add" };

export interface TasksViewProps {
  snapshot: AppSnapshot | null;
  settings: AppSettings;
  status: ConnectionStatus;
  projectScopeId: string | null;
  openTaskRequest?: { id: string; nonce: number } | null;
  focusAddRequest?: number;
  request(command: CommandWithoutId, options?: { passive?: boolean }): Promise<ServerEvent>;
  onOpenConversation(conversation: Conversation): void;
  onError(message: string): void;
}

const PRIORITY_CHOICES: readonly (TodoPriority | null)[] = ["urgent", "high", "medium", "low", null];
const EMPTY_TODOS: readonly Todo[] = [];

function withEntry<Key, Value>(map: ReadonlyMap<Key, Value>, key: Key, value: Value): Map<Key, Value> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}

function withoutEntry<Key, Value>(map: ReadonlyMap<Key, Value>, key: Key): ReadonlyMap<Key, Value> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

function sameDue(left: TodoDueLabel | null, right: TodoDueLabel | null): boolean {
  return left === right || (left !== null && right !== null
    && left.text === right.text && left.overdue === right.overdue && left.today === right.today);
}

function useStableValues<Value>(
  next: ReadonlyMap<string, Value>,
  same: (left: Value, right: Value) => boolean,
): ReadonlyMap<string, Value> {
  const previous = useRef<ReadonlyMap<string, Value>>(new Map());
  return useMemo(() => {
    const stable = new Map<string, Value>();
    for (const [id, value] of next) {
      const old = previous.current.get(id);
      stable.set(id, old !== undefined && same(old, value) ? old : value);
    }
    previous.current = stable;
    return stable;
  }, [next, same]);
}

export function TasksView({
  snapshot,
  settings,
  status,
  projectScopeId,
  openTaskRequest = null,
  focusAddRequest = 0,
  request,
  onOpenConversation,
  onError,
}: TasksViewProps): React.JSX.Element {
  const viewRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [requestedId, setRequestedId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ id: string; target: TaskFocusTarget } | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const [starting, setStarting] = useState<ReadonlyMap<string, string | null>>(new Map());
  const [optimistic, setOptimistic] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [completing, setCompleting] = useState<ReadonlyMap<string, Completion>>(new Map());
  const completionTimers = useRef(new Map<string, number[]>());
  const pendingFocus = useRef<PendingFocus | null>(null);
  const handledOpenRequest = useRef<number | null>(null);
  const handledFocusAddRequest = useRef(0);
  const deletedIds = useRef(new Set<string>());
  const liveIds = useRef<ReadonlySet<string>>(new Set());
  const nowMs = useMinuteClock(true);
  const now = useMemo(() => new Date(nowMs), [nowMs]);
  const offline = status !== "online";
  const todos = snapshot?.todos ?? EMPTY_TODOS;
  const todosLoaded = snapshot?.todos !== undefined;

  const send = useCallback((command: CommandWithoutId): void => {
    void request(command, { passive: true }).catch(() => undefined);
  }, [request]);

  const {
    entries: pendingEntries,
    hiddenIds,
    push: pushDelete,
    undo: popDelete,
    commitAll: commitDeletes,
  } = usePendingDeletes(useCallback((entry: PendingDelete) => {
    for (const id of entry.ids) deletedIds.current.add(id);
    if (entry.clear) send({ type: "todo.clearDone", payload: { ids: [...entry.ids] } });
    else for (const id of entry.ids) send({ type: "todo.delete", payload: { id } });
  }, [send]));

  const effectiveTodos = useMemo(() => todos.map((todo) => {
    const desired = optimistic.get(todo.id);
    if (desired === undefined || desired === (todo.completedAt !== null)) return todo;
    return { ...todo, completedAt: desired ? new Date().toISOString() : null };
  }), [optimistic, todos]);
  const knownTodos = useMemo(() => new Map(effectiveTodos
    .filter(({ id }) => !hiddenIds.has(id) && !deletedIds.current.has(id))
    .map((todo) => [todo.id, todo])), [effectiveTodos, hiddenIds]);
  const visibleTodos = useMemo(
    () => [...knownTodos.values()].filter((todo) => todoInScope(todo, projectScopeId)),
    [knownTodos, projectScopeId],
  );
  liveIds.current = useMemo(() => new Set(knownTodos.keys()), [knownTodos]);
  const visibleIds = useMemo(() => new Set(visibleTodos.map(({ id }) => id)), [visibleTodos]);

  const conversationsById = useMemo(
    () => new Map((snapshot?.conversations ?? []).map((conversation) => [conversation.id, conversation])),
    [snapshot?.conversations],
  );
  const linkedConversations = useMemo(() => {
    const linkedIds = new Set(todos.flatMap(({ conversationId }) => conversationId ? [conversationId] : []));
    return (snapshot?.conversations ?? []).filter(({ id }) => linkedIds.has(id));
  }, [snapshot?.conversations, todos]);
  const threadViews = useMemo(() => sidebarThreadViewMap(
    linkedConversations,
    snapshot?.activeConversationId ?? null,
    snapshot?.runs ?? [],
  ), [linkedConversations, snapshot?.activeConversationId, snapshot?.runs]);

  const derivedStatuses = useMemo(() => new Map(visibleTodos.map((todo) => {
    const shell = todo.conversationId ? conversationsById.get(todo.conversationId) ?? null : null;
    return [todo.id, deriveTaskStatus({
      todo,
      status: todo.conversationId ? threadViews.get(todo.conversationId)?.status ?? null : null,
      shell,
      now: nowMs,
      starting: starting.has(todo.id),
    })];
  })), [conversationsById, nowMs, starting, threadViews, visibleTodos]);
  const statuses = useStableValues(derivedStatuses, sameTaskStatus);
  const derivedDues = useMemo(
    () => new Map(visibleTodos.map((todo) => [todo.id, todoDueLabel(todo, now)])),
    [now, visibleTodos],
  );
  const dues = useStableValues(derivedDues, sameDue);

  const { openRows, doneRows, doneCount, summary } = useMemo(() => {
    const open: { todo: Todo; status: TaskStatus; phase: TaskCompletionPhase | null }[] = [];
    const done: Todo[] = [];
    for (const todo of visibleTodos) {
      const completion = completing.get(todo.id);
      if (completion) open.push({ todo, status: completion.status, phase: completion.phase });
      else if (todo.completedAt === null) open.push({ todo, status: statuses.get(todo.id)!, phase: null });
      else done.push(todo);
    }
    open.sort((left, right) => compareOpenTasks(left, right, now));
    done.sort(compareDoneTodos);
    const collapsing = open.filter(({ phase }) => phase === "collapsing").length;
    const row = (todo: Todo, rowStatus: TaskStatus | null, phase: TaskCompletionPhase | null): TaskRowModel => ({
      todo,
      status: rowStatus,
      due: todo.completedAt === null || phase ? dues.get(todo.id) ?? null : null,
      checked: todo.completedAt !== null,
      completing: phase,
    });
    return {
      openRows: open.map(({ todo, status: rowStatus, phase }) => row(todo, rowStatus, phase)),
      doneRows: done.map((todo) => row(todo, null, null)),
      doneCount: done.length + collapsing,
      summary: tasksSummary(
        open.filter(({ phase }) => phase !== "collapsing").map(({ status: rowStatus }) => rowStatus),
        done.length + collapsing,
      ),
    };
  }, [completing, dues, now, statuses, visibleTodos]);

  const regularProjects = useMemo(
    () => (snapshot?.projects ?? []).filter(({ workspaceKind }) => workspaceKind !== "scratch"),
    [snapshot?.projects],
  );
  const selected = selectedId ? knownTodos.get(selectedId) ?? null : null;
  const detailPresent = useDialogPresence(selected !== null);
  const detailTodo = selected ?? (detailPresent && detailId ? knownTodos.get(detailId) ?? null : null);

  useEffect(() => {
    for (const id of deletedIds.current) {
      if (!todos.some((todo) => todo.id === id)) deletedIds.current.delete(id);
    }
    const byId = new Map(todos.map((todo) => [todo.id, todo]));
    setOptimistic((current) => {
      let next = current;
      for (const [id, desired] of current) {
        const todo = byId.get(id);
        if (!todo || desired === (todo.completedAt !== null)) next = withoutEntry(next, id);
      }
      return next;
    });
    setStarting((current) => {
      let next = current;
      for (const [id, conversationId] of current) {
        const todo = byId.get(id);
        if (!todo || (conversationId !== null && todo.conversationId === conversationId)) {
          next = withoutEntry(next, id);
        }
      }
      return next;
    });
  }, [todos]);

  useEffect(() => () => {
    for (const timers of completionTimers.current.values()) timers.forEach((timer) => window.clearTimeout(timer));
  }, []);

  useEffect(() => {
    if (!selectedId || !todosLoaded || focusRequest?.id === selectedId) return;
    if (!knownTodos.has(selectedId) || (!visibleIds.has(selectedId) && selectedId !== requestedId)) {
      setSelectedId(null);
    }
  }, [focusRequest?.id, knownTodos, requestedId, selectedId, todosLoaded, visibleIds]);

  useEffect(() => {
    if (!menu) return;
    const id = menu.name.startsWith("row:") ? menu.name.slice(4) : menu.name === "done" ? null : selectedId;
    if (menu.name === "done" ? doneCount > 0 : id !== null && knownTodos.has(id)) return;
    setMenu(null);
    if (!document.activeElement || document.activeElement === document.body) addInputRef.current?.focus();
  }, [doneCount, knownTodos, menu, selectedId]);

  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    if (target.kind === "row") {
      if (!focusTaskTitle(target.id)) addInputRef.current?.focus();
    } else if (target.kind === "done-toggle") {
      viewRef.current?.querySelector<HTMLElement>(".tasks-done-toggle")?.focus();
    } else {
      addInputRef.current?.focus();
    }
  });

  const listHidden = (): boolean => {
    const main = mainRef.current;
    return main !== null && window.getComputedStyle(main).display === "none";
  };

  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!selectedId || !view || !listHidden()) return;
    view.scrollTop = 0;
    const active = document.activeElement;
    if (active && active !== document.body && !mainRef.current?.contains(active)) return;
    view.querySelector<HTMLElement>(".task-detail:not(.is-leaving) .task-detail-close")?.focus({ preventScroll: true });
  }, [selectedId]);

  const updateTodo = useCallback(async (id: string, patch: TodoPatch): Promise<boolean> => {
    if (deletedIds.current.has(id) || !liveIds.current.has(id)) return true;
    try {
      await request({ type: "todo.update", payload: { id, patch } }, { passive: true });
      return true;
    } catch {
      return false;
    }
  }, [request]);

  const openDetail = useCallback((todo: Todo, target: TaskFocusTarget | null = null): void => {
    setSelectedId(todo.id);
    setDetailId(todo.id);
    setFocusRequest(target ? { id: todo.id, target } : null);
  }, []);

  const closeDetail = useCallback((): void => {
    const id = selectedId;
    setSelectedId(null);
    setFocusRequest(null);
    setRequestedId(null);
    if (id) pendingFocus.current = { kind: "row", id };
  }, [selectedId]);

  const focusHandled = useCallback(() => setFocusRequest(null), []);

  const createTodo = useCallback(async (title: string, handOff: boolean): Promise<boolean> => {
    const id = crypto.randomUUID();
    if (handOff) {
      setSelectedId(id);
      setDetailId(id);
      setFocusRequest({ id, target: "agent" });
    }
    const projectId = projectScopeId && (snapshot?.projects ?? []).some(({ id: known }) => known === projectScopeId)
      ? projectScopeId
      : null;
    try {
      await request({
        type: "todo.create",
        payload: { id, title, note: "", priority: null, dueDate: null, dueTime: null, projectId },
      }, { passive: true });
      return true;
    } catch {
      if (handOff) {
        setSelectedId((current) => current === id ? null : current);
        setFocusRequest((current) => current?.id === id ? null : current);
      }
      return false;
    }
  }, [projectScopeId, request, snapshot?.projects]);

  const clearCompletion = useCallback((id: string): void => {
    completionTimers.current.get(id)?.forEach((timer) => window.clearTimeout(timer));
    completionTimers.current.delete(id);
    setCompleting((current) => withoutEntry(current, id));
  }, []);

  const setDone = useCallback((todo: Todo, completed: boolean): void => {
    if (offline) return;
    const id = todo.id;
    clearCompletion(id);
    setOptimistic((current) => withEntry(current, id, completed));
    const captured = statuses.get(id);
    if (completed && captured && !prefersReducedMotion()) {
      setCompleting((current) => withEntry(current, id, { phase: "hold", status: captured }));
      completionTimers.current.set(id, [
        window.setTimeout(() => {
          setCompleting((current) => {
            const entry = current.get(id);
            return entry ? withEntry(current, id, { ...entry, phase: "collapsing" }) : current;
          });
        }, TASK_COMPLETION_HOLD_MS),
        window.setTimeout(() => clearCompletion(id), TASK_COMPLETION_HOLD_MS + TASK_COMPLETION_COLLAPSE_MS),
      ]);
    }
    void updateTodo(id, { completed }).then((saved) => {
      if (saved) return;
      clearCompletion(id);
      setOptimistic((current) => withoutEntry(current, id));
    });
  }, [clearCompletion, offline, statuses, updateTodo]);

  const toggleDone = useCallback((todo: Todo): void => {
    if (offline) return;
    if (document.activeElement?.closest(`[data-task-id="${todo.id}"]`)) focusTaskNeighbour(todo.id);
    setDone(todo, todo.completedAt === null);
  }, [offline, setDone]);

  const deleteTodo = useCallback((todo: Todo): void => {
    if (offline) return;
    focusTaskNeighbour(todo.id);
    clearCompletion(todo.id);
    pushDelete({ ids: [todo.id], label: `Deleted “${todo.title}”`, clear: false });
    if (selectedId === todo.id) {
      setSelectedId(null);
      setFocusRequest(null);
    }
  }, [clearCompletion, offline, pushDelete, selectedId]);

  const clearDone = useCallback((): void => {
    if (offline) return;
    const ids = doneRows.map(({ todo }) => todo.id);
    if (ids.length === 0) return;
    pushDelete({
      ids,
      label: `Cleared ${ids.length} done task${ids.length === 1 ? "" : "s"}`,
      clear: true,
    });
    if (selectedId && ids.includes(selectedId)) setSelectedId(null);
    pendingFocus.current = { kind: "add" };
  }, [doneRows, offline, pushDelete, selectedId]);

  const undoDelete = useCallback((): void => {
    const entry = popDelete();
    if (!entry) return;
    if (entry.clear || entry.ids.length > 1) {
      setDoneOpen(true);
      pendingFocus.current = { kind: "done-toggle" };
    } else {
      pendingFocus.current = { kind: "row", id: entry.ids[0]! };
    }
  }, [popDelete]);

  const openChat = useCallback((todo: Todo): void => {
    const chat = todo.conversationId ? conversationsById.get(todo.conversationId) : undefined;
    if (chat) onOpenConversation(chat);
  }, [conversationsById, onOpenConversation]);

  const stopTodo = useCallback((todo: Todo): void => {
    if (!todo.conversationId) return;
    void request({ type: "agent.stop", payload: { conversationId: todo.conversationId } }).catch(() => undefined);
  }, [request]);

  const startTodo = useCallback(async (
    todo: Todo,
    target: TaskStartTarget,
    selection: ModelSelection,
    replaces: string | null,
  ): Promise<void> => {
    setStarting((current) => withEntry(current, todo.id, null));
    setFocusRequest({ id: todo.id, target: "chat" });
    try {
      let project = target.kind === "project"
        ? regularProjects.find(({ id }) => id === target.projectId)
        : projectForFolder(regularProjects, target.path);
      let projectId = project?.id ?? null;
      if (!projectId && target.kind === "folder") {
        const created = resultEvent(await request({
          type: "project.create",
          payload: { name: projectNameFromPath(target.path), path: target.path },
        })).result;
        if (created.kind !== "project.created") {
          throw new Error("The local service returned an unexpected project response.");
        }
        projectId = created.projectId;
        project = undefined;
      }
      if (!projectId) throw new Error("Choose a project for this task first.");
      const { title: _title, ...conversation } = withNewConversationModelSelection(
        buildNewConversationPayload(project ?? projectId, settings),
        selection,
      );
      const started = resultEvent(await request({
        type: "todo.start",
        payload: replaces ? { id: todo.id, conversation, replaces } : { id: todo.id, conversation },
      })).result;
      if (started.kind !== "todo.started") {
        throw new Error("The local service returned an unexpected task response.");
      }
      setStarting((current) => current.has(todo.id) ? withEntry(current, todo.id, started.conversationId) : current);
    } catch (error) {
      setStarting((current) => withoutEntry(current, todo.id));
      setFocusRequest((current) => current?.id === todo.id && current.target === "chat" ? null : current);
      throw error;
    }
  }, [regularProjects, request, settings]);

  const openMenu = useCallback((
    name: TasksMenuName,
    anchor: TaskMenuAnchor,
    trigger: HTMLElement | null,
    toggle = false,
  ): void => {
    setMenu((current) => current?.name === name && toggle ? null : { name, anchor, trigger });
  }, []);
  const dismissMenu = useCallback(() => setMenu(null), []);

  const live = useRef({ toggleDone, deleteTodo, openDetail, openMenu, selectedId, closeDetail });
  live.current = { toggleDone, deleteTodo, openDetail, openMenu, selectedId, closeDetail };
  const rowHandlers = useMemo(() => ({
    onToggle: (todo: Todo) => live.current.toggleDone(todo),
    onDelete: (todo: Todo) => live.current.deleteTodo(todo),
    onOpen: (todo: Todo, target: TaskOpenTarget = null) => live.current.openDetail(todo, target),
    onCloseDetail: (todo: Todo) => {
      if (live.current.selectedId === todo.id) live.current.closeDetail();
    },
    onOpenMenu: (todo: Todo, anchor: TaskMenuAnchor, trigger: HTMLElement | null, toggle?: boolean) =>
      live.current.openMenu(`row:${todo.id}`, anchor, trigger, toggle),
  }), []);

  useEffect(() => {
    if (!openTaskRequest || handledOpenRequest.current === openTaskRequest.nonce) return;
    const todo = knownTodos.get(openTaskRequest.id);
    if (!todo) return;
    handledOpenRequest.current = openTaskRequest.nonce;
    if (todo.completedAt !== null) setDoneOpen(true);
    setRequestedId(todo.id);
    openDetail(todo);
    window.requestAnimationFrame(() => {
      document.querySelector(`[data-task-id="${todo.id}"]`)?.scrollIntoView?.({ block: "nearest" });
    });
  }, [knownTodos, openDetail, openTaskRequest]);

  useEffect(() => {
    if (focusAddRequest === 0 || focusAddRequest === handledFocusAddRequest.current) return;
    handledFocusAddRequest.current = focusAddRequest;
    if (listHidden()) setSelectedId(null);
    const input = addInputRef.current;
    input?.focus();
    if (!input || document.activeElement !== input) pendingFocus.current = { kind: "add" };
    const frame = window.requestAnimationFrame(() => addInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [focusAddRequest]);

  const rowMenuTodo = menu?.name.startsWith("row:") ? knownTodos.get(menu.name.slice(4)) ?? null : null;

  const doneItem = (todo: Todo, restoreFocus: boolean): TasksMenuItem => ({
    id: "done",
    label: todo.completedAt ? "Reopen" : "Mark as done",
    icon: todo.completedAt
      ? <RotateCcw size={14} aria-hidden="true" />
      : <CircleCheck size={14} aria-hidden="true" />,
    disabled: offline,
    restoreFocus,
    onSelect: () => {
      if (!restoreFocus) focusTaskNeighbour(todo.id);
      setDone(todo, todo.completedAt === null);
    },
  });
  const deleteItem = (todo: Todo): TasksMenuItem => ({
    id: "delete",
    label: "Delete",
    icon: <Trash2 size={14} aria-hidden="true" />,
    danger: true,
    disabled: offline,
    restoreFocus: false,
    onSelect: () => deleteTodo(todo),
  });
  const chatItem = (todo: Todo): TasksMenuItem => ({
    id: "chat",
    label: "Open chat",
    icon: <MessageSquare size={14} aria-hidden="true" />,
    disabled: !todo.conversationId || !conversationsById.has(todo.conversationId),
    restoreFocus: false,
    onSelect: () => openChat(todo),
  });

  const rowMenuItems = (todo: Todo): TasksMenuItem[] => [
    {
      id: "rename",
      label: "Rename",
      icon: <Pencil size={14} aria-hidden="true" />,
      disabled: offline,
      restoreFocus: false,
      onSelect: () => openDetail(todo, "title"),
    },
    ...(todo.conversationId ? [chatItem(todo)] : todo.completedAt === null ? [{
      id: "agent",
      label: "Hand to agent…",
      icon: <ArrowRight size={14} aria-hidden="true" />,
      disabled: offline,
      restoreFocus: false,
      onSelect: () => openDetail(todo, "agent"),
    }] : []),
    doneItem(todo, false),
    deleteItem(todo),
  ];
  const moreItems = (todo: Todo): TasksMenuItem[] => [
    ...(todo.conversationId ? [chatItem(todo)] : []),
    doneItem(todo, true),
    deleteItem(todo),
  ];
  const priorityItems = (todo: Todo): TasksMenuItem[] => PRIORITY_CHOICES.map((priority) => ({
    id: priority ?? "none",
    label: priority ? TASK_PRIORITY_LABELS[priority] : "No priority",
    checked: todo.priority === priority,
    onSelect: () => {
      if (todo.priority !== priority) void updateTodo(todo.id, { priority });
    },
  }));
  const projectItems = (todo: Todo): TasksMenuItem[] => [
    ...regularProjects.map((project) => ({ id: project.id, label: project.name, value: project.id })),
    { id: "none", label: "No project", value: null },
  ].map(({ id, label, value }) => ({
    id,
    label,
    checked: todo.projectId === value,
    onSelect: () => {
      if (todo.projectId !== value) void updateTodo(todo.id, { projectId: value });
    },
  }));

  if (!snapshot) {
    return (
      <main className="tasks-view" aria-labelledby="tasks-view-heading" aria-busy="true">
        <h1 className="visually-hidden" id="tasks-view-heading">Tasks</h1>
        <LoadingMark label="Loading tasks" />
      </main>
    );
  }

  const detailShell: ConversationShell | null = detailTodo?.conversationId
    ? conversationsById.get(detailTodo.conversationId) ?? null
    : null;
  const detailStatus = detailTodo
    ? statuses.get(detailTodo.id) ?? deriveTaskStatus({
      todo: detailTodo,
      status: detailTodo.conversationId ? threadViews.get(detailTodo.conversationId)?.status ?? null : null,
      shell: detailShell,
      now: nowMs,
      starting: starting.has(detailTodo.id),
    })
    : null;
  const detailMenu = selected && menu && (menu.name === "priority" || menu.name === "project" || menu.name === "more")
    ? menu.name
    : null;

  const renderHandoff = (todo: Todo, shell: ConversationShell | null) => ({ retry, onCancel }: TaskHandoffRender) => (
    <TaskHandoff
      snapshot={snapshot}
      settings={settings}
      defaultProjectId={retry && shell
        ? defaultTaskProjectId(regularProjects, shell.projectId, null)
        : defaultTaskProjectId(regularProjects, projectScopeId, snapshot.activeProjectId, todo.projectId)}
      initialSelection={retry ? shell?.modelSelection ?? null : null}
      autoFocusStart={retry}
      disabled={offline}
      onStart={(target, selection) => startTodo(todo, target, selection, retry ? todo.conversationId : null)}
      onCancel={onCancel}
      onError={onError}
    />
  );

  const submitDetail = (todo: Todo, kind: TaskStatus["kind"]): void => {
    if (kind === "review") {
      setDone(todo, true);
      return;
    }
    viewRef.current
      ?.querySelector<HTMLButtonElement>(".task-detail:not(.is-leaving) .task-agent-form:not([hidden]) [data-task-start]")
      ?.click();
  };

  return (
    <main
      ref={viewRef}
      className="tasks-view"
      aria-labelledby="tasks-view-heading"
      onKeyDown={(event) => {
        if (event.key.toLowerCase() !== "z" || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
        if (isTextEntry(event.target) || pendingEntries.length === 0) return;
        event.preventDefault();
        undoDelete();
      }}
    >
      <div className={clsx("tasks-layout", selected && "has-detail")}>
        <section className="tasks-main" ref={mainRef}>
          <header className="tasks-heading">
            <h1 id="tasks-view-heading">Tasks</h1>
            <p>{summary}</p>
          </header>
          <TaskList
            {...rowHandlers}
            openRows={openRows}
            doneRows={doneRows}
            doneCount={doneCount}
            doneOpen={doneOpen}
            selectedId={selectedId}
            menuTodoId={rowMenuTodo?.id ?? null}
            doneMenuOpen={menu?.name === "done"}
            disabled={offline}
            addInputRef={addInputRef}
            onCreate={createTodo}
            onToggleDoneList={() => setDoneOpen((open) => !open)}
            onOpenDoneMenu={(anchor, trigger, toggle) => openMenu("done", anchor, trigger, toggle)}
          />
        </section>
        {detailTodo && detailStatus && (
          <TaskDetail
            key={detailTodo.id}
            todo={detailTodo}
            now={nowMs}
            leaving={selected === null}
            offline={offline}
            projectName={detailTodo.projectId
              ? snapshot.projects.find(({ id }) => id === detailTodo.projectId)?.name ?? null
              : null}
            focusTarget={focusRequest?.id === detailTodo.id ? focusRequest.target : null}
            openMenu={detailMenu}
            onFocusHandled={focusHandled}
            onUpdate={(patch) => updateTodo(detailTodo.id, patch)}
            onClose={closeDetail}
            onSubmit={() => submitDetail(detailTodo, detailStatus.kind)}
            onToggleMenu={(name, anchor, trigger) => openMenu(name, anchor, trigger, true)}
            agent={(
              <TaskAgentPanel
                todo={detailTodo}
                status={detailStatus}
                shell={detailShell}
                providerLabel={taskProviderLabel(detailShell, settings, snapshot.providers)}
                now={nowMs}
                offline={offline}
                startingLocally={starting.has(detailTodo.id)}
                renderHandoff={renderHandoff(detailTodo, detailShell)}
                onOpenChat={() => openChat(detailTodo)}
                onStop={() => stopTodo(detailTodo)}
                onMarkDone={() => setDone(detailTodo, true)}
                onReopen={() => setDone(detailTodo, false)}
              />
            )}
          />
        )}
      </div>
      <TasksToast entries={pendingEntries} onUndo={undoDelete} onDismiss={commitDeletes} />
      {rowMenuTodo && menu && (
        <TasksMenu
          id={taskRowMenuId(rowMenuTodo.id)}
          label={`Actions for ${rowMenuTodo.title}`}
          anchor={menu.anchor}
          trigger={menu.trigger}
          items={rowMenuItems(rowMenuTodo)}
          onDismiss={dismissMenu}
        />
      )}
      {menu?.name === "done" && (
        <TasksMenu
          id={TASKS_DONE_MENU_ID}
          label="Done actions"
          anchor={menu.anchor}
          trigger={menu.trigger}
          items={[{
            id: "clear",
            label: "Clear done",
            icon: <Trash2 size={14} aria-hidden="true" />,
            danger: true,
            disabled: offline,
            restoreFocus: false,
            onSelect: clearDone,
          }]}
          onDismiss={dismissMenu}
        />
      )}
      {selected && menu && detailMenu && (
        <TasksMenu
          id={TASK_DETAIL_MENU_IDS[detailMenu]}
          label={detailMenu === "priority" ? "Priority" : detailMenu === "project" ? "Project" : `More actions for ${selected.title}`}
          anchor={menu.anchor}
          trigger={menu.trigger}
          radio={detailMenu !== "more"}
          items={detailMenu === "priority"
            ? priorityItems(selected)
            : detailMenu === "project" ? projectItems(selected) : moreItems(selected)}
          onDismiss={dismissMenu}
        />
      )}
    </main>
  );
}
