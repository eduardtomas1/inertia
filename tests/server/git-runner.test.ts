import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runGit,
  settleGitInspections,
  withPreparedGitRefReservation,
  withPreparedGitRefUpdate,
} from "../../src/server/git/runner";
import { gitProcessEnvironment } from "../../src/server/git/environment";
import { GitError } from "../../src/server/git/types";
import { terminateProcessTreeAndWait } from "../../src/server/process-lifecycle";
import {
  portableNodeExecutable,
  removePortableFixture,
  waitFor,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import { executableProcessExists } from "../helpers/executable-process";

const temporaryDirectories: string[] = [];
const descendantPids: number[] = [];
const preparedTimeoutCleanups: Array<() => Promise<void>> = [];
const hostedWindowsCi =
  process.platform === "win32" && process.env.CI === "true";

afterEach(async () => {
  for (const cleanup of preparedTimeoutCleanups.splice(0)) await cleanup();
  for (const pid of descendantPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process-tree cleanup under test may already have removed it.
    }
  }
  await Promise.all(
    temporaryDirectories.splice(0).map(removePortableFixture),
  );
});

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function checkPreparedCallbackTimeout(releaseAfterTimeout: boolean): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-git-ref-timeout-"));
  temporaryDirectories.push(directory);
  portableNodeExecutable(directory, "git");
  writeNodeSubcommand(directory, "update-ref", `
process.stdin.once("data", () => {
  process.stdout.write("start: ok\\nprepare: ok\\n");
});
setInterval(() => {}, 1000);
`);
  const previousPath = process.env.PATH;
  process.env.PATH = directory;
  const started = deferred();
  const release = deferred();
  const callbackDone = deferred();
  let callbackStarted = false;
  let mutated = false;
  let outcome: Promise<{ error: unknown }> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const schedule = globalThis.setTimeout;
  let deadlineCaptured = false;
  let clockRestored = false;
  const restoreClock = () => {
    if (clockRestored) return;
    clockRestored = true;
    globalThis.setTimeout = schedule;
    vi.useRealTimers();
  };
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) => {
    if (milliseconds !== 250 || deadlineCaptured) return schedule(callback, milliseconds, ...args);
    deadlineCaptured = true;
    return schedule(() => {
      // Expire the real transaction callback at its unchanged logical deadline;
      // native process-tree cleanup then runs with real timers on every path.
      restoreClock();
      callback(...args);
    }, milliseconds);
  }) as typeof setTimeout;
  const expire = () => { if (vi.isFakeTimers()) vi.advanceTimersByTime(250); };
  const cleanup = () => cleanupPromise ??= (async () => {
    try {
      expire();
      await outcome;
      release.resolve();
      if (callbackStarted && releaseAfterTimeout) await callbackDone.promise;
    } finally {
      restoreClock();
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  })();
  preparedTimeoutCleanups.push(cleanup);
  try {
    outcome = withPreparedGitRefUpdate(
      directory, "refs/heads/main", "1".repeat(40), "0".repeat(40),
      { deadlineAt: Date.now() + 250, failureMessage: "Git ref update failed." },
      async (context) => {
        callbackStarted = true;
        started.resolve();
        if (!releaseAfterTimeout) return await new Promise<void>(() => undefined);
        try {
          await release.promise;
          context.mutate(() => { mutated = true; });
        } finally { callbackDone.resolve(); }
      },
    ).then(() => ({ error: null }), (error: unknown) => ({ error }));
    await Promise.race([
      started.promise,
      outcome.then(({ error }) => { throw error ?? new Error("Transaction settled before preparation."); }),
    ]);
    expect(deadlineCaptured).toBe(true);
    expire();
    expect((await outcome).error).toMatchObject({ code: "timeout" });
    if (releaseAfterTimeout) {
      release.resolve();
      await callbackDone.promise;
      expect(mutated).toBe(false);
    }
  } finally { await cleanup(); }
}

