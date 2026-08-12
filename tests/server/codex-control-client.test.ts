import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import {
  type ChildProcessWithoutNullStreams,
  type spawn,
} from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { withCodexControlClient } from "../../src/server/codex/control-client";

function fakeChild(
  onInput: (text: string, child: ChildProcessWithoutNullStreams) => void,
): {
  child: ChildProcessWithoutNullStreams;
  stdout: PassThrough;
} {
  const child =
    new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      onInput(String(chunk), child);
      callback();
    },
  });
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    pid: 42_424,
    killed: false,
    connected: false,
    exitCode: null,
    signalCode: null,
  });
  return { child, stdout };
}

function options(child: ChildProcessWithoutNullStreams) {
  return {
    executable: "/fake/codex",
    environment: {},
    cwd: "/workspace",
    timeoutMs: 30_000,
    spawnProcess: (() => child) as unknown as typeof spawn,
    terminateProcessTree: vi.fn(async (active) => {
      active.exitCode = 0;
      active.emit("close", 0, null);
      return true;
    }),
  };
}

describe("Codex control client", () => {
  it("fails immediately on malformed JSON", async () => {
    const fixture = fakeChild((_text) => {
      fixture.stdout.write("{malformed-json}\n");
    });
    const clientOptions = options(fixture.child);

    await expect(withCodexControlClient(
      clientOptions,
      async () => "unreachable",
    )).rejects.toThrow("returned malformed JSON");
    expect(clientOptions.terminateProcessTree).toHaveBeenCalledOnce();
  });

  it("fails immediately when stdout closes before initialization settles", async () => {
    const fixture = fakeChild((_text) => {
      fixture.stdout.end();
    });

    await expect(withCodexControlClient(
      options(fixture.child),
      async () => "unreachable",
    )).rejects.toThrow("output closed early");
  });

  it("fails pending work immediately when stdin errors", async () => {
    const fixture = fakeChild((_text, active) => {
      queueMicrotask(() => {
        active.stdin.emit("error", new Error("EPIPE"));
      });
    });

    await expect(withCodexControlClient(
      options(fixture.child),
      async () => "unreachable",
    )).rejects.toThrow("input stream failed");
  });

  it("completes a request and terminates the owned process exactly once", async () => {
    const methods: string[] = [];
    const fixture = fakeChild((text) => {
      const message = JSON.parse(text) as {
        id?: number;
        method: string;
      };
      methods.push(message.method);
      if (message.id === undefined) return;
      fixture.stdout.write(`${JSON.stringify({
        id: message.id,
        result: message.method === "skills/list"
          ? { data: [{ cwd: "/workspace", skills: [] }] }
          : {},
      })}\n`);
    });
    const clientOptions = options(fixture.child);

    await expect(withCodexControlClient(
      clientOptions,
      async ({ request }) => await request("skills/list", {
        cwds: ["/workspace"],
      }),
    )).resolves.toEqual({
      data: [{ cwd: "/workspace", skills: [] }],
    });
    expect(methods).toEqual(["initialize", "initialized", "skills/list"]);
    expect(clientOptions.terminateProcessTree).toHaveBeenCalledOnce();
    expect(clientOptions.terminateProcessTree)
      .toHaveBeenCalledWith(fixture.child, true);
  });

  it("delivers bounded App Server notifications to the control observer", async () => {
    const onNotification = vi.fn();
    const fixture = fakeChild((text) => {
      const message = JSON.parse(text) as {
        id?: number;
        method: string;
      };
      if (message.id === undefined) return;
      fixture.stdout.write(`${JSON.stringify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          item: { type: "contextCompaction", id: "compact-1" },
        },
      })}\n`);
      fixture.stdout.write(`${JSON.stringify({
        id: message.id,
        result: {},
      })}\n`);
    });

    await expect(withCodexControlClient({
      ...options(fixture.child),
      onNotification,
    }, async ({ request }) => await request("thread/compact/start", {
      threadId: "thread-1",
    }))).resolves.toEqual({});
    expect(onNotification).toHaveBeenCalledWith(
      "item/completed",
      expect.objectContaining({ threadId: "thread-1" }),
    );
  });

  it("bounds an unanswered request and still terminates exactly once", async () => {
    vi.useFakeTimers();
    try {
      let markRequestSeen!: () => void;
      const requestSeen = new Promise<void>((resolve) => {
        markRequestSeen = resolve;
      });
      const fixture = fakeChild((text) => {
        const message = JSON.parse(text) as {
          id?: number;
          method: string;
        };
        if (message.id === undefined) return;
        if (message.method === "initialize") {
          fixture.stdout.write(`${JSON.stringify({
            id: message.id,
            result: {},
          })}\n`);
        } else {
          markRequestSeen();
        }
      });
      const clientOptions = {
        ...options(fixture.child),
        timeoutMs: 500,
      };
      const running = withCodexControlClient(
        clientOptions,
        async ({ request }) => await request("thread/goal/get", {
          threadId: "thread-1",
        }),
      );
      const rejection = expect(running).rejects.toThrow(
        "thread/goal/get timed out",
      );

      await requestSeen;
      await vi.advanceTimersByTimeAsync(500);
      await rejection;
      expect(clientOptions.terminateProcessTree).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a successful operation when cleanup is unconfirmed", async () => {
    const fixture = fakeChild((text) => {
      const message = JSON.parse(text) as {
        id?: number;
        method: string;
      };
      if (message.id === undefined) return;
      fixture.stdout.write(`${JSON.stringify({
        id: message.id,
        result: {},
      })}\n`);
    });
    const terminateProcessTree = vi.fn(async () => false);

    await expect(withCodexControlClient({
      ...options(fixture.child),
      processLabel: "Codex goal process tree",
      terminateProcessTree,
    }, async () => "completed")).rejects.toMatchObject({
      code: "process-tree-termination-unconfirmed",
      message: "Codex goal process tree could not be confirmed stopped.",
    });
    expect(terminateProcessTree).toHaveBeenCalledOnce();
  });
});
