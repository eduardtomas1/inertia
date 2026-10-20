import type { Conversation } from "@shared/contracts";
import type { WatcherLinkView } from "@shared/watcher";
import { MAX_ACTIVE_WATCHERS } from "../../utils/watcherLinks";
import type { WatcherSurfaceModel } from "./watcherContext";

export type WatcherEntry =
  | { kind: "attach" }
  | { kind: "show"; link: WatcherLinkView }
  /** `link` is set when the chat has a watcher this window can't show. */
  | { kind: "unavailable"; reason: string; link?: WatcherLinkView };

/**
 * What a chat's watcher entry point offers (thread actions, command palette).
 * It imports no schema values, so the actions menu stays free of zod.
 */
export function watcherEntryFor(
  surface: WatcherSurfaceModel,
  conversation: Pick<Conversation, "id" | "projectId" | "archivedAt">,
): WatcherEntry {
  const existing = surface.links.byWatched.get(conversation.id);
  if (existing) {
    return surface.detachedConversationIds.has(conversation.id)
      ? { kind: "unavailable", reason: "Return this chat to the main window to see its watcher.", link: existing }
      : { kind: "show", link: existing };
  }
  if (surface.links.byWatcher.has(conversation.id)) {
    return { kind: "unavailable", reason: "A watcher can't watch another watcher." };
  }
  if (conversation.archivedAt !== null) {
    return { kind: "unavailable", reason: "Archived chats can't be watched." };
  }
  const project = surface.projects.find(({ id }) => id === conversation.projectId);
  if (!project || project.workspaceKind === "scratch") {
    return { kind: "unavailable", reason: "Chats without a project can't be watched." };
  }
  if (surface.links.activeCount >= MAX_ACTIVE_WATCHERS) {
    return {
      kind: "unavailable",
      reason: `Inertia already has ${MAX_ACTIVE_WATCHERS} active watchers. Stop one first.`,
    };
  }
  if (!surface.online) {
    return { kind: "unavailable", reason: "Available when the local service is connected." };
  }
  return { kind: "attach" };
}
