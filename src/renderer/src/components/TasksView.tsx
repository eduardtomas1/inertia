import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, CircleCheck, Pencil, RotateCcw, Trash2 } from "lucide-react";
import clsx from "clsx";
import type {
  AppSettings,
  AppSnapshot,
  Conversation,
  ModelSelection,
  ServerEvent,
} from "@shared/contracts";
import { compareTodos, type Todo, type TodoPatch, type TodoPriority } from "@shared/todos";

import type { ConnectionStatus } from "../hooks/useInertiaConnection";
import { useDismissibleMenu } from "../hooks/useDismissibleMenu";
import { projectNameFromPath } from "../lib/format";
import {
  buildNewConversationPayload,
  withNewConversationModelSelection,
} from "../lib/newConversation";
import { resultEvent, type CommandWithoutId } from "../lib/runtimeCommands";
import { sidebarThreadViewMap } from "../utils/sidebarModel";
import { todoDuePresetDate } from "../utils/todoDates";
import { TaskDetail, type TaskDetailMenu, type TaskFocusTarget } from "./tasks/TaskDetail";
import { TaskHandoff, type TaskStartTarget } from "./tasks/TaskHandoff";
import {
  focusTaskNeighbour,
  TaskList,
  taskRowMenuId,
  type TaskMenuAnchor,
} from "./tasks/TaskList";
import { TasksMenu, type TasksMenuItem } from "./tasks/TasksMenu";
import {
  defaultTaskProjectId,
  projectForFolder,
  TASK_PRIORITY_LABELS,
  taskStatusWord,
  type TaskStatusWord,
} from "./tasks/taskModel";
import { useDialogPresence } from "./DialogPresence";
import { LoadingMark } from "./ui";
import "./TasksView.css";

type TasksMenuName = TaskDetailMenu | `row:${string}`;

export interface TasksViewProps {
  snapshot: AppSnapshot | null;
  settings: AppSettings;
  status: ConnectionStatus;
  projectScopeId: string | null;
  request(command: CommandWithoutId): Promise<ServerEvent>;
  onOpenConversation(conversation: Conversation): void;
}

const PRIORITY_CHOICES: readonly (TodoPriority | null)[] = ["urgent", "high", "medium", "low", null];

