import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import {
  providerMaintenanceEnvironment,
  runProviderMaintenanceAction,
} from "../../src/server/provider/maintenance-runner";
import type { ProviderMaintenanceUpdateAction } from "../../src/server/provider/maintenance-capabilities";

function action(
  input: Partial<ProviderMaintenanceUpdateAction> = {},
): ProviderMaintenanceUpdateAction {
  return {
    executable: "/tools/claude",
    args: ["update"],
    lockKey: "provider-managed:claude",
    installMethod: "provider-managed",
    label: "Update Claude",
    ...input,
  };
}

function fakeChild(
  onKill?: (signal: NodeJS.Signals, child: ChildProcessWithoutNullStreams) => void,
): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill: vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
      onKill?.(signal, child);
      return true;
    }),
  });
  return child;
}

describe("provider maintenance runner", () => {
  it("uses argv spawning, a secret-free environment and sanitized bounded progress", async () => {
    const calls: Array<{
      command: string;
      args: readonly string[];
      options: SpawnOptionsWithoutStdio;
    }> = [];
    const progress: Array<string | null> = [];
    const spawn = vi.fn((command, args, options) => {
      calls.push({ command, args, options });
      const child = fakeChild();
      queueMicrotask(() => {
        (child.stdout as PassThrough).write("api_key=super-secret-value\n");
        (child.stderr as PassThrough).write("updated from /Users/ada/project\n");
        child.emit("close", 0, null);
      });
      return child;
    });
    const result = await runProviderMaintenanceAction(action(), {
      environment: {
        PATH: "/tools",
        HOME: "/Users/ada",
        OPENAI_API_KEY: "must-not-leak",
        ANTHROPIC_API_KEY: "must-not-leak",
      },
      signal: new AbortController().signal,
      spawn,
      onProgress: (value) => progress.push(value.output),
    });

    expect(result.status).toBe("succeeded");
    expect(result.output).toContain("[redacted]");
    expect(result.output).not.toContain("api_key");
    expect(result.output).not.toContain("super-secret-value");
    expect(result.output).not.toContain("/Users/ada");
    expect(progress.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "/tools/claude",
      args: ["update"],
      options: { shell: false, windowsHide: true },
    });
    expect(calls[0]?.options.env).not.toHaveProperty("OPENAI_API_KEY");
    expect(calls[0]?.options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("routes Windows npm.cmd through a quoted cmd.exe invocation without generic shell mode", async () => {
    const calls: Array<{
      command: string;
      args: readonly string[];
      options: SpawnOptionsWithoutStdio;
    }> = [];
    const spawn = vi.fn((command, args, options) => {
      calls.push({ command, args, options });
      const child = fakeChild();
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    });

    const result = await runProviderMaintenanceAction(action({
      executable: "C:\\Users\\Ada\\AppData\\Roaming\\npm\\npm.cmd",
      args: ["install", "-g", "@openai/codex@latest"],
      lockKey: "package-manager:npm-global",
      installMethod: "npm-global",
    }), {
      platform: "win32",
      environment: {
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        SystemRoot: "C:\\Windows",
        PATH: "C:\\Tools",
        PATHEXT: ".EXE;.CMD",
      },
      signal: new AbortController().signal,
      spawn,
    });

    expect(result.status).toBe("succeeded");
    expect(calls[0]?.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(calls[0]?.args.slice(0, 4)).toEqual([
      "/d",
      "/s",
      "/v:off",
      "/c",
    ]);
    expect(calls[0]?.args[4]).toContain("@openai/codex@latest");
    expect(calls[0]?.options).toMatchObject({
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("cancels the owned process and reports cancellation", async () => {
    const abort = new AbortController();
    const child = fakeChild((signal, active) => {
      if (signal === "SIGTERM") {
        queueMicrotask(() => active.emit("close", null, "SIGTERM"));
      }
    });
    const promise = runProviderMaintenanceAction(action(), {
      environment: { PATH: "/tools", HOME: "/home/ada" },
      signal: abort.signal,
      spawn: () => child,
    });
    abort.abort();

    await expect(promise).resolves.toMatchObject({
      status: "cancelled",
      signal: "SIGTERM",
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("escalates to SIGKILL and settles when a child ignores cancellation", async () => {
    const abort = new AbortController();
    const child = fakeChild();
    const promise = runProviderMaintenanceAction(action(), {
      environment: { PATH: "/tools", HOME: "/home/ada" },
      signal: abort.signal,
      killGraceMs: 100,
      spawn: () => child,
    });
    abort.abort();

    await expect(promise).resolves.toMatchObject({
      status: "cancelled",
      signal: "SIGKILL",
    });
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

  it("keeps only the environment required for the supervised updater", () => {
    expect(providerMaintenanceEnvironment({
      PATH: "/tools",
      HOME: "/home/ada",
      CURSOR_API_KEY: "secret",
      ANTHROPIC_AUTH_TOKEN: "secret",
      HTTPS_PROXY: "https://proxy.example",
    })).toEqual({
      CI: "1",
      NO_COLOR: "1",
      HOME: "/home/ada",
      PATH: "/tools",
    });
  });
});
