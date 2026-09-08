import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { expect, it, vi } from "vitest";
import { handleBranchListCommand } from "../../src/server/runtime/commands/source-control-branch-list";
import { GitError } from "../../src/server/git/types";

it("keeps ownership through disconnect cancellation and reports cleanup failure", async () => {
  const socket = new EventEmitter();
  const send = vi.fn();
  let releaseCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  let signal: AbortSignal | undefined;
  const failure = new GitError("operation-failed", "Git stopped responding, and its process tree could not be confirmed stopped.");
  const inspectBranches = async (options: { signal: AbortSignal }) => {
    signal = options.signal;
    await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
    await cleanup;
    throw failure;
  };
  let settled = false;
  const outcome = handleBranchListCommand(socket as unknown as WebSocket, {
    type: "git.branches",
    requestId: "11111111-1111-4111-8111-111111111111",
    payload: { projectId: "22222222-2222-4222-8222-222222222222", authorityRef: "33333333-3333-4333-8333-333333333333" },
  }, { inspectBranches, send }).catch((error: unknown) => {
    settled = true;
    return error;
  });
  socket.emit("close");
  expect(signal?.aborted).toBe(true);
  await Promise.resolve();
  expect(settled).toBe(false);
  releaseCleanup();
  await expect(outcome).resolves.toBe(failure);
  expect(send).not.toHaveBeenCalled();
  expect(socket.listenerCount("close")).toBe(0);
});
