import type WebSocket from "ws";

import { afterEach, describe, expect, it, vi } from "vitest";

import { handlePreMergeConfidenceCommand } from "../../src/server/runtime/commands/pre-merge-confidence-command";
import { GIT_READ_OPERATION_TIMEOUT_MS } from "../../src/shared/runtime-command-timeouts";

afterEach(() => {
  vi.useRealTimers();
});

describe("pre-merge confidence command", () => {
  it("keeps repository verification inside the aggregate read deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T17:00:00Z"));
    const socket = {} as WebSocket;
    const send = vi.fn();
    const verificationOptions: Array<{
      deadlineAt: number;
      signal: AbortSignal;
    }> = [];
    const runVerified = async <Result,>(
      _repository: string,
      _operation: (root: string) => Promise<Result>,
      options: { deadlineAt: number; signal: AbortSignal },
    ): Promise<Result> => {
      verificationOptions.push(options);
      return await new Promise<Result>((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(new Error("Repository verification cancelled.")),
          { once: true },
        );
      });
    };

    const running = handlePreMergeConfidenceCommand({
      socket,
      command: {
        type: "git.pr.confidence",
        requestId: crypto.randomUUID(),
        payload: {
          projectId: crypto.randomUUID(),
          repositoryPath: ".",
          authorityRef: crypto.randomUUID(),
        },
      },
      resolveRepository: vi.fn(async () => "repository"),
      runVerified,
      send,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(verificationOptions).toHaveLength(1);
    expect(verificationOptions[0]).toMatchObject({
      deadlineAt: Date.now() + GIT_READ_OPERATION_TIMEOUT_MS,
      signal: expect.any(AbortSignal),
    });

    const timedOut = expect(running).rejects.toThrow(
      "Git inspection took too long.",
    );
    await vi.advanceTimersByTimeAsync(GIT_READ_OPERATION_TIMEOUT_MS);

    await timedOut;
    expect(send).not.toHaveBeenCalled();
  });
});
