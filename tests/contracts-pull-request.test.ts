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
        title: "Ship the hardening pass",
        body: "## Summary\n\n- bounded",
        draft: true,
      },
    } as const;
    expect(clientCommandSchema.parse(command)).toEqual(command);
    expect(clientCommandSchema.safeParse({
      ...command,
      payload: { ...command.payload, token: "must never cross" },
    }).success).toBe(false);
    expect(clientCommandSchema.safeParse({
      ...command,
      payload: { ...command.payload, body: "x".repeat(64 * 1024 + 1) },
    }).success).toBe(false);
  });
});
