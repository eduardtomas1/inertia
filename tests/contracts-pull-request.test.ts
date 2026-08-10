import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { clientCommandSchema } from "../src/shared/contracts";

describe("pull request command contract", () => {
  it("accepts a bounded explicit GitHub PR request and rejects extra fields", () => {
    const command = {
      type: "git.pr.create",
      requestId: randomUUID(),
      payload: {
        projectId: randomUUID(),
        repositoryPath: "modules/alpha",
        authorityRef: randomUUID(),
        title: "Ship the hardening pass",
        body: "## Summary\n\n- bounded",
        draft: true,
      },
    } as const;
    expect(clientCommandSchema.parse(command)).toEqual(command);
    expect(clientCommandSchema.safeParse({
      ...command,
      payload: { ...command.payload, authorityRef: undefined },
    }).success).toBe(false);
    expect(clientCommandSchema.safeParse({
      ...command,
      payload: { ...command.payload, repositoryPath: undefined },
    }).success).toBe(false);
    expect(clientCommandSchema.safeParse({
      ...command,
      payload: { ...command.payload, token: "must never cross" },
    }).success).toBe(false);
    expect(clientCommandSchema.safeParse({
      ...command,
      payload: { ...command.payload, body: "x".repeat(64 * 1024 + 1) },
    }).success).toBe(false);
    expect(clientCommandSchema.safeParse({
      type: "git.refresh",
      requestId: randomUUID(),
      payload: {
        projectId: command.payload.projectId,
        repositoryPath: "modules/alpha",
      },
    }).success).toBe(false);
  });

  it("requires the selected repository authority on every nested Git action", () => {
    const projectId = randomUUID();
    const repositoryPath = "modules/alpha";
    const authorityRef = randomUUID();
    const actions = [
      { type: "git.pull", payload: { projectId, repositoryPath, authorityRef } },
      {
        type: "git.commit",
        payload: {
          projectId,
          repositoryPath,
          authorityRef,
          message: "Nested change",
          paths: ["README.md"],
        },
      },
      { type: "git.push", payload: { projectId, repositoryPath, authorityRef } },
      { type: "git.pr.open", payload: { projectId, repositoryPath, authorityRef } },
      {
        type: "git.pr.create",
        payload: {
          projectId,
          repositoryPath,
          authorityRef,
          title: "Nested change",
          body: "",
          draft: true,
        },
      },
    ] as const;

    for (const action of actions) {
      const command = {
        ...action,
        requestId: randomUUID(),
      };
      expect(clientCommandSchema.safeParse(command).success).toBe(true);
      const { authorityRef: _authorityRef, ...withoutAuthority } = action.payload;
      expect(clientCommandSchema.safeParse({
        ...command,
        payload: withoutAuthority,
      }).success).toBe(false);
      const { repositoryPath: _repositoryPath, ...withoutRepository } = action.payload;
      expect(clientCommandSchema.safeParse({
        ...command,
        payload: withoutRepository,
      }).success).toBe(false);
    }
  });

  it("accepts commit paths through the canonical platform-safe boundary", () => {
    const command = (path: string) => ({
      type: "git.commit",
      requestId: randomUUID(),
      payload: {
        projectId: randomUUID(),
        message: "Commit a deeply nested path",
        paths: [path],
      },
    });

    expect(clientCommandSchema.safeParse(command("a".repeat(4_096))).success)
      .toBe(true);
    expect(clientCommandSchema.safeParse(command("a".repeat(4_097))).success)
      .toBe(false);
    expect(clientCommandSchema.safeParse(command("")).success).toBe(false);
    expect(clientCommandSchema.safeParse({
      ...command("README.md"),
      payload: {
        ...command("README.md").payload,
        paths: Array.from({ length: 501 }, () => "README.md"),
      },
    }).success).toBe(false);
  });
});
