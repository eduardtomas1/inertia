import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WINDOWS_NO_CURRENT_DIRECTORY_SEARCH_KEY,
  windowsCurrentDirectorySearchSetting,
  withoutWindowsCurrentDirectorySearch,
  withUserWindowsCurrentDirectorySearch,
} from "../../src/node/windows-current-directory-search";

const BOOTSTRAP_IMPORT = 'import "../node/windows-current-directory-search-bootstrap.js";';
const directories: string[] = [];
let previous: string | undefined;

function guardKeys(environment: NodeJS.ProcessEnv): string[] {
  return Object.keys(environment).filter((key) =>
    key.toUpperCase() === WINDOWS_NO_CURRENT_DIRECTORY_SEARCH_KEY.toUpperCase());
}

async function freshGuard() {
  vi.resetModules();
  return await import("../../src/node/windows-current-directory-search");
}

async function applyBootstrap() {
  vi.resetModules();
  await import("../../src/node/windows-current-directory-search-bootstrap");
  return await import("../../src/node/windows-current-directory-search");
}

beforeEach(() => {
  previous = process.env[WINDOWS_NO_CURRENT_DIRECTORY_SEARCH_KEY];
  delete process.env[WINDOWS_NO_CURRENT_DIRECTORY_SEARCH_KEY];
});

