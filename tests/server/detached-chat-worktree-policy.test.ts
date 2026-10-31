import { describe, expect, it } from "vitest";

import type { AppSnapshot, ClientCommand } from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts/app";
import {
  detachedChatCommandRejection,
  type DetachedChatRuntimePolicyResources,
} from "../../src/server/runtime/detached-chat-runtime-policy";
import type { RuntimeClientAuthority } from "../../src/server/runtime/runtime-client-authority";

const CONVERSATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REQUEST = "11111111-1111-4111-8111-111111111111";

const resources: DetachedChatRuntimePolicyResources = {
  snapshot: () => ({
    projects: [{ id: PROJECT, name: "Scoped", path: "/scoped" }],
    conversations: [{ id: CONVERSATION, projectId: PROJECT }],
    runs: [],
    settings: defaultSettings,
  }) as unknown as AppSnapshot,
  subagentConversationId: () => null,
  checkpointConversationId: () => null,
  turnConversationId: () => null,
  duoLaunchConversationIds: () => null,
  pendingApproval: () => null,
  pendingInput: () => null,
};

const commands: ClientCommand[] = [
  { type: "worktree.list", requestId: REQUEST, payload: { projectId: PROJECT } },
  {
    type: "worktree.remove",
    requestId: REQUEST,
    payload: { projectId: PROJECT, path: "/data/worktrees/chat" },
  },
  { type: "worktree.prune", requestId: REQUEST, payload: { projectId: PROJECT } },
];

describe("detached chat worktree policy", () => {
  it("rejects every worktree command, even for the window's own project", () => {
    const detached: RuntimeClientAuthority = {
      kind: "detached-chat",
      conversationId: CONVERSATION,
      clientId: "window-1",
    };
    for (const command of commands) {
      expect(detachedChatCommandRejection(detached, command, resources))
        .toBe("That request is unavailable in a detached chat.");
    }
  });

  it("leaves the main window authorized", () => {
    for (const command of commands) {
      expect(detachedChatCommandRejection({ kind: "main" }, command, resources)).toBeNull();
    }
  });
});