export function TasksView({
  snapshot,
  settings,
  status,
  projectScopeId,
  request,
  onOpenConversation,
}: TasksViewProps): React.JSX.Element {
  const addInputRef = useRef<HTMLInputElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ id: string; target: TaskFocusTarget } | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<TaskMenuAnchor>({ x: 8, y: 8 });
  const [pendingConversationId, setPendingConversationId] = useState<string | null>(null);
  const { menu, toggleMenu, dismissMenu, setMenuTrigger, setMenuPopover } = useDismissibleMenu<TasksMenuName>();
  const todos = snapshot?.todos;
  const now = new Date();
  const offline = status !== "online";

  const { openTodos, doneTodos } = useMemo(() => {
    const all = todos ?? [];
    return {
      openTodos: all.filter(({ completedAt }) => completedAt === null).sort(compareTodos),
      doneTodos: all.filter(({ completedAt }) => completedAt !== null).sort((left, right) => {
        const leftDone = left.completedAt ?? "";
        const rightDone = right.completedAt ?? "";
        return leftDone < rightDone ? 1 : leftDone > rightDone ? -1 : 0;
      }),
    };
  }, [todos]);
  const todoById = useMemo(() => new Map((todos ?? []).map((todo) => [todo.id, todo])), [todos]);
  const linkedConversations = useMemo(() => {
    const linkedIds = new Set((todos ?? []).flatMap(({ conversationId }) => conversationId ? [conversationId] : []));
    return (snapshot?.conversations ?? []).filter(({ id }) => linkedIds.has(id));
  }, [snapshot?.conversations, todos]);
  const threadViews = useMemo(() => sidebarThreadViewMap(
    linkedConversations,
    snapshot?.activeConversationId ?? null,
    snapshot?.runs ?? [],
  ), [linkedConversations, snapshot?.activeConversationId, snapshot?.runs]);
  const statusFor = useCallback((todo: Todo): TaskStatusWord | null => {
    const view = todo.conversationId ? threadViews.get(todo.conversationId) : undefined;
    return view ? taskStatusWord(view.status) : null;
  }, [threadViews]);
  const regularProjects = useMemo(
    () => (snapshot?.projects ?? []).filter(({ workspaceKind }) => workspaceKind !== "scratch"),
    [snapshot?.projects],
  );
  const selected = selectedId ? todoById.get(selectedId) ?? null : null;
  const detailPresent = useDialogPresence(selected !== null);
  const detailTodo = selected ?? (detailPresent && detailId ? todoById.get(detailId) ?? null : null);

  useEffect(() => {
    if (!pendingConversationId) return;
    const conversation = snapshot?.conversations.find(({ id }) => id === pendingConversationId);
    if (!conversation) return;
    setPendingConversationId(null);
    onOpenConversation(conversation);
  }, [onOpenConversation, pendingConversationId, snapshot?.conversations]);

  useEffect(() => {
    if (selectedId && todos && !todoById.has(selectedId) && focusRequest?.id !== selectedId) {
      setSelectedId(null);
    }
  }, [focusRequest?.id, selectedId, todoById, todos]);

  const send = useCallback((command: CommandWithoutId): void => {
    void request(command).catch(() => undefined);
  }, [request]);
  const updateTodo = useCallback((id: string, patch: TodoPatch): void => {
    send({ type: "todo.update", payload: { id, patch } });
  }, [send]);

  const openDetail = useCallback((todo: Todo, target: TaskFocusTarget | null = null): void => {
    setSelectedId(todo.id);
    setDetailId(todo.id);
    setFocusRequest(target ? { id: todo.id, target } : null);
  }, []);
  const closeDetail = useCallback((): void => {
    const id = selectedId;
    setSelectedId(null);
    setFocusRequest(null);
    if (id) {
      (document.querySelector<HTMLElement>(`[data-task-title="${id}"]`) ?? addInputRef.current)?.focus();
    }
  }, [selectedId]);
  const focusHandled = useCallback(() => setFocusRequest(null), []);

  const createTodo = useCallback(async (title: string, handOff: boolean): Promise<boolean> => {
    const id = crypto.randomUUID();
    if (handOff) {
      setSelectedId(id);
      setDetailId(id);
      setFocusRequest({ id, target: "agent" });
    }
    try {
      await request({ type: "todo.create", payload: { id, title, note: "", priority: null, dueDate: null } });
      return true;
    } catch {
      if (handOff) {
        setSelectedId((current) => current === id ? null : current);
        setFocusRequest((current) => current?.id === id ? null : current);
      }
      return false;
    }
  }, [request]);

  const toggleDone = useCallback((todo: Todo): void => {
    if (document.activeElement?.closest(`[data-task-id="${todo.id}"]`)) focusTaskNeighbour(todo.id);
    updateTodo(todo.id, { completed: todo.completedAt === null });
  }, [updateTodo]);

  const deleteTodo = useCallback((todo: Todo): void => {
    if (settings.confirmDestructiveActions && !window.confirm(`Delete “${todo.title}”?`)) return;
    focusTaskNeighbour(todo.id);
    if (selectedId === todo.id) setSelectedId(null);
    send({ type: "todo.delete", payload: { id: todo.id } });
  }, [selectedId, send, settings.confirmDestructiveActions]);

  const openMenu = useCallback((name: TasksMenuName, anchor: TaskMenuAnchor, toggle = false): void => {
    setMenuAnchor(anchor);
    if (toggle || menu !== name) toggleMenu(name);
  }, [menu, toggleMenu]);

  const startTodo = useCallback(async (
    todo: Todo,
    target: TaskStartTarget,
    selection: ModelSelection,
  ): Promise<void> => {
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
    if (!projectId) return;
    const { title: _title, ...conversation } = withNewConversationModelSelection(
      buildNewConversationPayload(project ?? projectId, settings),
      selection,
    );
    const started = resultEvent(await request({
      type: "todo.start",
      payload: { id: todo.id, conversation },
    })).result;
    if (started.kind !== "todo.started") {
      throw new Error("The local service returned an unexpected task response.");
    }
    setPendingConversationId(started.conversationId);
  }, [regularProjects, request, settings]);

  const rowMenuTodo = menu?.startsWith("row:") ? todoById.get(menu.slice(4)) ?? null : null;
  const rowMenuItems = (todo: Todo): TasksMenuItem[] => [
    {
      id: "rename",
      label: "Rename",
      icon: <Pencil size={14} aria-hidden="true" />,
      restoreFocus: false,
      onSelect: () => openDetail(todo, "title"),
    },
    {
      id: "agent",
      label: "Hand to agent…",
      icon: <ArrowRight size={14} aria-hidden="true" />,
      restoreFocus: false,
      onSelect: () => openDetail(todo, "agent"),
    },
    {
      id: "done",
      label: todo.completedAt ? "Reopen" : "Mark as done",
      icon: todo.completedAt
        ? <RotateCcw size={14} aria-hidden="true" />
        : <CircleCheck size={14} aria-hidden="true" />,
      restoreFocus: false,
      onSelect: () => {
        focusTaskNeighbour(todo.id);
        updateTodo(todo.id, { completed: todo.completedAt === null });
      },
    },
    {
      id: "delete",
      label: "Delete",
      icon: <Trash2 size={14} aria-hidden="true" />,
      danger: true,
      restoreFocus: false,
      onSelect: () => deleteTodo(todo),
    },
  ];
  const dueItems = (todo: Todo): TasksMenuItem[] => {
    const presets = [
      { id: "today", label: "Today", value: todoDuePresetDate("today", now) },
      { id: "tomorrow", label: "Tomorrow", value: todoDuePresetDate("tomorrow", now) },
      { id: "next-week", label: "Next week", value: todoDuePresetDate("next-week", now) },
      { id: "none", label: "No date", value: null },
    ];
    return presets.map(({ id, label, value }) => ({
      id,
      label,
      checked: todo.dueDate === value,
      onSelect: () => {
        if (todo.dueDate !== value) updateTodo(todo.id, { dueDate: value });
      },
    }));
  };
  const priorityItems = (todo: Todo): TasksMenuItem[] => PRIORITY_CHOICES.map((priority) => ({
    id: priority ?? "none",
    label: priority ? TASK_PRIORITY_LABELS[priority] : "No priority",
    marker: priority === "urgent" ? <span className="task-urgent" aria-hidden="true">!</span> : undefined,
    checked: todo.priority === priority,
    onSelect: () => {
      if (todo.priority !== priority) updateTodo(todo.id, { priority });
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

  const linkedConversation = detailTodo?.conversationId
    ? snapshot.conversations.find(({ id }) => id === detailTodo.conversationId) ?? null
    : null;

  return (
    <main className="tasks-view" aria-labelledby="tasks-view-heading">
      <div className={clsx("tasks-layout", selected && "has-detail")}>
        <section className="tasks-main">
          <header className="tasks-heading">
            <h1 id="tasks-view-heading">Tasks</h1>
            <p>{openTodos.length === 0
              ? "Add anything you need to do"
              : `${openTodos.length} to do`}</p>
          </header>
          <TaskList
            openTodos={openTodos}
            doneTodos={doneTodos}
            now={now}
            selectedId={selectedId}
            menuTodoId={rowMenuTodo?.id ?? null}
            disabled={offline}
            addInputRef={addInputRef}
            statusFor={statusFor}
            onCreate={createTodo}
            onToggle={toggleDone}
            onOpen={(todo) => openDetail(todo)}
            onOpenMenu={(todo, anchor, toggle) => openMenu(`row:${todo.id}`, anchor, toggle)}
            setMenuTrigger={(id, node) => setMenuTrigger(`row:${id}`, node)}
          />
        </section>
        {detailTodo && (
          <TaskDetail
            key={detailTodo.id}
            todo={detailTodo}
            now={now}
            leaving={selected === null}
            status={statusFor(detailTodo)}
            canOpenChat={linkedConversation !== null}
            focusTarget={focusRequest?.id === detailTodo.id ? focusRequest.target : null}
            openMenu={menu === "due" || menu === "priority" ? menu : null}
            onFocusHandled={focusHandled}
            onUpdate={(patch) => updateTodo(detailTodo.id, patch)}
            onClose={closeDetail}
            onOpenChat={() => {
              if (linkedConversation) onOpenConversation(linkedConversation);
            }}
            onToggleMenu={(name, anchor) => openMenu(name, anchor, true)}
            setMenuTrigger={setMenuTrigger}
            handoff={(
              <TaskHandoff
                snapshot={snapshot}
                settings={settings}
                defaultProjectId={defaultTaskProjectId(
                  regularProjects,
                  projectScopeId,
                  snapshot.activeProjectId,
                )}
                disabled={offline}
                onStart={(target, selection) => startTodo(detailTodo, target, selection)}
              />
            )}
          />
        )}
      </div>
      {rowMenuTodo && (
        <TasksMenu
          id={taskRowMenuId(rowMenuTodo.id)}
          label={`Actions for ${rowMenuTodo.title}`}
          anchor={menuAnchor}
          items={rowMenuItems(rowMenuTodo)}
          onDismiss={dismissMenu}
          onSetPopover={(node) => setMenuPopover(`row:${rowMenuTodo.id}`, node)}
        />
      )}
      {selected && (menu === "due" || menu === "priority") && (
        <TasksMenu
          id={menu === "due" ? "task-due-menu" : "task-priority-menu"}
          label={menu === "due" ? "Due date" : "Priority"}
          anchor={menuAnchor}
          radio
          items={menu === "due" ? dueItems(selected) : priorityItems(selected)}
          onDismiss={dismissMenu}
          onSetPopover={(node) => setMenuPopover(menu, node)}
        />
      )}
    </main>
  );
}
