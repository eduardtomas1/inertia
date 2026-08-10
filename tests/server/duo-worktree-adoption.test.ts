import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProviderInfo } from "../../src/shared/contracts";
import {
  modelSelectionSchema,
  nativeModelSelection,
} from "../../src/shared/model-routing";
import { RuntimeStore } from "../../src/server/database";
import { inspectProjectIdentity } from "../../src/server/project-identity";
import { ProviderTerminalResumeRegistry } from "../../src/server/provider/terminal-resume";
import {
  createConversationCommandHandler,
  type ConversationCommandDependencies,
} from "../../src/server/runtime/commands/conversation-commands";
import { DuoLaunchCoordinator } from "../../src/server/runtime/duo/duo-launch-coordinator";
import {
  TurnController,
  type TurnProviderRuntime,
} from "../../src/server/runtime/turns/turn-controller";
import { resolveNativeModelRoute } from "./model-route-fixture";

const temporaryDirectories: string[] = [];

function providerInfo(): ProviderInfo {
  return {
    id: "codex",
    canRun: true,
    models: [{
      id: "gpt-test",
      label: "GPT Test",
      isDefault: true,
      inputModalities: ["text"],
      reasoningOptions: [],
      defaultReasoningEffort: "high",
    }],
  } as unknown as ProviderInfo;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    async (directory) => await rm(directory, { recursive: true, force: true }),
  ));
});

describe("Duo worktree ownership adoption", () => {
  it("promotes an adopted receipt and requires manual worktree removal", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-duo-adoption-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    const dataDirectory = join(root, "data");
    mkdirSync(workspace);
    mkdirSync(dataDirectory);
    execFileSync("git", ["init", "-b", "main", workspace]);
    writeFileSync(join(workspace, "tracked.txt"), "tracked\n");
    execFileSync("git", ["-C", workspace, "add", "tracked.txt"]);
    execFileSync("git", [
      "-C", workspace,
      "-c", "user.name=Inertia Test",
      "-c", "user.email=inertia@example.invalid",
      "commit", "-m", "initial",
    ]);
    const store = new RuntimeStore(
      join(dataDirectory, "inertia.sqlite"),
      workspace,
      { recoverInterruptedRuns: false },
    );
    const project = store.createProject(
      "Duo ownership",
      workspace,
      await inspectProjectIdentity(workspace),
    );
    const providerRuntime = {
      resolveModelRoute: resolveNativeModelRoute,
      harnessIdFor: (input: { harnessId: string }) => input.harnessId,
      cancel: () => true,
    } as unknown as TurnProviderRuntime;
    const turns = new TurnController(
      store,
      providerRuntime,
      new Map(),
      new Map(),
      new Map(),
      {
        broadcast: () => undefined,
        broadcastSnapshot: () => undefined,
        providerInfo: () => [providerInfo()],
      },
    );
    const launches = new DuoLaunchCoordinator(
      store,
      { resolveModelRoute: resolveNativeModelRoute },
      {
        validateSelection: (value: unknown) => value,
        readiness: async () => null,
      } as never,
      turns,
      dataDirectory,
      () => [providerInfo()],
    );
    const modelSelection = modelSelectionSchema.parse(nativeModelSelection({
      providerId: "codex",
      modelId: "gpt-test",
      alias: "GPT Test",
      reasoningEffort: "high",
    }));
    const launchId = randomUUID();
    const prepared = await launches.prepare({
      launchId,
      prompt: "Create two owned worktrees.",
      sides: [
        {
          projectId: project.id,
          title: "Owned left",
          modelSelection,
          interactionMode: "plan",
          accessMode: "supervised",
          activate: false,
          useWorktree: true,
        },
        {
          projectId: project.id,
          title: "Owned right",
          modelSelection,
          interactionMode: "build",
          accessMode: "full",
          activate: false,
          useWorktree: true,
        },
      ],
    });
    const conversationId = prepared.sides[0].conversationId;
    const conversation = store.conversation(conversationId);
    const worktreePath = conversation.worktreePath;
    if (!worktreePath) throw new Error("Duo did not adopt its worktree.");
    expect(store.conversationWorktrees.get(conversationId)).toMatchObject({
      ownsWorktree: true,
      creationState: "created",
      path: worktreePath,
    });
    await launches.cancel(launchId);

    const handler = createConversationCommandHandler({
      store,
      providerTerminalResumes: new ProviderTerminalResumeRegistry(),
      rememberDeletedConversation: () => undefined,
      forgetRemoteTranscript: () => undefined,
    } as unknown as ConversationCommandDependencies);
    const deletion = {
      type: "conversation.delete",
      requestId: randomUUID(),
      payload: { conversationId },
    } as const;
    await expect(handler({} as never, deletion)).rejects.toThrow(
      /registered.*remove.*manually/iu,
    );
    expect(existsSync(worktreePath)).toBe(true);
    expect(store.conversationWorktrees.get(conversationId)).toMatchObject({
      ownsWorktree: true,
      creationState: "created",
    });

    execFileSync(
      "git",
      ["-C", workspace, "worktree", "remove", "--force", "--", worktreePath],
    );
    await expect(handler({} as never, {
      ...deletion,
      requestId: randomUUID(),
    })).resolves.toBe("mutation");
    expect(existsSync(worktreePath)).toBe(false);
    expect(store.shellSnapshot().conversations.some(
      ({ id }) => id === conversationId,
    )).toBe(false);
    store.close();
  });
});
