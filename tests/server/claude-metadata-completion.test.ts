import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { spawn } from "node:child_process";
import { expect, it, vi } from "vitest";
import { readClaudeAgentSdkMetadata } from "../../src/server/provider/claude-agent-sdk-metadata";
import { fakeClaudeChild, waitForImmediateCondition } from "../helpers/claude-harness-fixture";

it("rejects cancellation while successful metadata is waiting for normal process close", async () => {
  const controller = new AbortController();
  const child = fakeClaudeChild();
  const close = vi.fn();
  const terminateProcessTree = vi.fn(async () => true);
  const pending = readClaudeAgentSdkMetadata("/fixture/claude", {}, "/fixture", 5_000, ({ options }) => {
    options?.spawnClaudeCodeProcess?.({ command: "/fixture/claude", args: [], cwd: "/fixture", env: {}, signal: new AbortController().signal });
    return { supportedModels: async () => [], close } as unknown as Query;
  }, ["models"], { spawnProcess: vi.fn(() => child) as unknown as typeof spawn, terminateProcessTree }, controller.signal);
  const assertion = expect(pending).rejects.toThrow("Claude metadata discovery was cancelled");
  await waitForImmediateCondition(() => close.mock.calls.length > 0);
  controller.abort();
  await assertion;
  expect(terminateProcessTree).toHaveBeenCalledExactlyOnceWith(child, true);
});

it("retries SDK close only when its first attempt throws", async () => {
  const close = vi.fn().mockImplementationOnce(() => { throw new Error("SDK close interrupted"); });
  await expect(readClaudeAgentSdkMetadata("/fixture/claude", {}, "/fixture", 5_000,
    () => ({ supportedModels: async () => [], close }) as unknown as Query,
    ["models"],
  )).resolves.toMatchObject({ models: [] });
  expect(close).toHaveBeenCalledTimes(2);
});

it("keeps the answered model catalog when the usage read misses the deadline", async () => {
  const close = vi.fn();
  const query = {
    supportedModels: async () => [{ value: "fixture-opus", displayName: "Fixture Opus", description: "" }],
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => new Promise(() => undefined),
    close,
  } as unknown as Query;
  await expect(readClaudeAgentSdkMetadata("/fixture/claude", {}, "/fixture", 250, () => query))
    .resolves.toEqual({ models: [expect.objectContaining({ id: "fixture-opus" })] });
  expect(close).toHaveBeenCalled();
});

it("still fails a read that answered nothing before the deadline", async () => {
  const query = {
    supportedModels: () => new Promise(() => undefined),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => new Promise(() => undefined),
    close: vi.fn(),
  } as unknown as Query;
  await expect(readClaudeAgentSdkMetadata("/fixture/claude", {}, "/fixture", 250, () => query))
    .rejects.toThrow("Claude metadata discovery timed out.");
});

it("fails a usage-only read whose usage misses the deadline", async () => {
  const query = {
    supportedModels: async () => [],
    accountInfo: async () => ({ email: "fixture@example.invalid" }),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => new Promise(() => undefined),
    close: vi.fn(),
  } as unknown as Query;
  await expect(readClaudeAgentSdkMetadata("/fixture/claude", {}, "/fixture", 250, () => query,
    ["rateLimits"], {}, undefined, true)).rejects.toThrow("Claude metadata discovery timed out.");
});
