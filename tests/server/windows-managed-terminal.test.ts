import { createRequire } from "node:module";
import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IPty } from "node-pty";
import { describe, expect, it, vi } from "vitest";

import { parseWindowsTerminalAuthority } from "../../src/node/windows-terminal-authority";
import {
  observeWindowsTerminalWatch,
  spawnWindowsManagedTerminal,
  windowsTerminalArguments,
} from "../../src/server/windows-managed-terminal";

function watcherChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  });
  return child as unknown as ChildProcess;
}

function ownedFixture() {
  const child = watcherChild();
  const process = { pid: 42 } as IPty;
  const retired = vi.fn(() => true);
  const released = vi.fn();
  const spawnTerminal = vi.fn((_command: string, _args: string) => process);
  const order: string[] = [];
  const owned = spawnWindowsManagedTerminal({
    authority: { path: "C:\\trusted\\guardian.exe", sha256: "a".repeat(64) },
    command: "C:\\Windows\\cmd.exe", args: [], spawnTerminal,
    spawnOwned: (spawnProcess) => {
      const process = spawnProcess();
      order.push("journal-claimed");
      return { process, confirmStopped: retired, releaseIfGroupExited: released,
        requestGuardianStop: () => false, waitForGuardianStop: async () => false };
    },
    spawnWatcher: (() => { order.push("watcher-spawned"); return child; }) as typeof spawn,
  });
  return { child, owned, retired, released, spawnTerminal, order };
}

function receipt(child: ChildProcess, code = 0, output = "INERTIA_TERMINAL_JOB_READY\nINERTIA_TERMINAL_JOB_STOPPED\n") {
  child.stdout?.emit("data", Buffer.from(output));
  child.emit("close", code, null);
}

