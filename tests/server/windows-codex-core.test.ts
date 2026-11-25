import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { describe, expect, it } from "vitest";

import { cursorAcpProcessInvocation } from "../../src/server/provider/cursor-acp-harness";
import { openCodeServerProcessInvocation } from "../../src/server/provider/opencode-owned-server";
import { providerProcessInvocation, providerPtyArguments } from "../../src/server/provider/process";
import {
  windowsCodexKnownPaths,
} from "../../src/server/provider/windows-codex";

describe("Windows Codex discovery primitives", () => {
  it("builds official, package-manager, and custom installation candidates from case-insensitive environment keys", () => {
    const home = "C:\\Users\\Calm Dev";
    const paths = windowsCodexKnownPaths({
      userprofile: home,
      localappdata: `${home}\\AppData\\Local`,
      AppData: `${home}\\AppData\\Roaming`,
      codex_install_dir: "D:\\Agents\\Codex Install",
      Codex_Home: "E:\\Profiles\\Codex",
      pnpm_home: "D:\\pnpm home",
      bun_install: "D:\\Bun",
      volta_home: "D:\\Volta",
    });

    expect(paths).toContain("D:\\Agents\\Codex Install\\codex.exe");
    expect(paths).toContain("D:\\Agents\\Codex Install\\bin\\codex.exe");
    expect(paths).toContain("E:\\Profiles\\Codex\\packages\\standalone\\current\\bin\\codex.exe");
    expect(paths).toContain(`${home}\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe`);
    expect(paths).toContain(`${home}\\.codex\\packages\\standalone\\current\\bin\\codex.exe`);
    expect(paths).toContain(`${home}\\.codex\\packages\\standalone\\current\\codex.exe`);
    expect(paths).toContain(`${home}\\AppData\\Roaming\\npm\\codex.cmd`);
    expect(paths).toContain("D:\\pnpm home\\codex.cmd");
    expect(paths).toContain("D:\\Bun\\bin\\codex.exe");
    expect(paths).toContain("D:\\Volta\\bin\\codex.exe");
  });

  it("launches native executables directly and batch shims only through a hardened cmd.exe invocation", () => {
    expect(providerProcessInvocation(
      "C:\\Program Files\\OpenAI\\codex.exe",
      ["app-server"],
      {},
      "win32",
    )).toEqual({
      command: "C:\\Program Files\\OpenAI\\codex.exe",
      args: ["app-server"],
    });

    const shim = providerProcessInvocation(
      "C:\\Users\\Álex (Dev)\\AppData\\Roaming\\npm\\codex.cmd",
      ["app-server", "--help"],
      { comspec: "C:\\Windows\\System32\\cmd.exe" },
      "win32",
    );
    expect(shim).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/v:off",
        "/c",
        "\"set NoDefaultCurrentDirectoryInExePath=1&C:\\Users\\Álex^ ^(Dev^)\\AppData\\Roaming\\npm\\codex.cmd ^\"app-server^\" ^\"--help^\"\"",
      ],
      windowsVerbatimArguments: true,
    });
    expect(win32.extname(shim.command).toLowerCase()).toBe(".exe");
    expect(providerPtyArguments(shim)).toBe(
      "/d /s /v:off /c \"set NoDefaultCurrentDirectoryInExePath=1&C:\\Users\\Álex^ ^(Dev^)\\AppData\\Roaming\\npm\\codex.cmd ^\"app-server^\" ^\"--help^\"\"",
    );
  });

  it("routes rich Cursor and OpenCode batch-shim launches through the hardened Windows adapter", () => {
    const environment = { ComSpec: "C:\\Windows\\System32\\cmd.exe" };

    expect(cursorAcpProcessInvocation(
      "C:\\Users\\Calm Dev\\AppData\\Roaming\\npm\\cursor-agent.cmd",
      environment,
      "win32",
    )).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/v:off",
        "/c",
        "\"set NoDefaultCurrentDirectoryInExePath=1&C:\\Users\\Calm^ Dev\\AppData\\Roaming\\npm\\cursor-agent.cmd ^\"acp^\"\"",
      ],
      windowsVerbatimArguments: true,
    });
    expect(openCodeServerProcessInvocation(
      "C:\\Users\\Calm Dev\\AppData\\Roaming\\npm\\opencode.cmd",
      environment,
      "win32",
    )).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/v:off",
        "/c",
        "\"set NoDefaultCurrentDirectoryInExePath=1&C:\\Users\\Calm^ Dev\\AppData\\Roaming\\npm\\opencode.cmd ^\"serve^\" ^\"--pure^\" ^\"--hostname^=127.0.0.1^\" ^\"--port^=0^\"\"",
      ],
      windowsVerbatimArguments: true,
    });
  });

  it("prevents command-string injection while preserving literal percent signs", () => {
    expect(providerProcessInvocation(
      "C:\\Users\\100% Ready\\codex.cmd",
      ["login"],
      {},
      "win32",
    ).args.at(-1)).toBe("\"set NoDefaultCurrentDirectoryInExePath=1&C:\\Users\\100^%^ Ready\\codex.cmd ^\"login^\"\"");
    expect(providerProcessInvocation(
      "C:\\codex.cmd",
      ["safe & literal"],
      {},
      "win32",
    ).args.at(-1)).toBe("\"set NoDefaultCurrentDirectoryInExePath=1&C:\\codex.cmd ^\"safe^ ^&^ literal^\"\"");
    expect(() => providerProcessInvocation("C:\\codex.cmd", ["ok\r\nwhoami"], {}, "win32")).toThrow("cannot be passed safely");
    expect(() => providerProcessInvocation("C:\\codex.cmd", ["bad\" & whoami"], {}, "win32")).toThrow("cannot be passed safely");
  });

  it("disables workspace name resolution before cmd.exe reads any batch shim", () => {
    for (const environment of [
      {},
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      { ComSpec: "C:\\Windows\\System32\\cmd.exe", NoDefaultCurrentDirectoryInExePath: "" },
    ]) {
      for (const executable of ["C:\\Users\\Ada\\AppData\\Roaming\\npm\\codex.cmd", "D:\\Tools\\kimi.BAT"]) {
        const invocation = providerProcessInvocation(executable, ["acp"], environment, "win32");
        expect(invocation.args.slice(0, 4)).toEqual(["/d", "/s", "/v:off", "/c"]);
        expect(invocation.args[4]?.startsWith("\"set NoDefaultCurrentDirectoryInExePath=1&")).toBe(true);
        expect(providerPtyArguments(invocation)).toContain("/c \"set NoDefaultCurrentDirectoryInExePath=1&");
      }
    }
    expect(providerProcessInvocation("/usr/local/bin/codex.cmd", ["acp"], {}, "linux")).toEqual({
      command: "/usr/local/bin/codex.cmd",
      args: ["acp"],
    });
  });

  it("leaves a user's own project action batch file to the user's current-directory setting", () => {
    const invocation = providerProcessInvocation("D:\\Repo\\build.bat", ["release"], {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    }, "win32", { guardCurrentDirectorySearch: false });
    expect(invocation).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/v:off", "/c", "\"D:\\Repo\\build.bat ^\"release^\"\""],
      windowsVerbatimArguments: true,
    });
  });

  it("never lets a workspace supply the command processor that runs a batch shim", () => {
    const command = (environment: NodeJS.ProcessEnv): string =>
      providerProcessInvocation("C:\\Tools\\codex.cmd", [], environment, "win32").command;

    expect(command({ ComSpec: "D:\\Shells\\cmd.exe" })).toBe("D:\\Shells\\cmd.exe");
    expect(command({ ComSpec: "cmd.exe", SystemRoot: "D:\\Win" })).toBe("D:\\Win\\System32\\cmd.exe");
    expect(command({ SYSTEMROOT: "D:\\Win" })).toBe("D:\\Win\\System32\\cmd.exe");
    expect(command({ ComSpec: "cmd.exe", SystemRoot: "Windows" })).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(command({})).toBe("C:\\Windows\\System32\\cmd.exe");
  });

  it.skipIf(process.platform !== "win32")("runs an npm shim's real target instead of a node.cmd planted in the workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-planted-node-"));
    try {
      const workspace = join(root, "workspace");
      const bin = join(root, "npm bin");
      const marker = join(root, "planted-node-ran.txt");
      mkdirSync(workspace);
      mkdirSync(join(bin, "node_modules", "fake-agent"), { recursive: true });
      writeFileSync(join(workspace, "node.cmd"), `@echo planted> "${marker}"\r\n`);
      writeFileSync(
        join(bin, "node_modules", "fake-agent", "cli.js"),
        "process.stdout.write('real-target:' + process.argv.slice(2).join(','))",
      );
      writeFileSync(join(bin, "fake-agent.cmd"), [
        "@ECHO off",
        "GOTO start",
        ":find_dp0",
        "SET dp0=%~dp0",
        "EXIT /b",
        ":start",
        "SETLOCAL",
        "CALL :find_dp0",
        "",
        "IF EXIST \"%dp0%\\node.exe\" (",
        "  SET \"_prog=%dp0%\\node.exe\"",
        ") ELSE (",
        "  SET \"_prog=node\"",
        "  SET PATHEXT=%PATHEXT:;.JS;=;%",
        ")",
        "",
        "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\fake-agent\\cli.js\" %*",
        "",
      ].join("\r\n"));
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
      const environment = {
        PATH: [dirname(process.execPath), join(systemRoot, "System32")].join(";"),
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        SystemRoot: systemRoot,
        ComSpec: join(systemRoot, "System32", "cmd.exe"),
      };
      const launch = (command: string, args: readonly string[]): string => {
        const result = spawnSync(command, args, {
          cwd: workspace,
          env: environment,
          windowsVerbatimArguments: true,
          windowsHide: true,
          encoding: "utf8",
          timeout: 30_000,
        });
        expect(result.error).toBeUndefined();
        return result.stdout;
      };
      const invocation = providerProcessInvocation(join(bin, "fake-agent.cmd"), ["acp"], environment, "win32");
      const unguarded = invocation.args.map((arg) => arg.replace("set NoDefaultCurrentDirectoryInExePath=1&", ""));

      launch(invocation.command, unguarded);
      expect(existsSync(marker)).toBe(true);
      rmSync(marker);

      expect(launch(invocation.command, invocation.args)).toBe("real-target:acp");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
