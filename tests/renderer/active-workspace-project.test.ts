import { describe, expect, it } from "vitest";

import { activeWorkspaceProject } from "../../src/renderer/src/utils/activeWorkspaceProject";
import type { AppSnapshot } from "../../src/shared/contracts";

const scratch = { id: "11111111-1111-4111-8111-111111111111", name: "No project", workspaceKind: "scratch" };
const user = { id: "22222222-2222-4222-8222-222222222222", name: "Studio" };

function snapshot(activeProjectId: string | null, activeConversationId: string | null): AppSnapshot {
  return { projects: [scratch, user], activeProjectId, activeConversationId } as unknown as AppSnapshot;
}

describe("active workspace project", () => {
  it("treats the managed folder without a chat as no project selected", () => {
    expect(activeWorkspaceProject(snapshot(scratch.id, null))).toBeNull();
  });

  it("keeps the managed folder while one of its chats is open", () => {
    expect(activeWorkspaceProject(snapshot(scratch.id, "33333333-3333-4333-8333-333333333333"))?.id).toBe(scratch.id);
  });

  it("keeps an ordinary project with or without a chat", () => {
    expect(activeWorkspaceProject(snapshot(user.id, null))?.id).toBe(user.id);
    expect(activeWorkspaceProject(null)).toBeNull();
  });
});
