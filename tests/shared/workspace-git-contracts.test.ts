import { describe, expect, it } from "vitest";

import { clientCommandSchema } from "../../src/shared/contracts";

const requestId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";

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
        repositoryPath: "modules/org.openbravo.client.application",
        path: "src/Main.java",
        ignoreWhitespace: true,
      },
    })).toMatchObject({
      type: "git.workspace.diff",
      payload: { repositoryPath: "modules/org.openbravo.client.application" },
    });
  });

  it("requires repository identity for workspace diffs and allows it on read-only review questions", () => {
    expect(clientCommandSchema.safeParse({
      type: "git.workspace.diff",
      requestId,
      payload: { projectId },
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
