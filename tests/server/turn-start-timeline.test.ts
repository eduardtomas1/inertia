import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

const timeline = vi.hoisted(() => [] as string[]);

vi.mock("../../src/server/git/runner", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/server/git/runner")>();
  const subcommand = (args: readonly string[]): string => {
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "-c" || args[index] === "-C") index += 1;
      else if (!args[index]!.startsWith("-")) return args[index]!;
    }
    return "";
  };
  return {
    ...original,
    runGit: (...parameters: Parameters<typeof original.runGit>) => {
      timeline.push(`git:${subcommand(parameters[1])}`);
      return original.runGit(...parameters);
    },
    runGitInspection: (...parameters: Parameters<typeof original.runGitInspection>) => {
      timeline.push(`git:${subcommand(parameters[1])}`);
      return original.runGitInspection(...parameters);
    },
  };
});

import type { ClientCommand, ServerEvent } from "../../src/shared/contracts";
import type { TurnInteractionCommandDependencies } from "../../src/server/runtime/commands/turn-interaction-commands";
import { createTurnInteractionCommandHandler } from "../../src/server/runtime/commands/turn-interaction-commands";
import { TurnGitArtifactManager } from "../../src/server/turn-git-artifacts";
import {
  cleanupTurnControllerTestDirectories,
  createTurnControllerTestRuntime,
  flushTurnControllerTestPromises,
  turnControllerTestProviderInfo,
} from "../support/turn-controller-runtime";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function initializeRepository(workspace: string): void {
  git(workspace, "init", "-b", "main");
  git(workspace, "config", "user.name", "Inertia Test");
  git(workspace, "config", "user.email", "test@inertia.local");
  writeFileSync(join(workspace, "tracked.txt"), "base\n");
  git(workspace, "add", "tracked.txt");
  git(workspace, "commit", "-m", "base");
  writeFileSync(join(workspace, "tracked.txt"), "edited\n");
}

async function fixture() {
  let artifacts: TurnGitArtifactManager | undefined;
  const events: ServerEvent[] = [];
  const runtime = await createTurnControllerTestRuntime({
    createTurnCheckpoint: (turn) => artifacts!.createTurnCheckpoint(turn),
    captureGitBefore: (input) => artifacts!.captureBefore(input),
  });
  artifacts = new TurnGitArtifactManager(runtime.store, runtime.directory);
  const record = (event: ServerEvent) => {
    events.push(event);
    timeline.push(event.type === "request.result" ? event.result.kind : event.type);
  };
  const dependencies: TurnInteractionCommandDependencies = {
    store: runtime.store,
    turns: runtime.controller,
    conversationAttachments: {} as TurnInteractionCommandDependencies["conversationAttachments"],
    backendProfileController: {
      validateSelection: (selection: unknown) => selection,
      isExternalSelection: () => false,
      readiness: async () => null,
    } as unknown as TurnInteractionCommandDependencies["backendProfileController"],
    isolatedRuns: { has: () => false } as unknown as TurnInteractionCommandDependencies["isolatedRuns"],
    workspaceRuns: {} as TurnInteractionCommandDependencies["workspaceRuns"],
    pendingApprovals: new Map(),
    pendingInputs: new Map(),
    dataDirectory: runtime.directory,
    enableProviders: true,
    attachmentResolver: null,
    generatedAttachments: { release: async () => undefined } as unknown as TurnInteractionCommandDependencies["generatedAttachments"],
    workflows: {
      resolveTurnSkills: async () => ({ inputs: [], routeKey: null }),
      assertTurnSkillsCurrent: () => undefined,
    } as unknown as TurnInteractionCommandDependencies["workflows"],
    providerTerminalResumes: {
      isActive: () => false,
      acquireWhenAvailable: async () => true,
      release: () => undefined,
    } as unknown as TurnInteractionCommandDependencies["providerTerminalResumes"],
    providerInfo: () => [turnControllerTestProviderInfo()],
    broadcast: (event) => record(event as ServerEvent),
    broadcastSnapshot: () => undefined,
    send: (_socket, event) => record(event),
  };
  dependencies.conversationAttachments = {
    retain: async (payloads: Array<{ attachment: unknown }>) => payloads.map(({ attachment }) => attachment),
    acceptRetention: () => undefined,
    releaseRetention: async () => undefined,
  } as unknown as TurnInteractionCommandDependencies["conversationAttachments"];
  const send = async (content: string) => {
    await createTurnInteractionCommandHandler(dependencies)(null as unknown as WebSocket, {
      type: "message.send",
      requestId: randomUUID(),
      payload: { conversationId: runtime.conversationId, content, attachments: [] },
    } as ClientCommand);
  };
  const providerStarted = async () => {
    await vi.waitFor(() => expect(runtime.provider.runCount).toBe(1), { timeout: 10_000 });
    timeline.push("provider.run");
  };
  return { ...runtime, events, send, providerStarted };
}