describe("Git inspection settlement", () => {
  it("cancels and awaits every sibling cleanup after the first rejection", async () => {
    const controller = new AbortController();
    const cleanupStarted = deferred();
    const releaseCleanup = deferred();
    let cleaningSiblings = 0;
    let aggregateSettled = false;
    let triggeringFailure: unknown;
    const statusFailure = new GitError("operation-failed", "Status parsing failed.");
    const sibling = async (signal: AbortSignal): Promise<string> => {
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      cleaningSiblings += 1;
      if (cleaningSiblings === 2) cleanupStarted.resolve();
      await releaseCleanup.promise;
      throw new GitError("timeout", "Sibling inspection was cancelled.");
    };
    const aggregate = settleGitInspections(
      controller.signal,
      async () => await Promise.reject(statusFailure),
      sibling,
      sibling,
      (reason) => { triggeringFailure = reason; },
    );
    void aggregate.then(
      () => { aggregateSettled = true; },
      () => { aggregateSettled = true; },
    );

    await cleanupStarted.promise;
    expect(aggregateSettled).toBe(false);
    expect(triggeringFailure).toBe(statusFailure);
    releaseCleanup.resolve();
    await expect(aggregate).rejects.toThrow("Status parsing failed.");
    expect(aggregateSettled).toBe(true);
  });
});

