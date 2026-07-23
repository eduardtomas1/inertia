import { win32 } from "node:path";
import { describe, expect, it } from "vitest";

import { providerProcessInvocation, providerPtyArguments } from "../../src/server/provider/process";
import {
  parseWhereExecutableOutput,
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

  it("accepts bounded absolute where.exe results and deduplicates Windows paths case-insensitively", () => {
    expect(parseWhereExecutableOutput([
      "\"C:\\Program Files\\Codex\\codex.EXE\"",
      "c:\\program files\\codex\\CODEX.exe",
      "relative\\codex.cmd",
      "",
      "D:\\Unicode 路径\\codex.cmd",
    ].join("\r\n"))).toEqual([
      "C:\\Program Files\\Codex\\codex.EXE",
      "D:\\Unicode 路径\\codex.cmd",
    ]);
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
        "\"C:\\Users\\Álex^ ^(Dev^)\\AppData\\Roaming\\npm\\codex.cmd ^\"app-server^\" ^\"--help^\"\"",
      ],
      windowsVerbatimArguments: true,
    });
    expect(win32.extname(shim.command).toLowerCase()).toBe(".exe");
    expect(providerPtyArguments(shim)).toBe(
      "/d /s /v:off /c \"C:\\Users\\Álex^ ^(Dev^)\\AppData\\Roaming\\npm\\codex.cmd ^\"app-server^\" ^\"--help^\"\"",
    );
  });

  it("prevents command-string injection while preserving literal percent signs", () => {
    expect(providerProcessInvocation(
      "C:\\Users\\100% Ready\\codex.cmd",
      ["login"],
      {},
      "win32",
    ).args.at(-1)).toBe("\"C:\\Users\\100^%^ Ready\\codex.cmd ^\"login^\"\"");
    expect(providerProcessInvocation(
      "C:\\codex.cmd",
      ["safe & literal"],
      {},
      "win32",
    ).args.at(-1)).toBe("\"C:\\codex.cmd ^\"safe^ ^&^ literal^\"\"");
    expect(() => providerProcessInvocation("C:\\codex.cmd", ["ok\r\nwhoami"], {}, "win32")).toThrow("cannot be passed safely");
    expect(() => providerProcessInvocation("C:\\codex.cmd", ["bad\" & whoami"], {}, "win32")).toThrow("cannot be passed safely");
  });
});
