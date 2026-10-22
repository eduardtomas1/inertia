import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import clsx from "clsx";

import { useDialogPresence } from "../DialogPresence";
import { IconButton } from "../ui";

export const TASK_UNDO_MS = 6_000;

export interface PendingDelete {
  key: string;
  ids: readonly string[];
  label: string;
  clear: boolean;
}

export interface PendingDeletes {
  entries: readonly PendingDelete[];
  hiddenIds: ReadonlySet<string>;
  push: (entry: Omit<PendingDelete, "key">) => void;
  undo: () => PendingDelete | null;
  commitAll: () => void;
}

export function pendingDeletesText(entries: readonly PendingDelete[]): string {
  if (entries.length === 1) return entries[0]!.label;
  const count = entries.reduce((total, entry) => total + entry.ids.length, 0);
  return `Deleted ${count} task${count === 1 ? "" : "s"}`;
}

export function usePendingDeletes(commit: (entry: PendingDelete) => void): PendingDeletes {
  const [entries, setEntries] = useState<readonly PendingDelete[]>([]);
  const entriesRef = useRef(entries);
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const timer = useRef<number | null>(null);
  const sequence = useRef(0);

  const replace = useCallback((next: readonly PendingDelete[]): void => {
    entriesRef.current = next;
    setEntries(next);
  }, []);

  const stopTimer = useCallback((): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const commitAll = useCallback((): void => {
    stopTimer();
    const pending = entriesRef.current;
    if (pending.length === 0) return;
    replace([]);
    for (const entry of pending) commitRef.current(entry);
  }, [replace, stopTimer]);

  const push = useCallback((entry: Omit<PendingDelete, "key">): void => {
    sequence.current += 1;
    replace([...entriesRef.current, { ...entry, key: `delete-${sequence.current}` }]);
    stopTimer();
    timer.current = window.setTimeout(commitAll, TASK_UNDO_MS);
  }, [commitAll, replace, stopTimer]);

  const undo = useCallback((): PendingDelete | null => {
    const pending = entriesRef.current;
    const last = pending.at(-1) ?? null;
    if (!last) return null;
    const rest = pending.slice(0, -1);
    replace(rest);
    if (rest.length === 0) stopTimer();
    return last;
  }, [replace, stopTimer]);

  useEffect(() => {
    window.addEventListener("pagehide", commitAll);
    return () => {
      window.removeEventListener("pagehide", commitAll);
      commitAll();
    };
  }, [commitAll]);

  const hiddenIds = useMemo(() => new Set(entries.flatMap(({ ids }) => ids)), [entries]);
  return { entries, hiddenIds, push, undo, commitAll };
}

export interface TasksToastProps {
  entries: readonly PendingDelete[];
  onUndo: () => void;
  onDismiss: () => void;
}

export function TasksToast({ entries, onUndo, onDismiss }: TasksToastProps): React.JSX.Element | null {
  const open = entries.length > 0;
  const present = useDialogPresence(open);
  const lastText = useRef("");
  if (open) lastText.current = pendingDeletesText(entries);
  return (
    <div className="tasks-toast-region" role="status" aria-live="polite">
      {present && (
        <div
          className={clsx("tasks-toast", !open && "is-leaving")}
          aria-hidden={open ? undefined : true}
          inert={open ? undefined : true}
        >
          <span className="tasks-toast-text">{lastText.current}</span>
          <button type="button" className="tasks-toast-undo" onClick={onUndo}>Undo</button>
          <IconButton label="Dismiss" className="tasks-toast-close" onClick={onDismiss}>
            <X size={14} aria-hidden="true" />
          </IconButton>
        </div>
      )}
    </div>
  );
}
