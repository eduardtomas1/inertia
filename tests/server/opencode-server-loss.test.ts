// @inertia-test-suite portable
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import {
  terminateProcessTreeAndWait,
  type ProcessTreeTerminator,
} from "../../src/server/process-lifecycle";
import { createOpenCodeSdkHarness } from "../../src/server/provider/opencode-sdk-harness";
import { windowsCleanupFailures } from "../../src/server/windows-cleanup-diagnostics";
import {
  loopbackPortIsOpen,
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  waitFor,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { lifecycleServerSource } from "../helpers/opencode-lifecycle-server";
import { nativeProviderRunInput } from "./model-route-fixture";

type Scenario = Parameters<typeof lifecycleServerSource>[2];

function lifecycleManager(
  scenario: Scenario,
  label: string,
  terminateProcessTree?: ProcessTreeTerminator,
) {
  const root = portableFixtureRoot(label);
  const capturePath = join(root, "capture.json");
  const command = portableNodeExecutable(root, "opencode");
  writeNodeSubcommand(root, "serve", lifecycleServerSource(root, capturePath, scenario));
  const manager = ProviderManager.createForTests(
    { commands: { opencode: command } },
    new AgentHarnessRegistry([createOpenCodeSdkHarness({
      runDeadlineMs: 12_000,
      eventInactivityDeadlineMs: 8_000,
      ...(terminateProcessTree ? { terminateProcessTree } : {}),
    })]),
  );
  const input = nativeProviderRunInput({
    providerId: "opencode",
    conversationId: `opencode-${scenario}`,
    cwd: root,
    prompt: "Continue",
    interactionMode: "build",
    access: "supervised",
  });
  const port = (): number => (JSON.parse(readFileSync(capturePath, "utf8")) as { port: number }).port;
  const promptReceived = (): boolean => existsSync(`${capturePath}.prompt`);
  return { root, manager, input, port, promptReceived };
}

describe("OpenCode owned-server loss", { concurrent: false }, () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

  it("fails the run promptly when the owned server exits after the prompt, with its tree unprovable only on Windows", async () => {
    const { root, manager, input } = lifecycleManager("server-exit", "OpenCode server exit");
    roots.push(root);
    const windows = process.platform === "win32";

    const result = await manager.run(input);
    const evidence = JSON.stringify({
      error: result.error,
      failure: result.failure,
      exitCode: result.exitCode,
      signal: result.signal,
      windowsCleanupFailures: windowsCleanupFailures(),
    });

    expect(result, evidence).toMatchObject(windows
      ? {
          status: "failed",
          failure: { phase: "cleanup", terminalEvent: "process-tree/cleanup" },
          cleanupConfirmed: false,
        }
      : {
          status: "failed",
          failure: { phase: "runtime" },
          cleanupConfirmed: true,
        });
    expect(result.error, evidence).toMatch(
      /^(?:The OpenCode server exited|OpenCode closed its event stream) before the session completed\./u,
    );
    if (windows) {
      expect(result.error, evidence).toContain(
        "Cleanup also failed: OpenCode server process tree could not be confirmed stopped.",
      );
      expect(manager.activeConversationIds()).toEqual([input.conversationId]);
    } else {
      expect([
        ["The OpenCode server exited before the session completed.", "process-exit"],
        ["OpenCode closed its event stream before the session completed.", "transport-closed"],
      ]).toContainEqual([result.error, result.failure?.reason]);
      expect(manager.activeConversationIds()).toEqual([]);
    }
  });

  it("reports the server loss with unconfirmed cleanup when its process tree cannot be proven stopped", async () => {
    const unprovableTerminator: ProcessTreeTerminator = async (child, force) => {
      await terminateProcessTreeAndWait(child, force);
      return false;
    };
    const { root, manager, input } = lifecycleManager(
      "server-exit",
      "OpenCode server exit unprovable",
      unprovableTerminator,
    );
    roots.push(root);

    await expect(manager.run(input)).resolves.toMatchObject({
      status: "failed",
      error: expect.stringMatching(
        /(?:exited|closed its event stream) before the session completed\..*Cleanup also failed: OpenCode server process tree could not be confirmed stopped\./u,
      ),
      failure: { phase: "cleanup", terminalEvent: "process-tree/cleanup" },
      cleanupConfirmed: false,
    });
    expect(manager.activeConversationIds()).toEqual([input.conversationId]);
  });

  it("fails instead of reconnecting when the event stream drops", async () => {
    const { root, manager, input, port } = lifecycleManager("event-stream-drop", "OpenCode dropped events");
    roots.push(root);

    await expect(manager.run(input)).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("closed its event stream"),
      failure: { reason: "transport-closed", phase: "runtime" },
      cleanupConfirmed: true,
    });
    await waitFor("the OpenCode server to close", async () => !(await loopbackPortIsOpen(port())));
  });

  it("rejects an unterminated event before buffering it without bound", async () => {
    const { root, manager, input } = lifecycleManager("unterminated-event", "OpenCode unterminated event");
    roots.push(root);

    await expect(manager.run(input)).resolves.toMatchObject({
      status: "failed",
      error: "OpenCode sent an oversized event.",
      failure: { reason: "protocol-overflow", phase: "runtime" },
      cleanupConfirmed: true,
    });
  });

  it("does not send the prompt after cancellation during session initialization", async () => {
    const { root, manager, input, promptReceived } = lifecycleManager("slow-cancel-ack", "OpenCode early cancel");
    roots.push(root);

    await expect(manager.run(input, {
      onSession: () => queueMicrotask(() => manager.cancel(input.conversationId)),
    })).resolves.toMatchObject({ status: "cancelled" });
    expect(promptReceived()).toBe(false);
  });
});
