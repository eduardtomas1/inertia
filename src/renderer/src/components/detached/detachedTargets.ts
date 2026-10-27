import type { MainWindowTarget } from "../../utils/detachedHandoff";
import type { NewConversationLocation } from "../../lib/newConversation";

export function newChatTarget(
  projectId: string,
  location: NewConversationLocation = { kind: "defaults" },
): MainWindowTarget {
  switch (location.kind) {
    case "branch":
      return { kind: "new-chat", projectId, checkout: { kind: "branch", branch: location.branch } };
    case "worktree":
      return {
        kind: "new-chat",
        projectId,
        checkout: location.branch
          ? { kind: "this-worktree", branch: location.branch }
          : { kind: "this-worktree" },
      };
    case "isolated-worktree":
      return { kind: "new-chat", projectId, checkout: { kind: "isolated-worktree" } };
    case "defaults":
      return { kind: "new-chat", projectId };
  }
}