afterEach(() => {
  if (previous === undefined) delete process.env[WINDOWS_NO_CURRENT_DIRECTORY_SEARCH_KEY];
  else process.env[WINDOWS_NO_CURRENT_DIRECTORY_SEARCH_KEY] = previous;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Windows current-directory executable search guard", () => {
  it("sets exactly one canonical enabled guard on win32", () => {
    for (const source of [{}, { NoDefaultCurrentDirectoryInExePath: "" }, { NODEFAULTCURRENTDIRECTORYINEXEPATH: "0" }]) {
      const environment: NodeJS.ProcessEnv = { PATH: "C:\\Windows\\System32", ...source };
      expect(withoutWindowsCurrentDirectorySearch(environment, "win32")).toBe(environment);
      expect(guardKeys(environment)).toEqual([WINDOWS_NO_CURRENT_DIRECTORY_SEARCH_KEY]);
      expect(environment[WINDOWS_NO_CURRENT_DIRECTORY_SEARCH_KEY]).toBe("1");
      expect(environment.PATH).toBe("C:\\Windows\\System32");
    }
  });

  it.each(["linux", "darwin"] as const)("leaves the environment unchanged on %s", (platform) => {
    expect(withoutWindowsCurrentDirectorySearch({ PATH: "/usr/bin" }, platform)).toEqual({ PATH: "/usr/bin" });
  });

  it("reads the setting under any key case, preferring the canonical key", () => {
    expect(windowsCurrentDirectorySearchSetting({})).toBeUndefined();
    expect(windowsCurrentDirectorySearchSetting({ NODEFAULTCURRENTDIRECTORYINEXEPATH: "" })).toBe("");
    expect(windowsCurrentDirectorySearchSetting({
      nodefaultcurrentdirectoryinexepath: "lower",
      NoDefaultCurrentDirectoryInExePath: "canonical",
    })).toBe("canonical");
  });

  it("records the first observed user setting before guarding the process", async () => {
    const guard = await freshGuard();
    const environment: NodeJS.ProcessEnv = { PATH: "C:\\Windows", nodefaultcurrentdirectoryinexepath: "user" };
    guard.guardProcessAgainstWindowsCurrentDirectorySearch(environment, "win32");
    expect(environment).toEqual({ PATH: "C:\\Windows", NoDefaultCurrentDirectoryInExePath: "1" });
    guard.guardProcessAgainstWindowsCurrentDirectorySearch(environment, "win32");
    expect(guard.userWindowsCurrentDirectorySearch()).toBe("user");
  });

  it("records an absent user setting distinctly from an empty one", async () => {
    const absent = await freshGuard();
    absent.guardProcessAgainstWindowsCurrentDirectorySearch({}, "win32");
    expect(absent.userWindowsCurrentDirectorySearch()).toBeUndefined();
    const empty = await freshGuard();
    empty.guardProcessAgainstWindowsCurrentDirectorySearch({ NoDefaultCurrentDirectoryInExePath: "" }, "win32");
    expect(empty.userWindowsCurrentDirectorySearch()).toBe("");
  });

  it.each(["linux", "darwin"] as const)("neither records nor guards on %s", async (platform) => {
    const guard = await freshGuard();
    const environment: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    guard.guardProcessAgainstWindowsCurrentDirectorySearch(environment, platform);
    expect(environment).toEqual({ PATH: "/usr/bin" });
    process.env[WINDOWS_NO_CURRENT_DIRECTORY_SEARCH_KEY] = "live";
    expect(guard.userWindowsCurrentDirectorySearch()).toBe("live");
  });

  it("removes the guard from a copy when the user did not have the setting", () => {
    const guarded: NodeJS.ProcessEnv = { PATH: "C:\\Windows", NoDefaultCurrentDirectoryInExePath: "1", NODEFAULTCURRENTDIRECTORYINEXEPATH: "1" };
    const restored = withUserWindowsCurrentDirectorySearch(guarded, "win32", undefined);
    expect(restored).toEqual({ PATH: "C:\\Windows" });
    expect(restored).not.toBe(guarded);
    expect(guarded.NoDefaultCurrentDirectoryInExePath).toBe("1");
  });

  it.each(["", "0", "custom"])("restores the user's own setting %j", (setting) => {
    const restored = withUserWindowsCurrentDirectorySearch({ PATH: "C:\\Windows", NoDefaultCurrentDirectoryInExePath: "1" }, "win32", setting);
    expect(restored).toEqual({ PATH: "C:\\Windows", NoDefaultCurrentDirectoryInExePath: setting });
  });

  it.each(["linux", "darwin"] as const)("returns the environment unchanged on %s", (platform) => {
    const environment: NodeJS.ProcessEnv = { PATH: "/usr/bin", NoDefaultCurrentDirectoryInExePath: "1" };
    expect(withUserWindowsCurrentDirectorySearch(environment, platform, undefined)).toBe(environment);
  });

  it("guards the process environment on import only on win32 and remembers the user's value", async () => {
    process.env[WINDOWS_NO_CURRENT_DIRECTORY_SEARCH_KEY] = "user";
    const guard = await applyBootstrap();
    expect(process.env[WINDOWS_NO_CURRENT_DIRECTORY_SEARCH_KEY]).toBe(process.platform === "win32" ? "1" : "user");
    expect(guard.userWindowsCurrentDirectorySearch()).toBe("user");
    expect(guard.withUserWindowsCurrentDirectorySearch({ PATH: "C:\\Windows", NoDefaultCurrentDirectoryInExePath: "1" }, "win32"))
      .toEqual({ PATH: "C:\\Windows", NoDefaultCurrentDirectoryInExePath: "user" });
  });

  it("guards the runtime entry before any other module and leaves the Electron main process unguarded", () => {
    expect(readFileSync("src/server/runtime-worker.ts", "utf8").split(/\r?\n/u)[0]).toBe(BOOTSTRAP_IMPORT);
    expect(readFileSync("src/main/index.ts", "utf8")).not.toContain("windows-current-directory-search");
  });

  it.runIf(process.platform === "win32")(
    "keeps a bare Git launch from running a repository-planted git.exe while the user's shell keeps its own lookup",
    async () => {
      const repository = mkdtempSync(join(tmpdir(), "inertia-planted-git-"));
      directories.push(repository);
      copyFileSync(join(process.env.SystemRoot!, "System32", "hostname.exe"), join(repository, "git.exe"));
      const launch = () => spawnSync("git", ["--version"], {
        cwd: repository,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        timeout: 10_000,
      });
      expect(launch().stdout).not.toMatch(/^git version /u);
      const guard = await applyBootstrap();
      expect(process.env[WINDOWS_NO_CURRENT_DIRECTORY_SEARCH_KEY]).toBe("1");
      const guarded = launch();
      expect(guarded.error).toBeUndefined();
      expect(guarded.stdout).toMatch(/^git version /u);

      const userShell = (environment: NodeJS.ProcessEnv) => spawnSync(
        join(process.env.SystemRoot!, "System32", "cmd.exe"),
        ["/d", "/c", "git --version"],
        { cwd: repository, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000, env: environment },
      );
      expect(userShell(process.env).stdout).toMatch(/^git version /u);
      const restored = userShell(guard.withUserWindowsCurrentDirectorySearch(process.env, "win32", undefined));
      expect(restored.error).toBeUndefined();
      expect(restored.stdout).not.toMatch(/^git version /u);
    },
  );
});
