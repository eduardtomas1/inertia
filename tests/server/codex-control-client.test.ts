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

    await expect(withCodexControlClient(
      options(fixture.child),
      async () => "unreachable",
    )).rejects.toThrow("returned malformed JSON");
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
});
