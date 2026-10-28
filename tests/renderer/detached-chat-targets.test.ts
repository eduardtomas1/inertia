import { describe, expect, it } from "vitest";

import { newChatTarget } from "../../src/renderer/src/components/detached/detachedTargets";

const projectId = "61616161-6161-4161-8161-616161616161";

describe("detached new-chat hand-off targets", () => {
  it("names the checkout the main window should start the chat in", () => {
    expect(newChatTarget(projectId)).toEqual({ kind: "new-chat", projectId });
    expect(newChatTarget(projectId, { kind: "branch", branch: "feature/panel" }))
      .toEqual({ kind: "new-chat", projectId, checkout: { kind: "branch", branch: "feature/panel" } });
    expect(newChatTarget(projectId, { kind: "worktree", branch: "feature/panel", path: "/tmp/wt" }))
      .toEqual({ kind: "new-chat", projectId, checkout: { kind: "this-worktree", branch: "feature/panel" } });
    expect(newChatTarget(projectId, { kind: "worktree", branch: null, path: "/tmp/wt" }))
      .toEqual({ kind: "new-chat", projectId, checkout: { kind: "this-worktree" } });
    expect(newChatTarget(projectId, { kind: "isolated-worktree" }))
      .toEqual({ kind: "new-chat", projectId, checkout: { kind: "isolated-worktree" } });
  });
});
