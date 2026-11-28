// @inertia-test-suite portable
import type { PassThrough } from "node:stream";

import type { SDKMessage, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { claudeSystem, fixtureClaudeQuery } from "../helpers/claude-agent-sdk-protocol";
import { fakeClaudeChild } from "../helpers/claude-harness-fixture";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

// A Claude Code process that exits before its first message (T3 ae268d935).
describe("Claude Code startup exit", () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

  // The installed SDK's exit Error: `message` can carry Claude's stderr tail,
  // `telemetryMessage` is only the exit status.
  function claudeExitError(errorClass: string, status: string, stderr: string): Error {
    return Object.assign(new Error(`${status}. stderr: ${stderr}`), { telemetryMessage: status, errorClass });
  }

  async function runClaudeThatExits(input: {
    stderr: string;
    error: Error;
    answerFirst?: boolean;
  }) {
    const root = portableFixtureRoot("Claude SDK startup exit");
    roots.push(root);
    const child = fakeClaudeChild();
    const harness = createClaudeAgentSdkHarness({
      spawnProcess: vi.fn(() => child) as unknown as typeof import("node:child_process").spawn,
      terminateProcessTree: vi.fn(async () => true),
      createQuery: ({ options }) => {
        options?.spawnClaudeCodeProcess?.({
          command: "/sdk/final/claude",
          args: [],
          cwd: root,
          env: {},
          signal: new AbortController().signal,
        } satisfies SpawnOptions);
        (child.stderr as unknown as PassThrough).write(input.stderr);
        return fixtureClaudeQuery((async function* (): AsyncGenerator<SDKMessage> {
          if (input.answerFirst) yield claudeSystem("init", { plugins: [], skills: [] });
          // Let the owned process read the stderr the CLI wrote before it exited.
          await new Promise((resolve) => setImmediate(resolve));
          throw input.error;
        })());
      },
    });
    const manager = ProviderManager.createForTests(
      { commands: { claude: "/configured/claude" } },
      new AgentHarnessRegistry([harness]),
    );
    return await manager.run(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-startup-exit",
      cwd: root,
      prompt: "Start",
      interactionMode: "build",
      access: "supervised",
    }));
  }

  const EPERM_GUIDANCE = "It was denied access to a file or folder (EPERM). On macOS, allow Inertia under System Settings > Privacy & Security > Files and Folders, or move the project out of Desktop, Documents, or Downloads, then retry the turn.";

  it.each([
    "Error: EPERM: operation not permitted, scandir '/Users/private/Desktop/project'",
    "Error: Operation not permitted (os error 1) at /Users/private/Desktop",
  ])("names a startup exit's status and the macOS privacy fix when Claude Code was denied access: %s", async (stderr) => {
    const result = await runClaudeThatExits({
      stderr,
      error: claudeExitError("process_exited_nonzero", "Claude Code process exited with code 1", stderr),
    });

    expect(result).toMatchObject({
      status: "failed",
      error: `Claude Code process exited with code 1 before it started. ${EPERM_GUIDANCE}`,
      failure: { terminalEvent: "sdk/exception" },
    });
    expect(result.error).not.toContain("/Users/private");
    expect(result.failure?.message).not.toContain("/Users/private");
  });

  it("names a startup exit's status without its private output when the cause is unknown", async () => {
    const result = await runClaudeThatExits({
      stderr: "token=sk-private-123",
      error: claudeExitError("process_killed_by_signal", "Claude Code process terminated by signal SIGKILL", "token=sk-private-123"),
    });

    expect(result).toMatchObject({
      status: "failed",
      error: "Claude Code process terminated by signal SIGKILL before it started. Check the details for the provider's output, then retry the turn.",
    });
    expect(JSON.stringify(result)).not.toContain("sk-private-123");
  });

  it("keeps a Claude Code exit after its first message out of the startup-exit wording", async () => {
    const result = await runClaudeThatExits({
      stderr: "Error: EPERM: operation not permitted",
      error: Object.assign(new Error("Claude Code process exited with code 1"), {
        telemetryMessage: "Claude Code process exited with code 1",
        errorClass: "process_exited_nonzero",
      }),
      answerFirst: true,
    });

    expect(result).toMatchObject({ status: "failed", error: "Claude Code process exited with code 1" });
  });
});
