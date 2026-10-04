import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  RestrictedCliError,
  restrictedCliEnvironment,
  runRestrictedCli,
} from "../../src/server/restricted-cli-runner";

describe("restricted CLI runner", () => {
  it("keeps OS/config paths while stripping ambient credentials and secrets", () => {
    expect(restrictedCliEnvironment({
      PATH: "/usr/bin",
      HOME: "/Users/test",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      GH_CONFIG_DIR: "/Users/test/.config/custom-gh",
      XDG_CONFIG_HOME: "/Users/test/.config",
      XDG_RUNTIME_DIR: "/run/user/1000",
      HTTP_PROXY: "http://proxy.example:8080",
      https_proxy: "http://secure-proxy.example:8443",
      NO_PROXY: "127.0.0.1,localhost",
      SSL_CERT_FILE: "/Users/test/.config/company-ca.pem",
      GH_TOKEN: "secret",
      GITHUB_TOKEN: "secret",
      OPENAI_API_KEY: "secret",
      SENTINEL_SECRET: "secret",
    }, "darwin")).toEqual({
      NO_COLOR: "1",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      GH_CONFIG_DIR: "/Users/test/.config/custom-gh",
      HOME: "/Users/test",
      HTTP_PROXY: "http://proxy.example:8080",
      NO_PROXY: "127.0.0.1,localhost",
      PATH: "/usr/bin",
      SSL_CERT_FILE: "/Users/test/.config/company-ca.pem",
      XDG_CONFIG_HOME: "/Users/test/.config",
      XDG_RUNTIME_DIR: "/run/user/1000",
      https_proxy: "http://secure-proxy.example:8443",
    });
  });

  it("passes bounded stdin without a shell and never restores stripped variables", async () => {
    const result = await runRestrictedCli(
      process.execPath,
      [
        "-e",
        "process.stdin.setEncoding('utf8');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({input,sentinel:process.env.SENTINEL_SECRET??null})))",
      ],
      {
        cwd: process.cwd(),
        environment: {
          PATH: process.env.PATH,
          SENTINEL_SECRET: "must-not-cross",
        },
        input: "private body over stdin",
        failureMessage: "Fixture failed.",
      },
    );

    expect(JSON.parse(result.stdout)).toEqual({
      input: "private body over stdin",
      sentinel: null,
    });
    expect(result.stderr).toBe("");
  });

  it("launches a Windows gh.cmd shim through hardened ComSpec semantics", async () => {
    const spawn = vi.fn(() => {
      const child = new EventEmitter() as ChildProcessWithoutNullStreams;
      Object.assign(child, {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      queueMicrotask(() => child.emit("close", 0));
      return child;
    });

    await expect(runRestrictedCli(
      "C:\\Users\\Test User\\gh.cmd",
      ["pr", "create", "--title", "Test PR"],
      {
        cwd: "C:\\workspace",
        environment: {
          PATH: "C:\\tools",
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          SYSTEMROOT: "C:\\Windows",
          GH_TOKEN: "must-not-cross",
        },
        failureMessage: "Fixture failed.",
      },
      { platform: "win32", spawn },
    )).resolves.toEqual({ stdout: "", stderr: "" });

    expect(spawn).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\cmd.exe",
      [
        "/d",
        "/s",
        "/v:off",
        "/c",
        "\"C:\\Users\\Test^ User\\gh.cmd ^\"pr^\" ^\"create^\" ^\"--title^\" ^\"Test^ PR^\"\"",
      ],
      expect.objectContaining({
        cwd: "C:\\workspace",
        detached: false,
        env: {
          COMSPEC: "C:\\Windows\\System32\\cmd.exe",
          NO_COLOR: "1",
          PATH: "C:\\tools",
          SYSTEMROOT: "C:\\Windows",
        },
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: true,
      }),
    );
  });

  it("classifies a failed exit from its bounded stderr without exposing the stderr", async () => {
    const classifyFailure = vi.fn((stderr: string) => stderr.includes("not logged") ? "signed-out" : null);
    const failure = await runRestrictedCli(
      process.execPath,
      ["-e", "process.stderr.write('You are not logged into any GitHub hosts.');process.exit(1)"],
      {
        cwd: process.cwd(),
        environment: { PATH: process.env.PATH },
        failureMessage: "Fixture failed.",
        classifyFailure,
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RestrictedCliError);
    expect(failure).toMatchObject({ code: "failed", reason: "signed-out", message: "Fixture failed." });
    expect(String((failure as Error).message)).not.toContain("logged");
    expect(classifyFailure).toHaveBeenCalledWith("You are not logged into any GitHub hosts.");
  });

  it("terminates an owned process tree when a read is cancelled", async () => {
    const controller = new AbortController();
    const terminateProcessTree = vi.fn(async () => true);
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    Object.assign(child, {
      pid: 4242,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const pending = runRestrictedCli(
      "gh",
      ["pr", "view"],
      {
        cwd: process.cwd(),
        environment: { PATH: process.env.PATH },
        signal: controller.signal,
        failureMessage: "Fixture failed.",
      },
      { spawn: () => child, terminateProcessTree },
    );

    controller.abort();
    await expect(pending).rejects.toEqual(expect.objectContaining({
      code: "timeout",
    } satisfies Partial<RestrictedCliError>));
    expect(terminateProcessTree).toHaveBeenCalledWith(child, true);
  });
});
