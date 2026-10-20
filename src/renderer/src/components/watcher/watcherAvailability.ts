import type { Conversation } from "@shared/contracts";
import { MAX_ACTIVE_WATCHERS, type WatcherLinkView } from "@shared/watcher";
import type { WatcherSurfaceModel } from "./watcherContext";

export type WatcherEntry =
  | { kind: "attach" }
  | { kind: "show"; link: WatcherLinkView }
  | { kind: "unavailable"; reason: string };

/**
 * What a chat's watcher entry point offers. Used only by deferred surfaces
 * (thread actions, command palette), so it may read the shared constants.
 */
export function watcherEntryFor(
  surface: WatcherSurfaceModel,
  conversation: Pick<Conversation, "id" | "projectId" | "archivedAt">,
): WatcherEntry {
  const existing = surface.links.byWatched.get(conversation.id);
  if (existing) return { kind: "show", link: existing };
  if (surface.links.byWatcher.has(conversation.id)) {
    return { kind: "unavailable", reason: "A watcher can't watch another watcher." };
  }
  if (conversation.archivedAt !== null) {
    return { kind: "unavailable", reason: "Archived chats can't be watched." };
  }
  const project = surface.projects.get(conversation.projectId);
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
