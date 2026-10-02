import { describe, expect, it } from "vitest";

import { conversationDeletionPrompt } from "../../src/renderer/src/components/AppLayout";
import type { AppSnapshot } from "../../src/shared/contracts";

const projectId = "11111111-1111-4111-8111-111111111111";
const folder = "/data/scratch/2026-10-02-plan-a-trip-22222222-2222-4222-8222-222222222222";

function snapshot(workspaceKind?: "scratch"): AppSnapshot {
  return { projects: [{ id: projectId, ...(workspaceKind ? { workspaceKind } : {}) }] } as unknown as AppSnapshot;
}

describe("chat deletion confirmation", () => {
  it("says where a chat without a project keeps its folder", () => {
    expect(conversationDeletionPrompt({ title: "Plan a trip", projectId, worktreePath: folder }, snapshot("scratch")))
      .toBe(`Delete “Plan a trip”? This cannot be undone. Its chat folder is kept at ${folder}.`);
  });

  it("keeps the existing prompt for project chats", () => {
    expect(conversationDeletionPrompt({ title: "Fix tests", projectId, worktreePath: folder }, snapshot()))
      .toBe("Delete “Fix tests”? This cannot be undone.");
    expect(conversationDeletionPrompt({ title: "Fix tests", projectId, worktreePath: null }, null))
      .toBe("Delete “Fix tests”? This cannot be undone.");
  });
});