describe("Git runner locale", () => {
  it("preserves Git's EMAIL identity fallback without restoring unrelated state", () => {
    const environment = gitProcessEnvironment({
      PATH: "/usr/bin:/bin",
      EMAIL: "custom@example.test",
      GIT_CEILING_DIRECTORIES: "/workspace-boundary",
      GIT_DISCOVERY_ACROSS_FILESYSTEM: "1",
      HOME: undefined,
      GIT_CONFIG_GLOBAL: undefined,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: "Authorization: secret",
      GITHUB_TOKEN: "github-secret",
      OPENAI_API_KEY: "provider-secret",
    });

    expect(environment).toEqual({
      PATH: "/usr/bin:/bin",
      EMAIL: "custom@example.test",
      GIT_CEILING_DIRECTORIES: "/workspace-boundary",
      GIT_DISCOVERY_ACROSS_FILESYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      LANG: "C",
      LC_ALL: "C",
    });
  });

  it("preserves cross-filesystem discovery in the spawned Git environment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-git-discovery-"));
    temporaryDirectories.push(directory);
    portableNodeExecutable(directory, "git");
    writeNodeSubcommand(directory, "show-environment", `
process.stdout.write(JSON.stringify({
  discovery: process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM,
  token: process.env.GITHUB_TOKEN,
}));
`);
    const previousPath = process.env.PATH;
    process.env.PATH = directory;
    try {
      const result = await runGit(directory, ["show-environment"], {
        environment: {
          GIT_DISCOVERY_ACROSS_FILESYSTEM: "1",
          GITHUB_TOKEN: "must-not-leak",
        },
        failureMessage: "Git environment inspection failed.",
      });

      expect(JSON.parse(result.stdout.toString("utf8"))).toEqual({
        discovery: "1",
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

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

  it("does not start Git for a pre-aborted inspection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-git-pre-abort-"));
    temporaryDirectories.push(directory);
    portableNodeExecutable(directory, "git");
    const markerPath = join(directory, "started.txt");
    writeNodeSubcommand(
      directory,
      "status",
      `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "started");`,
    );
    const previousPath = process.env.PATH;
    process.env.PATH = directory;
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(runGit(directory, ["status"], {
        signal: controller.signal,
        failureMessage: "Git status failed.",
      })).rejects.toMatchObject({
        code: "timeout",
        message: "Git inspection was cancelled.",
      });
      await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("settles a ref-update timeout when a prepared callback never settles", async () => {
    await checkPreparedCallbackTimeout(false);
  });

  it("revokes delayed prepared mutations after a ref-update timeout", async () => {
    await checkPreparedCallbackTimeout(true);
  });

  it("cleans up an expired prepared callback through Git's abort handshake", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-git-ref-expired-abort-"));
    temporaryDirectories.push(directory);
    portableNodeExecutable(directory, "git");
    writeNodeSubcommand(directory, "update-ref", `
let input = "";
let prepared = false;
process.stdin.on("data", (chunk) => {
  input += chunk.toString("utf8");
  if (!prepared && input.includes("prepare\\n")) {
    prepared = true;
    process.stdout.write("start: ok\\nprepare: ok\\n");
  }
  if (prepared && input.includes("abort\\n")) {
    setTimeout(() => {
      process.stdout.write("abort: ok\\n", () => process.exit(0));
    }, 40);
  }
});
setInterval(() => {}, 1000);
`);
    const previousPath = process.env.PATH;
    process.env.PATH = directory;
    const deadlineAt = Date.now() + 500;
    let abortAcknowledged = false;
    try {
      await expect(withPreparedGitRefUpdate(
        directory,
        "refs/heads/main",
        "1".repeat(40),
        "0".repeat(40),
        {
          deadlineAt,
          failureMessage: "Git ref update failed.",
          testHooks: {
            afterFailedCallbackAbortAcknowledged: () => {
              abortAcknowledged = true;
            },
          },
        },
        () => {
          while (Date.now() <= deadlineAt + 5) {
            // Cross the deadline without yielding to its timer.
          }
        },
      )).rejects.toMatchObject({ code: "timeout" });
      expect(abortAcknowledged).toBe(true);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("allows only cleanup time for an intentional prepared reservation abort", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-git-ref-clean-abort-"));
    temporaryDirectories.push(directory);
    portableNodeExecutable(directory, "git");
    writeNodeSubcommand(directory, "update-ref", `
let input = "";
let prepared = false;
process.stdin.on("data", (chunk) => {
  input += chunk.toString("utf8");
  if (!prepared && input.includes("prepare\\n")) {
    prepared = true;
    process.stdout.write("start: ok\\nprepare: ok\\n");
  }
  if (prepared && input.includes("abort\\n")) {
    setTimeout(() => {
      process.stdout.write("abort: ok\\n", () => process.exit(0));
    }, 150);
  }
});
setInterval(() => {}, 1000);
`);
    const previousPath = process.env.PATH;
    process.env.PATH = directory;
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout"],
    });
    vi.setSystemTime(10_000);
    const deadlineAt = Date.now() + 500;
    let abortAcknowledged = false;
    try {
      await expect(withPreparedGitRefReservation(
        directory,
        "refs/heads/main",
        "1".repeat(40),
        {
          deadlineAt,
          failureMessage: "Git reservation failed.",
          testHooks: {
            afterAbortAcknowledged: () => {
              abortAcknowledged = true;
            },
          },
        },
        () => {
          vi.advanceTimersByTime(deadlineAt - Date.now() - 1);
          // The synchronous completion requests its cleanup-only abort first;
          // then only the original operation timer expires. The child owns
          // its real delayed ack while the cleanup timer retains 499ms.
          queueMicrotask(() => {
            vi.advanceTimersByTime(1);
          });
        },
      )).resolves.toBeUndefined();
      expect(abortAcknowledged).toBe(true);
      expect(Date.now()).toBe(deadlineAt);
    } finally {
      vi.useRealTimers();
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("captures a synchronous prepared result before queued microtasks cross its deadline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-git-ref-sync-deadline-"));
    temporaryDirectories.push(directory);
    portableNodeExecutable(directory, "git");
    writeNodeSubcommand(directory, "update-ref", `
let input = "";
let prepared = false;
process.stdin.on("data", (chunk) => {
  input += chunk.toString("utf8");
  if (!prepared && input.includes("prepare\\n")) {
    prepared = true;
    process.stdout.write("start: ok\\nprepare: ok\\n");
  }
  if (prepared && input.includes("abort\\n")) {
    process.stdout.write("abort: ok\\n", () => process.exit(0));
  }
});
`);
    const previousPath = process.env.PATH;
    process.env.PATH = directory;
    let now = 10_000;
    const deadlineAt = now + 500;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      await expect(withPreparedGitRefReservation(
        directory,
        "refs/heads/main",
        "1".repeat(40),
        { deadlineAt, failureMessage: "Git reservation failed." },
        () => {
          queueMicrotask(() => {
            now = deadlineAt;
          });
        },
      )).resolves.toBeUndefined();
    } finally {
      dateNow.mockRestore();
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("lets a queued abort acknowledgement beat cleanup after an event-loop stall", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-git-ref-abort-turn-"));
    temporaryDirectories.push(directory);
    portableNodeExecutable(directory, "git");
    writeNodeSubcommand(directory, "update-ref", `
require("node:fs").writeFileSync("git-abort.pid", String(process.pid));
let input = "";
let prepared = false;
process.stdin.on("data", (chunk) => {
  input += chunk.toString("utf8");
  if (!prepared && input.includes("prepare\\n")) {
    prepared = true;
    process.stdout.write("start: ok\\nprepare: ok\\n");
  }
  if (prepared && input.includes("abort\\n")) {
    setTimeout(() => {
      process.stdout.write("abort: ok\\n", () => process.exit(0));
    }, 480);
  }
});
setInterval(() => {}, 1000);
`);
    const previousPath = process.env.PATH;
    process.env.PATH = directory;
    const deadlineAt = Date.now() + (hostedWindowsCi ? 10_000 : 2_000);
    let stall: NodeJS.Timeout | undefined;
    let observedFixtureExit = false;
    const fixtureExited = (pid: number): boolean => {
      if (process.platform !== "darwin") return !executableProcessExists(pid);
      // A blocked macOS parent cannot reap its zombie yet. Observe only this
      // fixture PID, without a shell or extending the operation deadline.
      const state = spawnSync("/bin/ps", ["-p", String(pid), "-o", "stat="], {
        encoding: "utf8", maxBuffer: 1_024,
        timeout: Math.max(1, Math.min(100, deadlineAt - Date.now())),
      });
      return (state.status === 0 && state.stdout.trim().startsWith("Z"))
        || (state.status === 1 && state.stdout.trim() === "");
    };
    try {
      await expect(withPreparedGitRefReservation(
        directory,
        "refs/heads/main",
        "1".repeat(40),
        {
          // The assertion begins only after the fixture reports prepare. Give
          // hosted Windows enough time to start the copied Node executable;
          // the 480ms abort acknowledgement and 500ms cleanup race below stay
          // unchanged and remain the behavior this test proves.
          deadlineAt,
          failureMessage: "Git reservation failed.",
        },
        () => {
          const fixturePid = Number(readFileSync(join(directory, "git-abort.pid"), "utf8"));
          expect(Number.isSafeInteger(fixturePid) && fixturePid > 0).toBe(true);
          stall = setTimeout(() => {
            const releaseAt = Date.now() + 250;
            while (Date.now() < releaseAt) {
              // Queue the child's abort acknowledgement behind the due
              // cleanup timer, reproducing the Windows timers/poll race.
            }
            // An ACK does not prove the child has exited. Keep the parent
            // blocked until native exit is observable so both ACK and close
            // are ready behind the due cleanup timer when the loop resumes.
            while (Date.now() < deadlineAt) {
              if (fixtureExited(fixturePid)) {
                observedFixtureExit = true;
                break;
              }
            }
          }, 400);
        },
      )).resolves.toBeUndefined();
      expect(observedFixtureExit).toBe(true);
    } finally {
      if (stall) clearTimeout(stall);
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  }, hostedWindowsCi ? 30_000 : 15_000);

  it("terminates a Git process that acknowledges abort but does not close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-git-ref-abort-hang-"));
    temporaryDirectories.push(directory);
    portableNodeExecutable(directory, "git");
    writeNodeSubcommand(directory, "update-ref", `
let input = "";
let prepared = false;
process.stdin.on("data", (chunk) => {
  input += chunk.toString("utf8");
  if (!prepared && input.includes("prepare\\n")) {
    prepared = true;
    process.stdout.write("start: ok\\nprepare: ok\\n");
  }
  if (prepared && input.includes("abort\\n")) {
    process.stdout.write("abort: ok\\n");
  }
});
setInterval(() => {}, 1000);
`);
    const previousPath = process.env.PATH;
    process.env.PATH = directory;
    try {
      await expect(withPreparedGitRefReservation(
        directory,
        "refs/heads/main",
        "1".repeat(40),
        {
          // Avoid making the hosted runner's copied-executable cold start
          // compete with the product's ordinary 30s default. Once prepared,
          // the abort cleanup still owns the same exact 500ms boundary.
          ...(hostedWindowsCi
            ? { deadlineAt: Date.now() + 45_000 }
            : {}),
          failureMessage: "Git reservation failed.",
        },
        () => undefined,
      )).rejects.toMatchObject({ code: "operation-failed" });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  }, hostedWindowsCi ? 60_000 : 15_000);

  it.each([
    ["commit only", "commit: ok\\n"],
    ["commit and abort", "commit: ok\\nabort: ok\\n"],
  ])("rejects %s acknowledgements for an abort-only reservation", async (
    _label,
    acknowledgement,
  ) => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-git-ref-wrong-ack-"));
    temporaryDirectories.push(directory);
    portableNodeExecutable(directory, "git");
    writeNodeSubcommand(directory, "update-ref", `
let input = "";
let prepared = false;
process.stdin.on("data", (chunk) => {
  input += chunk.toString("utf8");
  if (!prepared && input.includes("prepare\\n")) {
    prepared = true;
    process.stdout.write("start: ok\\nprepare: ok\\n");
  }
  if (prepared && input.includes("abort\\n")) {
    process.stdout.write(${JSON.stringify(acknowledgement)}, () => process.exit(0));
  }
});
`);
    const previousPath = process.env.PATH;
    process.env.PATH = directory;
    let callbackRan = false;
    try {
      await expect(withPreparedGitRefReservation(
        directory,
        "refs/heads/main",
        "1".repeat(40),
        { failureMessage: "Git reservation failed." },
        () => {
          callbackRan = true;
        },
      )).rejects.toMatchObject({ code: "operation-failed" });
      expect(callbackRan).toBe(true);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("strips ambient routing and secrets while preserving explicit Git state", () => {
    const inherited = {
      PATH: "/usr/bin:/bin",
      HOME: "/tmp/home",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/dbus",
      SSH_AGENT_PID: "4242",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      USERNAME: "twin",
      XDG_CACHE_HOME: "/tmp/cache",
      GCM_INTERACTIVE: "never",
      GIT_EDITOR: "/usr/bin/nvim",
      GIT_PAGER: "/usr/bin/less",
      GIT_SEQUENCE_EDITOR: "/usr/bin/nvim -f",
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
      SSH_AGENT_PID: "4242",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      USERNAME: "twin",
      XDG_CACHE_HOME: "/tmp/cache",
      GCM_INTERACTIVE: "never",
      GIT_EDITOR: "/usr/bin/nvim",
      GIT_PAGER: "/usr/bin/less",
      GIT_SEQUENCE_EDITOR: "/usr/bin/nvim -f",
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
        // The process exit status travels with the classified error so a
        // diagnostics incident can record it without the message or stderr.
        exitCode: 128,
      } satisfies Partial<GitError>);
    } finally {
      if (previousLang === undefined) delete process.env.LANG;
      else process.env.LANG = previousLang;
      if (previousLocale === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = previousLocale;
    }
  });

  it("removes Git descendants before an aborted inspection settles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-git-abort-tree-"));
    const executableDirectory = await mkdtemp(join(
      tmpdir(),
      "inertia-git-abort-tree-bin-",
    ));
    temporaryDirectories.push(directory);
    temporaryDirectories.push(executableDirectory);
    portableNodeExecutable(executableDirectory, "git");
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
setInterval(() => {}, 1000);
`);
    const previousPath = process.env.PATH;
    process.env.PATH = executableDirectory;
    try {
      const controller = new AbortController();
      const running = runGit(directory, ["status"], {
        signal: controller.signal,
        timeoutMs: 5_000,
        failureMessage: "Git status failed.",
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

      controller.abort();
      await expect(running).rejects.toMatchObject({
        code: "timeout",
        message: "Git inspection was cancelled.",
      } satisfies Partial<GitError>);
      await waitFor(
        "the aborted Git descendant to stop",
        () => !executableProcessExists(descendantPid),
      );
      await rm(directory, { force: true, recursive: true });
      temporaryDirectories.splice(temporaryDirectories.indexOf(directory), 1);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("lets an already-finishing Git inspection close before abort cleanup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-git-abort-drain-"));
    temporaryDirectories.push(directory);
    portableNodeExecutable(directory, "git");
    const readyPath = join(directory, "ready.txt");
    const releasePath = join(directory, "release.txt");
    writeNodeSubcommand(directory, "status", `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(readyPath)}, "ready");