afterEach(async () => {
  timeline.splice(0);
  await cleanupTurnControllerTestDirectories();
});

describe("turn start timeline", () => {
  it("accepts and shows the message before any checkpoint Git process, then checkpoints before the provider starts", async () => {
    const f = await fixture();
    try {
      initializeRepository(f.workspace);
      timeline.splice(0);

      await f.send("Fix the loader.");
      await f.providerStarted();

      const accepted = timeline.indexOf("message.accepted");
      const firstGit = timeline.findIndex((entry) => entry.startsWith("git:"));
      const checkpointRef = timeline.lastIndexOf("git:update-ref");
      expect(accepted).toBeGreaterThanOrEqual(0);
      expect(firstGit).toBeGreaterThan(accepted);
      expect(checkpointRef).toBeGreaterThan(accepted);
      expect(timeline.indexOf("provider.run")).toBeGreaterThan(checkpointRef);

      const turn = f.store.latestAgentTurnForConversation(f.conversationId)!;
      expect(f.events).toContainEqual({
        type: "conversation.message.persisted",
        message: expect.objectContaining({
          id: turn.userMessageId,
          role: "user",
          content: "Fix the loader.",
          turnId: turn.id,
        }),
      });
      const checkpoints = f.store.conversationDetail(f.conversationId)!.checkpoints;
      expect(checkpoints).toEqual([expect.objectContaining({
        label: "Before turn 1",
        turnIndex: 1,
        turnId: turn.id,
        filesChanged: 1,
      })]);
      expect(f.store.turnGitArtifact(turn.id)).toMatchObject({
        beforeCheckpointId: checkpoints[0]!.id,
      });

      f.provider.resolve();
      await vi.waitFor(() => expect(f.store.agentTurn(turn.id).status).toBe("completed"));
      expect(f.store.agentTurn(turn.id).checkpointId).toBe(checkpoints[0]!.id);
    } finally {
      await flushTurnControllerTestPromises();
      await f.controller.dispose();
      f.store.close();
    }
  });

  it("starts a turn in a folder outside any repository without running Git", async () => {
    const f = await fixture();
    try {
      timeline.splice(0);

      await f.send("Summarize the notes.");
      await f.providerStarted();

      expect(timeline.filter((entry) => entry.startsWith("git:"))).toEqual([]);
      const turn = f.store.latestAgentTurnForConversation(f.conversationId)!;
      expect(f.store.conversationDetail(f.conversationId)!.checkpoints).toEqual([]);
      expect(f.store.turnGitArtifact(turn.id)).toMatchObject({
        status: "unavailable",
        absenceReason: "not-repository",
        failureReason: "This workspace is not a Git repository.",
      });
      expect(f.store.conversationDetail(f.conversationId)!.activities
        .filter(({ title }) => title === "No checkpoint for this turn")).toEqual([]);
      f.provider.resolve();
      await vi.waitFor(() => expect(f.store.agentTurn(turn.id).status).toBe("completed"));
    } finally {
      await flushTurnControllerTestPromises();
      await f.controller.dispose();
      f.store.close();
    }
  });
});
