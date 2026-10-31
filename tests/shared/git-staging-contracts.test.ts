import { describe, expect, it } from "vitest";

import { clientCommandSchema, type AppSnapshot, type ClientCommand } from "../../src/shared/contracts";
import { RUNTIME_COMMAND_TYPES } from "../../src/server/runtime/commands/command-router";
import { detachedChatCommandRejection } from "../../src/server/runtime/detached-chat-runtime-policy";
import {
  publishesWorkspaceGitCompletion,
  runtimeCommandPolicy,
} from "../../src/renderer/src/utils/runtimeCommandPolicy";

const requestId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const authorityRef = "44444444-4444-4444-8444-444444444444";
const types = ["git.stage", "git.unstage"] as const;

function command(type: (typeof types)[number], payload: Record<string, unknown>) {
  return { type, requestId, payload: { projectId, conversationId, ...payload } };
}

describe("git.stage / git.unstage contracts", () => {
  it("accepts a scoped, bounded path selection with paired authority", () => {
    for (const type of types) {
      for (const repositoryPath of [".", "modules/alpha"]) {
        const parsed = command(type, {
          repositoryPath,
          authorityRef,
          paths: ["README.md", "src/new file.ts", "docs/*.md"],
        });
        expect(clientCommandSchema.parse(parsed)).toMatchObject(parsed);
      }
      const maximum = command(type, {
        repositoryPath: ".",
        authorityRef,
        paths: Array.from({ length: 200 }, (_, index) => `file-${index}.txt`),
      });
      expect(clientCommandSchema.safeParse(maximum).success).toBe(true);
    }
  });

  it("rejects empty, oversized, traversing, absolute and magic path selections", () => {
    for (const type of types) {
      for (const paths of [
        [],
        Array.from({ length: 201 }, (_, index) => `file-${index}.txt`),
        ["../outside.txt"],
        ["src/../../outside.txt"],
        ["./README.md"],
        ["/etc/passwd"],
        ["C:/Windows/win.ini"],
        ["src\\..\\..\\outside.txt"],
        [":(glob)**"],
        ["line\nbreak"],
        [""],
        ["a".repeat(4097)],
      ]) {
        expect(
          clientCommandSchema.safeParse(command(type, { repositoryPath: ".", authorityRef, paths })).success,
          JSON.stringify(paths).slice(0, 80),
        ).toBe(false);
      }
    }
  });

  it("requires a repository path and its authority together and rejects unknown keys", () => {
    for (const type of types) {
      expect(clientCommandSchema.safeParse(command(type, { repositoryPath: ".", paths: ["a"] })).success).toBe(false);
      expect(clientCommandSchema.safeParse(command(type, { authorityRef, paths: ["a"] })).success).toBe(false);
      expect(clientCommandSchema.safeParse(command(type, {
        repositoryPath: ".",
        authorityRef,
        paths: ["a"],
        force: true,
      })).success).toBe(false);
    }
  });

  it("registers runtime ownership, renderer mutation policy and completion publication", () => {
    for (const type of types) {
      expect(RUNTIME_COMMAND_TYPES).toContain(type);
      expect(runtimeCommandPolicy(type)).toEqual(runtimeCommandPolicy("git.commit"));
      expect(runtimeCommandPolicy(type).timeoutDelivery).toBe("ambiguous");
      expect(publishesWorkspaceGitCompletion(type)).toBe(true);
    }
  });

  it("is available in a detached chat only for its own workspace", () => {
    const resources = {
      snapshot: () => ({
        conversations: [{ id: conversationId, projectId }],
        runs: [],
      }) as unknown as AppSnapshot,
      subagentConversationId: () => null,
      checkpointConversationId: () => null,
      turnConversationId: () => null,
      duoLaunchConversationIds: () => null,
      pendingApproval: () => null,
      pendingInput: () => null,
    };
    for (const type of types) {
      const parsed = clientCommandSchema.parse(
        command(type, { repositoryPath: ".", authorityRef, paths: ["README.md"] }),
      ) as ClientCommand;
      const detached = { kind: "detached-chat", conversationId, clientId: "window-1" } as const;
      expect(detachedChatCommandRejection(detached, parsed, resources)).toBeNull();
      expect(detachedChatCommandRejection({ kind: "main" }, parsed, resources)).toBeNull();
      const foreign = clientCommandSchema.parse(command(type, {
        conversationId: "55555555-5555-4555-8555-555555555555",
        repositoryPath: ".",
        authorityRef,
        paths: ["README.md"],
      })) as ClientCommand;
      expect(detachedChatCommandRejection(detached, foreign, resources))
        .toBe("That request is unavailable in a detached chat.");
    }
  });
});
