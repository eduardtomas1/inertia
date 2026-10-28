import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

const ownership = vi.hoisted(() => ({
  platform: "darwin" as "darwin" | "linux" | "win32" | null,
}));
vi.mock("../../src/node/runtime-owned-processes", async (original) => ({
  ...await original<typeof import("../../src/node/runtime-owned-processes")>(),
  activeRuntimeOwnedProcessPlatform: () => ownership.platform,
}));

import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
import {
  claudeSuccessResult,
  claudeSystem,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import { fakeClaudeChild } from "../helpers/claude-harness-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

const roots: string[] = [];

beforeEach(() => { ownership.platform = "darwin"; });
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map(removePortableFixture));
});

function harnessFixture(exitsOnEof: boolean, cancelDuringTurn = false) {
  const root = portableFixtureRoot("Claude SDK natural close");
  roots.push(root);
  const events: string[] = [];
  const child = fakeClaudeChild();
  const closeChild = (): void => {
    if (child.exitCode !== null) return;
    Object.assign(child, { exitCode: 0 });
    child.emit("exit", 0, null);
    events.push("close");
    child.emit("close", 0, null);
  };
  const spawnProcess = vi.fn(() => child) as unknown as typeof import("node:child_process").spawn;
  const terminateProcessTree = vi.fn(async () => {
    events.push("terminate");
    closeChild();
    return true;
  });
  const conversationId = `claude-natural-close-${roots.length}`;
  let cancel: (() => void) | undefined;
  const harness = createClaudeAgentSdkHarness({
    spawnProcess,
    terminateProcessTree,
    createQuery: ({ options }) => {
      options?.spawnClaudeCodeProcess?.({
        command: "/sdk/final/claude",
        args: [],
        cwd: root,
        env: {},
        signal: new AbortController().signal,
      });
      return fixtureClaudeQuery(
        (async function* (): AsyncGenerator<SDKMessage> {
          yield claudeSystem("init");
          if (cancelDuringTurn) {
            cancel?.();
            return;
          }
          yield claudeSuccessResult("Done", "completed");
        })(),
        {
          close: () => {
            events.push("eof");
            if (exitsOnEof) setTimeout(closeChild, 10);
          },
        },
      );
    },
  });
  const manager = ProviderManager.createForTests(
    { commands: { claude: process.execPath } },
    new AgentHarnessRegistry([harness]),
  );
  const result = manager.run(nativeProviderRunInput({
    providerId: "claude",
    conversationId,
    cwd: root,
    prompt: "Complete",
    interactionMode: "build",
    access: "supervised",
  }));
  cancel = () => { manager.cancel(conversationId); };
  return { events, run: { result }, terminateProcessTree };
}

describe("Claude Agent SDK natural close", () => {
  it("ends a completed macOS turn through EOF before stopping its guardian", async () => {
    const app = harnessFixture(true);

    await expect(app.run.result).resolves.toMatchObject({ status: "completed", cleanupConfirmed: true });
    expect(app.events).toEqual(["eof", "close", "terminate"]);
  });

  it("stops a macOS Claude process that ignores EOF after the bounded window", async () => {
    const app = harnessFixture(false);
    const startedAt = Date.now();

    await expect(app.run.result).resolves.toMatchObject({ status: "completed", cleanupConfirmed: true });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_900);
    expect(app.events).toEqual(["eof", "terminate", "close"]);
  });

  it("keeps the strict stop for a user Stop", async () => {
    const app = harnessFixture(true, true);

    await expect(app.run.result).resolves.toMatchObject({ status: "cancelled" });
    expect(app.events[0]).toBe("terminate");
  });

  it("keeps the immediate strict stop where no macOS guardian owns Claude", async () => {
    ownership.platform = "linux";
    const app = harnessFixture(true);

    await expect(app.run.result).resolves.toMatchObject({ status: "completed" });
    expect(app.events[0]).toBe("terminate");
  });
});
