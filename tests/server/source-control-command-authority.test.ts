import type WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";

import { createSourceControlCommandHandler } from "../../src/server/runtime/commands/source-control-commands";
import type { SourceControlCommandDependencies } from "../../src/server/runtime/commands/source-control-commands";
import { clientCommandSchema } from "../../src/shared/contracts";

const projectId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const reviewReceipt = {
  authorityRef: "33333333-3333-4333-8333-333333333333",
  fingerprint: "a".repeat(64),
};

describe("source-control command authority", () => {
  it.each([
    ["git.branch.create", { name: "feature/scoped" }],
    ["git.branch.switch", { name: "main" }],
    ["git.pull", {}],
    ["git.commit", {
      message: "Scoped commit",
      paths: ["README.md"],
      reviewReceipt,
    }],
    ["git.push", {}],
    ["git.pr.confidence", {}],
    ["git.pr.open", {}],
  ] as const)("validates chat ownership before tracking %s", async (
    type,
    extra,
  ) => {
    const authorityError = new Error("The thread does not belong to this project.");
    const workspacePath = vi.fn(() => {
      throw authorityError;
    });
    const trackSourceControl = vi.fn(async (
      _label: string,
      _projectId: string,
      _conversationId: string | undefined,
      action: () => Promise<unknown>,
    ) => await action());
    const handler = createSourceControlCommandHandler({
      workspacePath,
      workspaceRuns: { trackSourceControl },
    } as unknown as SourceControlCommandDependencies);
    const command = clientCommandSchema.parse({
      type,
      requestId: crypto.randomUUID(),
      payload: { projectId, conversationId, ...extra },
    });

    await expect(handler({} as WebSocket, command)).rejects.toBe(
      authorityError,
    );
    expect(workspacePath).toHaveBeenCalledWith(projectId, conversationId);
    expect(trackSourceControl).not.toHaveBeenCalled();
  });

  it.each([
    ["git.branch.create", { name: "feature/scoped" }],
    ["git.branch.switch", { name: "main" }],
    ["git.pull", {}],
    ["git.push", {}],
    ["git.pr.confidence", {}],
    ["git.pr.open", {}],
    ["git.pr.create", {
      title: "Reviewed pull request",
      body: "Body",
      draft: false,
    }],
  ] as const)("requires refreshed root repository authority for %s", async (
    type,
    extra,
  ) => {
    const trackSourceControl = vi.fn();
    const handler = createSourceControlCommandHandler({
      workspacePath: vi.fn(() => "/workspace"),
      workspaceRuns: { trackSourceControl },
      store: {
        conversation: vi.fn(() => ({
          id: conversationId,
          projectId,
          worktreePath: null,
        })),
      },
    } as unknown as SourceControlCommandDependencies);
    const command = clientCommandSchema.parse({
      type,
      requestId: crypto.randomUUID(),
      payload: { projectId, ...extra },
    });

    await expect(handler({} as WebSocket, command)).rejects.toThrow(
      /refresh repository status/iu,
    );
    expect(trackSourceControl).not.toHaveBeenCalled();
  });
});