const releasePoll = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(releasePath)})) return;
  clearInterval(releasePoll);
}, 1);
`);
    const previousPath = process.env.PATH;
    process.env.PATH = directory;
    const terminateProcessTree = vi.fn(async () => true);
    try {
      const controller = new AbortController();
      const running = runGit(directory, ["status"], {
        signal: controller.signal,
        timeoutMs: 5_000,
        failureMessage: "Git status failed.",
      }, {
        terminateProcessTree,
      });
      const cancellation = expect(running).rejects.toMatchObject({
        code: "timeout",
        message: "Git inspection was cancelled.",
      } satisfies Partial<GitError>);
      await waitFor("the finishing Git inspection", async () => {
        try {
          return (await readFile(readyPath, "utf8")) === "ready";
        } catch {
          return false;
        }
      });

      controller.abort();
      await writeFile(releasePath, "release");

      await cancellation;
      expect(terminateProcessTree).not.toHaveBeenCalled();
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
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
        () => !executableProcessExists(descendantPid),
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

  it("rejects a naturally failing Git inspection after bounded output is truncated", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-git-bounded-failure-"));
    temporaryDirectories.push(directory);
    portableNodeExecutable(directory, "git");
    writeNodeSubcommand(
      directory,
      "status",
      `process.stdout.write("x".repeat(64 * 1024), () => {
  process.stderr.write("fatal: bounded inspection failed\\n");
  process.exit(128);
});`,
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
      })).rejects.toMatchObject({
        code: "operation-failed",
        message: "Git status failed.",
      } satisfies Partial<GitError>);
      expect(terminateProcessTree).not.toHaveBeenCalled();
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("preserves an abort that arrives during bounded-output termination", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-git-bounded-abort-"));
    temporaryDirectories.push(directory);
    portableNodeExecutable(directory, "git");
    writeNodeSubcommand(
      directory,
      "status",
      'process.stdout.write("x".repeat(64 * 1024)); setInterval(() => {}, 1000);',
    );
    const previousPath = process.env.PATH;
    process.env.PATH = directory;
    let allowTermination!: () => void;
    const terminationGate = new Promise<void>((resolve) => {
      allowTermination = resolve;
    });
    const terminateProcessTree = vi.fn(async (child, force) => {
      await terminationGate;
      return terminateProcessTreeAndWait(child, force);
    });
    try {
      const controller = new AbortController();
      const running = runGit(directory, ["status"], {
        signal: controller.signal,
        timeoutMs: 5_000,
        maxOutputBytes: 1_024,
        truncateOutput: true,
        failureMessage: "Git status failed.",
      }, {
        terminateProcessTree,
      });

      await waitFor(
        "bounded-output process-tree termination to start",
        () => terminateProcessTree.mock.calls.length === 1,
      );
      controller.abort();
      allowTermination();

      await expect(running).rejects.toMatchObject({
        code: "timeout",
        message: "Git inspection was cancelled.",
      } satisfies Partial<GitError>);
      expect(terminateProcessTree).toHaveBeenCalledTimes(1);
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
        expect(executableProcessExists(descendantPid)).toBe(false);
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }
    },
  );
});

describe("Git workflow failure guidance", () => {
  it.each([
    ["[rejected] main -> main (non-fast-forward)", "Fetch, then reconcile"],
    ["Could not resolve host: private.invalid", "network connection"],
    ["Unable to create index.lock: File exists", "index lock"],
    ["fatal: branch is already used by worktree at private-path", "another worktree"],
    ["Author identity unknown", "user.name and user.email"],
  ])("classifies %s without returning raw stderr", async (stderr, expected) => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-git-error-"));
    temporaryDirectories.push(directory);
    portableNodeExecutable(directory, "git");
    writeNodeSubcommand(directory, "emit-error", `
process.stderr.write(${JSON.stringify(stderr)} + " credential-must-stay-private");
process.exitCode = 1;
`);
    try {
      await runGit(directory, ["emit-error"], {
        environment: { PATH: directory },
        failureMessage: "Git failed.",
      });
      expect.fail("The failing Git command must reject.");
    } catch (error) {
      expect(error).toBeInstanceOf(GitError);
      expect((error as Error).message).toContain(expected);
      expect((error as Error).message).not.toContain("credential-must-stay-private");
      expect((error as Error).message).not.toContain("private-path");
    }
  });
});
