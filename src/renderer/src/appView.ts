import type { Conversation } from "@shared/contracts";

export type AppView = "home" | "workspace" | "usage" | "tasks" | "initiatives" | "settings";

/**
 * The chat "Move chat to initiative…" acts on: only the open, unarchived
 * server chat on the workspace view, never one that is off screen (another
 * view is showing) or a draft that does not exist on the runtime yet.
 */
export function commandPaletteConversation(
  view: AppView,
  isServerConversation: boolean,
  conversation: Conversation | null,
): Conversation | null {
  return view === "workspace" && isServerConversation && conversation?.archivedAt === null
    ? conversation
    : null;
}
