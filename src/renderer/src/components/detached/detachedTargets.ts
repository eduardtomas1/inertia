import type { DetachedChatMainTarget } from "@shared/desktop";

import type { NewConversationLocation } from "../../lib/newConversation";

export function newChatTarget(
  projectId: string,
  location: NewConversationLocation = { kind: "defaults" },
): DetachedChatMainTarget {
  switch (location.kind) {
    case "branch":
      return { kind: "new-chat", projectId, branch: location.branch };
    case "worktree":
      return {
        kind: "new-chat",
        projectId,
        ...(location.branch ? { branch: location.branch } : {}),
        worktree: "current",
      };
    case "isolated-worktree":
      return { kind: "new-chat", projectId, worktree: "isolated" };
    case "defaults":
      return { kind: "new-chat", projectId };
  }
}