describe("managed Windows terminal Job ownership", () => {
  it("publishes the durable claim before a watcher can admit the payload", () => {
    const fixture = ownedFixture();
    expect(fixture.order).toEqual(["journal-claimed", "watcher-spawned"]);
    expect(fixture.spawnTerminal.mock.calls[0]?.[0]).toBe("C:\\trusted\\guardian.exe");
  });

  it("does not retire on root exit or an absent receipt", async () => {
    const { child, owned, retired, released } = ownedFixture();
    owned.releaseIfGroupExited(0);
    expect(owned.confirmStopped()).toBe(false);
    expect(retired).not.toHaveBeenCalled();
    expect(released).not.toHaveBeenCalled();
    child.emit("close", 0, null);
    expect(await owned.waitForGuardianStop()).toBe(false);
    expect(owned.confirmStopped()).toBe(false);
  });

  it("retires only after the private Job-zero receipt and successful watcher close", async () => {
    const { child, owned, retired } = ownedFixture();
    child.stdout?.emit("data", Buffer.from("INERTIA_TERMINAL_JOB_READY\nINERTIA_TERMINAL_JOB_STOPPED\n"));
    expect(owned.confirmStopped()).toBe(false);
    child.emit("close", 0, null);
    expect(await owned.waitForGuardianStop()).toBe(true);
    expect(owned.confirmStopped()).toBe(true);
    expect(retired).toHaveBeenCalledTimes(1);
  });

  it.each([
    [255, "INERTIA_TERMINAL_JOB_READY\nINERTIA_TERMINAL_JOB_STOPPED\n"],
    [128, "INERTIA_TERMINAL_JOB_READY\nINERTIA_TERMINAL_JOB_STOPPED\n"],
    [0, "INERTIA_TERMINAL_JOB_READY\nINERTIA_TERMINAL_JOB_STOPPED\nextra"],
    [0, "SUCCESS: root terminated\n"],
    [0, "x".repeat(4096)],
  ])("rejects uncertain watcher result %s", async (code, output) => {
    const { child, owned } = ownedFixture();
    receipt(child, code, output);
    expect(await owned.waitForGuardianStop()).toBe(false);
    expect(owned.confirmStopped()).toBe(false);
  });

  it("consumes Stop once even when the watcher failed, without PID fallback", async () => {
    const child = watcherChild();
    const end = vi.spyOn(child.stdin!, "end");
    const watcher = observeWindowsTerminalWatch(child);
    child.emit("error", new Error("watcher unavailable"));
    expect(watcher.requestStop()).toBe(true);
    expect(watcher.requestStop()).toBe(true);
    expect(end).toHaveBeenCalledTimes(1);
    expect(await watcher.wait()).toBe(false);
    expect(watcher.confirmed()).toBe(false);
  });

  it("keeps admission closed when Stop precedes the authenticated READY receipt", async () => {
    const child = watcherChild();
    const write = vi.spyOn(child.stdin!, "write");
    const watcher = observeWindowsTerminalWatch(child);
    watcher.requestStop();
    child.stdout?.emit("data", Buffer.from("INERTIA_TERMINAL_JOB_READY\n"));
    expect(write).not.toHaveBeenCalled();
    child.stdout?.emit("data", Buffer.from("INERTIA_TERMINAL_JOB_STOPPED\n"));
    child.emit("close", 0, null);
    expect(await watcher.wait()).toBe(true);
  });

  it("bounds the full UTF-16 guardian command line before creating a PTY or claim", () => {
    const spawnTerminal = vi.fn();
    const spawnOwned = vi.fn();
    expect(() => spawnWindowsManagedTerminal({
      authority: { path: "C:\\guardian.exe", sha256: "a".repeat(64) },
      command: "C:\\node.exe", args: ["😀".repeat(16384)], spawnTerminal, spawnOwned,
    })).toThrow("command-line limit");
    expect(spawnOwned).not.toHaveBeenCalled();
    expect(spawnTerminal).not.toHaveBeenCalled();
  });

  it("rejects missing authority before creating any PTY", () => {
    const spawnTerminal = vi.fn();
    expect(() => spawnWindowsManagedTerminal({ authority: undefined,
      command: "cmd.exe", args: [], spawnTerminal, spawnOwned: vi.fn(),
    })).toThrow("authority");
    expect(spawnTerminal).not.toHaveBeenCalled();
  });

  it("bypasses node-pty's prequoted-array heuristic for the nested guardian command line", () => {
    const require = createRequire(import.meta.url);
    const { argsToCommandLine } = require("node-pty/lib/windowsPtyAgent.js") as {
      argsToCommandLine(command: string, args: string | string[]): string;
    };
    const payload = windowsTerminalArguments(["-e", 'process.stdout.write("ready")']);
    const fields = ["terminal-launch", "token", "C:\\node.exe", payload, "digest"];
    const safe = windowsTerminalArguments(fields);
    expect(argsToCommandLine("C:\\guardian.exe", fields))
      .not.toBe(`C:\\guardian.exe ${safe}`);
    expect(argsToCommandLine("C:\\guardian.exe", safe))
      .toBe(`C:\\guardian.exe ${safe}`);
    const fixture = ownedFixture();
    expect(typeof fixture.spawnTerminal.mock.calls[0]?.[1]).toBe("string");
  });

  it("preserves raw command lines and quotes array arguments including trailing slashes", () => {
    expect(windowsTerminalArguments('/d /s /c "npm.cmd run serve"')).toBe('/d /s /c "npm.cmd run serve"');
    expect(windowsTerminalArguments(["", "a b", 'a"b', "C:\\path\\"]))
      .toBe('"" "a b" "a\\"b" "C:\\path\\\\"');
  });

  it("requires the privileged absolute helper path and exact digest shape", () => {
    expect(parseWindowsTerminalAuthority({ path: "guardian.exe", sha256: "a".repeat(64) })).toBeNull();
    expect(parseWindowsTerminalAuthority({ path: "C:\\guardian.exe", sha256: "a".repeat(63) })).toBeNull();
    expect(parseWindowsTerminalAuthority({ path: "C:\\guardian.exe", sha256: "a".repeat(64), extra: true })).toBeNull();
  });
});
