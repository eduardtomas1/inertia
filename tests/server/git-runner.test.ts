import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runGit } from "../../src/server/git/runner";
import { gitProcessEnvironment } from "../../src/server/git/environment";
import { GitError } from "../../src/server/git/types";
import { terminateProcessTreeAndWait } from "../../src/server/process-lifecycle";
import {
  portableNodeExecutable,
  waitFor,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";

const temporaryDirectories: string[] = [];
const descendantPids: number[] = [];

afterEach(async () => {
  for (const pid of descendantPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process-tree cleanup under test may already have removed it.
    }
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })),
  );
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("Git runner locale", () => {
  it("does not start Git after an aggregate operation deadline has expired", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-git-deadline-"));
    temporaryDirectories.push(directory);
    const terminateProcessTree = vi.fn(async () => true);

    await expect(runGit(directory, ["status"], {
      deadlineAt: Date.now() - 1,
      failureMessage: "Git status failed.",
    }, {
      terminateProcessTree,
    })).rejects.toMatchObject({
      code: "timeout",
    } satisfies Partial<GitError>);

    expect(terminateProcessTree).not.toHaveBeenCalled();
  });

  it("strips ambient routing and secrets while preserving explicit Git state", () => {
    const inherited = {
      PATH: "/usr/bin:/bin",
      HOME: "/tmp/home",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/dbus",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      USERNAME: "twin",
      XDG_CACHE_HOME: "/tmp/cache",
      GIT_DIR: "/tmp/other.git",
      GIT_INDEX_FILE: "/tmp/checkpoint.index",
      GIT_WORK_TREE: "/tmp/other-worktree",
      GIT_SSH_VARIANT: "ssh",
      GIT_CONFIG_GLOBAL: "/tmp/gitconfig",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/tmp/system-gitconfig",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: "Authorization: secret",
      OPENAI_API_KEY: "secret",
      LANG: "es_ES.UTF-8",
      LC_ALL: "es_ES.UTF-8",
    };
    expect(gitProcessEnvironment(inherited)).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/tmp/home",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/dbus",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      USERNAME: "twin",
      XDG_CACHE_HOME: "/tmp/cache",
      GIT_SSH_VARIANT: "ssh",
      GIT_CONFIG_GLOBAL: "/tmp/gitconfig",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/tmp/system-gitconfig",
      LANG: "C",
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
    });
    expect(gitProcessEnvironment(inherited, {
      GIT_INDEX_FILE: "/tmp/checkpoint.index",
      GIT_WORK_TREE: "/tmp/checkpoint-worktree",
    })).toMatchObject({
      GIT_INDEX_FILE: "/tmp/checkpoint.index",
      GIT_WORK_TREE: "/tmp/checkpoint-worktree",
    });
  });

  it("classifies Git failures in a stable C locale", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-git-locale-"));
    temporaryDirectories.push(directory);
    const previousLang = process.env.LANG;
    const previousLocale = process.env.LC_ALL;
    process.env.LANG = "es_ES.UTF-8";
    process.env.LC_ALL = "es_ES.UTF-8";
    try {
      await expect(runGit(directory, ["status"], {
        failureMessage: "Git status failed.",
      })).rejects.toMatchObject({
        code: "not-repository",
      } satisfies Partial<GitError>);
    } finally {
      if (previousLang === undefined) delete process.env.LANG;
      else process.env.LANG = previousLang;
      if (previousLocale === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = previousLocale;
    }
  });

  it.each([
    {
      label: "timeout",
      timeoutMs: 500,
      maxOutputBytes: 64 * 1024,
      output: "",
      errorCode: "timeout",
    },
    {
      label: "output overflow",
      timeoutMs: 5_000,
      maxOutputBytes: 1_024,
      output: 'process.stdout.write("x".repeat(64 * 1024));',
      errorCode: "output-limit",
    },
  ])("removes Git descendants after $label", async ({
    timeoutMs,
    maxOutputBytes,
    output,
    errorCode,
  }) => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-git-tree-"));
    temporaryDirectories.push(directory);
    portableNodeExecutable(directory, "git");
    const pidPath = join(directory, "descendant.pid");
    writeNodeSubcommand(directory, "status", `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const descendant = spawn(
  process.execPath,
  ["-e", "setInterval(() => {}, 1000)"],
  { stdio: "ignore" },
);
fs.writeFileSync(${JSON.stringify(pidPath)}, String(descendant.pid));
${output}
setInterval(() => {}, 1000);
`);
    const previousPath = process.env.PATH;
    process.env.PATH = directory;
    try {
      const running = runGit(directory, ["status"], {
        timeoutMs,
        maxOutputBytes,
        failureMessage: "Git status failed.",
      });
      const rejection = expect(running).rejects.toMatchObject({
        code: errorCode,
      });
      await waitFor("the Git descendant PID", async () => {
        try {
          return (await readFile(pidPath, "utf8")).trim().length > 0;
        } catch {
          return false;
        }
      });
      const descendantPid = Number(await readFile(pidPath, "utf8"));
      descendantPids.push(descendantPid);

      await rejection;
      await waitFor(
        "the Git descendant to stop",
        () => !processExists(descendantPid),
      );
      // The runner promise is also the ownership boundary for the executable
      // itself. Windows must be able to remove the copied git.exe immediately,
      // without relying on an afterEach retry or a later process reap.
      await rm(directory, { force: true, recursive: true });
      temporaryDirectories.splice(temporaryDirectories.indexOf(directory), 1);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it.each([
    {
      label: "truncation",
      source: 'process.stdout.write("x".repeat(64 * 1024)); setInterval(() => {}, 1000);',
      timeoutMs: 5_000,
      maxOutputBytes: 1_024,
      truncateOutput: true,
    },
    {
      label: "timeout",
      source: "setInterval(() => {}, 1000);",
      timeoutMs: 50,
      maxOutputBytes: 64 * 1024,
      truncateOutput: false,
    },
  ])("reports unconfirmed process-tree cleanup after Git $label", async ({
    source,
    timeoutMs,
    maxOutputBytes,
    truncateOutput,
  }) => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-git-unconfirmed-tree-"));
    temporaryDirectories.push(directory);
    portableNodeExecutable(directory, "git");
    writeNodeSubcommand(directory, "status", source);
    const previousPath = process.env.PATH;
    process.env.PATH = directory;
    try {
      await expect(runGit(directory, ["status"], {
        timeoutMs,
        maxOutputBytes,
        truncateOutput,
        failureMessage: "Git status failed.",
      }, {
        terminateProcessTree: async (child, force) => {
          await terminateProcessTreeAndWait(child, force);
          return false;
        },
      })).rejects.toMatchObject({
        code: "operation-failed",
        message: "Git stopped responding, and its process tree could not be confirmed stopped.",
      } satisfies Partial<GitError>);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("lets an already-finishing bounded Git inspection close without termination", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-git-bounded-drain-"));
    temporaryDirectories.push(directory);
    const executable = portableNodeExecutable(directory, "git");
    writeNodeSubcommand(
      directory,
      "status",
      'process.stdout.write("x".repeat(64 * 1024));',
    );
    const previousPath = process.env.PATH;
    process.env.PATH = directory;
    const terminateProcessTree = vi.fn(async () => true);
    try {
      await expect(runGit(directory, ["status"], {
        timeoutMs: 5_000,
        maxOutputBytes: 1_024,
        truncateOutput: true,
        failureMessage: "Git status failed.",
      }, {
        terminateProcessTree,
      })).resolves.toMatchObject({
        truncated: true,
      });
      expect(terminateProcessTree).not.toHaveBeenCalled();
      await waitFor("the bounded Git fixture executable to be released", async () => {
        try {
          await rename(executable, `${executable}.released`);
          return true;
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error
            ? error.code
            : undefined;
          if (code === "EBUSY" || code === "EPERM") return false;
          throw error;
        }
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it.skipIf(process.platform === "win32")(
    "removes a detached POSIX Git descendant that escaped the root process group",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "inertia-git-detached-tree-"));
      temporaryDirectories.push(directory);
      portableNodeExecutable(directory, "git");
      const pidPath = join(directory, "descendant.pid");
      writeNodeSubcommand(directory, "status", `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const descendant = spawn(
  process.execPath,
  ["-e", "setInterval(() => {}, 1000)"],
  { detached: true, stdio: "ignore" },
);
descendant.unref();
fs.writeFileSync(${JSON.stringify(pidPath)}, String(descendant.pid));
setInterval(() => {}, 1000);
`);
      const previousPath = process.env.PATH;
      process.env.PATH = directory;
      try {
        const running = runGit(directory, ["status"], {
          timeoutMs: 500,
          failureMessage: "Git status failed.",
        });
        const rejection = expect(running).rejects.toMatchObject({
          code: "timeout",
        });
        await waitFor("the detached Git descendant PID", async () => {
          try {
            return (await readFile(pidPath, "utf8")).trim().length > 0;
          } catch {
            return false;
          }
        });
        const descendantPid = Number(await readFile(pidPath, "utf8"));
        descendantPids.push(descendantPid);

        await rejection;
        expect(processExists(descendantPid)).toBe(false);
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
    },
  );
});
