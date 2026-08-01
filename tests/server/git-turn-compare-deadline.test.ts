import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({
  blockedPath: null as string | null,
  entered: null as (() => void) | null,
  release: null as (() => void) | null,
  wait: null as Promise<void> | null,
  statPaths: [] as string[],
  lstatPaths: [] as string[],
}));

const gitInspection = vi.hoisted(() => ({
  calls: [] as Array<{ cwd: string; args: string[] }>,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const path = String(args[0]);
      if (path === filesystem.blockedPath) {
        filesystem.entered?.();
        await filesystem.wait;
      }
      return path;
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      filesystem.statPaths.push(String(args[0]));
      return {
        isDirectory: () => true,
      } as Awaited<ReturnType<typeof actual.stat>>;
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      filesystem.lstatPaths.push(String(args[0]));
      return {
        isSymbolicLink: () => false,
      } as Awaited<ReturnType<typeof actual.lstat>>;
    },
  };
});

vi.mock("../../src/server/git/runner", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/server/git/runner")
  >();
  return {
    ...actual,
    runGitInspection: vi.fn(async (
      cwd: string,
      args: readonly string[],
    ) => {
      gitInspection.calls.push({ cwd, args: [...args] });
      return {
        stdout: Buffer.from(
          args[0] === "rev-parse" && args[1] === "--show-toplevel"
            ? `${cwd}\n`
            : "",
        ),
        stderr: Buffer.alloc(0),
        truncated: false,
      };
    }),
  };
});

import { compareGitSnapshots } from "../../src/server/git/artifacts";
import { SourceControlDeadline } from "../../src/server/runtime/commands/source-control-deadline";

const beforeReference =
  "refs/inertia/checkpoints/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const afterReference =
  "refs/inertia/checkpoints/11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333";
const repositoryPath = resolve("/repository");

function blockFilesystemPath(path: string): Promise<void> {
  filesystem.blockedPath = path;
  const entered = new Promise<void>((resolve) => {
    filesystem.entered = resolve;
  });
  filesystem.wait = new Promise<void>((resolve) => {
    filesystem.release = resolve;
  });
  return entered;
}

async function flushLateFilesystemWork(): Promise<void> {
  filesystem.release?.();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-01T10:00:00.000Z"));
  filesystem.blockedPath = null;
  filesystem.entered = null;
  filesystem.release = null;
  filesystem.wait = null;
  filesystem.statPaths = [];
  filesystem.lstatPaths = [];
  gitInspection.calls = [];
});

afterEach(async () => {
  await flushLateFilesystemWork();
  vi.useRealTimers();
});

describe("turn comparison aggregate deadline", () => {
  it("settles while pre-Git repository resolution is stalled and starts no late Git work", async () => {
    const entered = blockFilesystemPath(repositoryPath);
    const deadline = new SourceControlDeadline(Date.now() + 100, "read");
    try {
      const comparison = deadline.run(
        async (signal) => await compareGitSnapshots(
          repositoryPath,
          beforeReference,
          afterReference,
          { deadlineAt: deadline.deadlineAt, signal },
        ),
      );
      const rejection = expect(comparison).rejects.toThrow(
        "Git inspection took too long.",
      );
      await entered;

      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      await flushLateFilesystemWork();

      expect(filesystem.statPaths).toEqual([]);
      expect(gitInspection.calls).toEqual([]);
    } finally {
      deadline.dispose();
    }
  });

  it("does not start snapshot Git reads after selected-path validation outlives the deadline", async () => {
    const entered = blockFilesystemPath(resolve(repositoryPath, "tracked.txt"));
    const deadline = new SourceControlDeadline(Date.now() + 100, "read");
    try {
      const comparison = deadline.run(
        async (signal) => await compareGitSnapshots(
          repositoryPath,
          beforeReference,
          afterReference,
          {
            deadlineAt: deadline.deadlineAt,
            signal,
            paths: ["tracked.txt"],
          },
        ),
      );
      const rejection = expect(comparison).rejects.toThrow(
        "Git inspection took too long.",
      );
      await entered;
      expect(gitInspection.calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      await flushLateFilesystemWork();

      expect(gitInspection.calls).toHaveLength(1);
      expect(gitInspection.calls[0]?.args).toEqual([
        "rev-parse",
        "--show-toplevel",
      ]);
      expect(filesystem.lstatPaths).toEqual([]);
    } finally {
      deadline.dispose();
    }
  });
});
