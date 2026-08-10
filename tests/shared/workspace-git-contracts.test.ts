import { describe, expect, it } from "vitest";

import { clientCommandSchema } from "../../src/shared/contracts";

const requestId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const authorityRef = "44444444-4444-4444-8444-444444444444";

describe("workspace Git command contracts", () => {
  it("accepts typed refresh and repository-specific diff commands", () => {
    expect(clientCommandSchema.parse({
      type: "git.workspace.refresh",
      requestId,
      payload: { projectId, conversationId },
    })).toMatchObject({ type: "git.workspace.refresh" });

    expect(clientCommandSchema.parse({
      type: "git.workspace.diff",
      requestId,
      payload: {
        projectId,
        conversationId,
        authorityRef,
        repositoryPath: "modules/org.openbravo.client.application",
        path: "src/Main.java",
        ignoreWhitespace: true,
      },
    })).toMatchObject({
      type: "git.workspace.diff",
      payload: { repositoryPath: "modules/org.openbravo.client.application" },
    });
  });

  it("keeps branch operations scoped to the selected chat checkout", () => {
    for (const command of [
      {
        type: "git.branches",
        requestId,
        payload: { projectId, conversationId },
      },
      {
        type: "git.branch.create",
        requestId,
        payload: {
          projectId,
          conversationId,
          repositoryPath: ".",
          authorityRef,
          name: "feature/chat-checkout",
        },
      },
      {
        type: "git.branch.switch",
        requestId,
        payload: {
          projectId,
          conversationId,
          repositoryPath: ".",
          authorityRef,
          name: "main",
        },
      },
    ]) {
      expect(clientCommandSchema.parse(command)).toMatchObject(command);
    }
  });

  it("accepts paired root authority for every root Git mutation", () => {
    const scoped = { projectId, conversationId, repositoryPath: ".", authorityRef };
    for (const command of [
      { type: "git.pull", requestId, payload: scoped },
      { type: "git.push", requestId, payload: scoped },
      { type: "git.pr.open", requestId, payload: scoped },
      {
        type: "git.pr.create",
        requestId,
        payload: { ...scoped, title: "Ship", body: "", draft: true },
      },
    ]) {
      expect(clientCommandSchema.parse(command)).toMatchObject(command);
    }
  });

  it("rejects partial repository authority on root mutations", () => {
    for (const type of [
      "git.branch.create",
      "git.branch.switch",
      "git.pull",
      "git.push",
      "git.pr.open",
      "git.pr.create",
    ] as const) {
      const action = type === "git.branch.create" || type === "git.branch.switch"
        ? { name: "main" }
        : type === "git.pr.create"
            ? { title: "Ship", body: "", draft: true }
            : {};
      expect(clientCommandSchema.safeParse({
        type,
        requestId,
        payload: { projectId, conversationId, repositoryPath: ".", ...action },
      }).success).toBe(false);
      expect(clientCommandSchema.safeParse({
        type,
        requestId,
        payload: { projectId, conversationId, authorityRef, ...action },
      }).success).toBe(false);
    }
  });

  it("rejects the retired direct worktree command", () => {
    expect(clientCommandSchema.safeParse({
      type: "git.worktree.create",
      requestId,
      payload: {
        projectId,
        conversationId,
        repositoryPath: ".",
        authorityRef,
        baseBranch: "main",
        branch: "feature/worktree",
      },
    }).success).toBe(false);
  });

  it("requires repository identity for workspace diffs and allows it on read-only review questions", () => {
    expect(clientCommandSchema.safeParse({
      type: "git.workspace.diff",
      requestId,
      payload: { projectId, authorityRef },
    }).success).toBe(false);

    expect(clientCommandSchema.safeParse({
      type: "review.selection.ask",
      requestId,
      payload: {
        projectId,
        conversationId,
        repositoryPath: "modules/alpha",
        fingerprint: "a".repeat(64),
        filePath: "src/Main.java",
        hunkId: "hunk-1",
        lineIds: ["line-1"],
      },
    }).success).toBe(true);
  });
});
