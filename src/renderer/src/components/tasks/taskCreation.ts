import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { AppSnapshot, Conversation, ServerEvent } from "@shared/contracts";
import type { TodoTextDraft } from "@shared/todos";

import type { CommandWithoutId } from "../../lib/runtimeCommands";

/** How long the quiet "Task created" confirmation stays, matching quota notices. */
export const TASK_CREATED_NOTICE_LIFETIME_MS = 10_000;

export interface TaskCreator {
  /**
   * Creates a task linked to the chat. `compose` receives the chat so the
   * caller can word the task from it; returning null creates nothing.
   */
  create(conversationId: string, compose: (chat: Conversation) => TodoTextDraft | null): void;
}

export interface TaskCreatedNotice {
  id: string;
  title: string;
}

/**
 * Present only in the main window, where tasks can be written. Detached chats
 * render without a provider, so surfaces that read it hide their task actions.
 */
export const TaskCreationContext = createContext<TaskCreator | null>(null);

export function useTaskCreator(): TaskCreator | null {
  return useContext(TaskCreationContext);
}

export function useTaskCreationController({
  snapshot,
  request,
  onError,
}: {
  snapshot: AppSnapshot | null;
  request(command: CommandWithoutId, options?: { passive?: boolean }): Promise<ServerEvent>;
  onError(message: string): void;
}): { creator: TaskCreator; notice: TaskCreatedNotice | null; dismissNotice(): void } {
  const [notice, setNotice] = useState<TaskCreatedNotice | null>(null);
  const latest = useRef({ snapshot, request, onError });
  latest.current = { snapshot, request, onError };

  const creator = useMemo<TaskCreator>(() => ({
    create: (conversationId, compose) => {
      const current = latest.current;
      const chat = current.snapshot?.conversations.find(({ id }) => id === conversationId);
      if (!chat) {
        current.onError("That chat is no longer available.");
        return;
      }
      const draft = compose(chat);
      if (!draft) {
        current.onError("There is no text to make a task from.");
        return;
      }
      const id = crypto.randomUUID();
      void current.request({
        type: "todo.create",
        payload: {
          id,
          title: draft.title,
          note: draft.note,
          priority: null,
          dueDate: null,
          conversationId: chat.id,
          projectId: chat.projectId,
        },
      }, { passive: true })
        .then(() => setNotice({ id, title: draft.title }))
        // The runtime action reports the failure in the error toast.
        .catch(() => undefined);
    },
  }), []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => {
      setNotice((current) => current?.id === notice.id ? null : current);
    }, TASK_CREATED_NOTICE_LIFETIME_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return { creator, notice, dismissNotice };
}
