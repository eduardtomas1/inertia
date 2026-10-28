import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  darwinProcessGuardianReady,
  type DarwinProcessIdentity,
} from "../../src/node/runtime-owned-processes";

const guardianPath = join(
  process.cwd(),
  "resources/generated/runtime-process-guardian/runtime-process-guardian",
);
const temporaryDirectories: string[] = [];
const liveChildren = new Set<ChildProcess>();
const livePids = new Set<number>();

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "inertia-guardian-escapees-"));
  chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}

function closeOf(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", () => resolve()));
}

function markerOf(identity: DarwinProcessIdentity): string {
  return `${identity.pid}:${identity.startTimeSeconds}.${String(identity.startTimeMicroseconds).padStart(6, "0")}`;
}

function escapees(identity: DarwinProcessIdentity, reap: boolean): { status: number | null; pids: number[] } {
  const result = spawnSync(guardianPath, [
    "escapees",
    String(identity.pid),
    identity.startTimeSeconds,
    String(identity.startTimeMicroseconds),
    ...(reap ? ["--reap"] : []),
  ], { encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, shell: false, timeout: 10_000 });
  return {
    status: result.status,
    pids: result.stdout.split("\n").filter(Boolean).map((line) => Number(line.split("|")[0])).sort((a, b) => a - b),
  };
}

function nodeScript(source: string): string[] {
  return [process.execPath, "-e", source];
}

function doubleForkPayload(directory: string): string {
  const sourcePath = join(directory, "double-fork-payload.c");
  const payloadPath = join(directory, "double-fork-payload");
  writeFileSync(sourcePath, [
    "#include <stdio.h>",
    "#include <sys/types.h>",
    "#include <unistd.h>",
    "static int write_pid(const char *path, pid_t pid) {",
    "  FILE *stream = fopen(path, \"w\");",
    "  if (!stream) return 0;",
    "  const int written = fprintf(stream, \"%d\\n\", pid) > 0;",
    "  return fclose(stream) == 0 && written;",
    "}",
    "int main(int argc, char **argv) {",
    "  if (argc != 3 || !write_pid(argv[1], getpid())) return 64;",
    "  const pid_t child = fork();",
    "  if (child < 0) return 71;",
    "  if (child > 0) for (;;) pause();",
    "  if (setsid() != getpid()) _exit(72);",
    "  const pid_t grandchild = fork();",
    "  if (grandchild < 0) _exit(73);",
    "  if (grandchild > 0) _exit(0);",
    "  if (!write_pid(argv[2], getpid())) _exit(74);",
    "  for (;;) pause();",
    "}",
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
  const built = spawnSync("/usr/bin/xcrun", [
    "clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", sourcePath, "-o", payloadPath,
  ], { encoding: "utf8", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, shell: false, timeout: 30_000 });
  expect(built.status, `${built.stderr}\n${built.stdout}`).toBe(0);
  return payloadPath;
}

async function startGuardian(
  mode: "watch" | "watch-terminal-session",
  payload: readonly string[],
): Promise<{ guardian: ChildProcess; identity: DarwinProcessIdentity }> {
  const guardian = spawn(guardianPath, [mode, String(process.pid), "--", ...payload], {
    detached: true,
    shell: false,
    stdio: "ignore",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
  liveChildren.add(guardian);
  guardian.once("close", () => liveChildren.delete(guardian));
  const pid = guardian.pid ?? 0;
  expect(pid).toBeGreaterThan(1);
  let identity: DarwinProcessIdentity | null = null;
  await expect.poll(() => {
    identity = darwinProcessGuardianReady(pid, guardianPath);
    return identity?.pid ?? 0;
  }, { timeout: 5_000 }).toBe(pid);
  process.kill(pid, "SIGUSR1");
  return { guardian, identity: identity! };
}

async function readPid(path: string): Promise<number> {
  await expect.poll(() => existsSync(path) && Number(readFileSync(path, "utf8").trim()) > 1, {
    timeout: 5_000,
  }).toBe(true);
  const pid = Number(readFileSync(path, "utf8").trim());
  livePids.add(pid);
  return pid;
}

function spawnSleeper(environment: NodeJS.ProcessEnv): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], {
    detached: true,
    shell: false,
    stdio: "ignore",
    env: environment,
  });
  child.unref();
  const pid = child.pid ?? 0;
  livePids.add(pid);
  return pid;
}

afterEach(async () => {
  for (const pid of livePids) {
    if (pid > 1 && processIsAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch { continue; }
    }
  }
  livePids.clear();
  for (const child of liveChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { continue; }
    }
  }
  await Promise.all([...liveChildren].map(closeOf));
  liveChildren.clear();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe.runIf(process.platform === "darwin")("macOS runtime process guardian escapee census", () => {
  it("marks a guarded payload with its exact guardian identity and never marks a terminal session", async () => {
    const directory = temporaryDirectory();
    const record = (path: string) => nodeScript(
      `require("node:fs").writeFileSync(${JSON.stringify(path)}, process.env.INERTIA_RUNTIME_OWNED_GUARDIAN ?? "none")`,
    );
    const guardedPath = join(directory, "guarded.txt");
    const guarded = await startGuardian("watch", record(guardedPath));
    await closeOf(guarded.guardian);
    expect(guarded.guardian.exitCode).toBe(0);
    expect(readFileSync(guardedPath, "utf8")).toBe(markerOf(guarded.identity));

    const terminalPath = join(directory, "terminal.txt");
    const terminal = await startGuardian("watch-terminal-session", record(terminalPath));
    await closeOf(terminal.guardian);
    expect(terminal.guardian.exitCode).toBe(0);
    expect(readFileSync(terminalPath, "utf8")).toBe("none");
  }, 15_000);

  it("finds and reaps only the processes that carry the exact guardian marker", async () => {
    const directory = temporaryDirectory();
    const rootPidPath = join(directory, "root.pid");
    const escapedPidPath = join(directory, "escaped.pid");
    const { guardian, identity } = await startGuardian("watch", [
      doubleForkPayload(directory), rootPidPath, escapedPidPath,
    ]);
    const rootPid = await readPid(rootPidPath);
    const escapedPid = await readPid(escapedPidPath);
    const unmarkedPid = spawnSleeper({ PATH: "/usr/bin:/bin" });
    const foreignPid = spawnSleeper({
      PATH: "/usr/bin:/bin",
      INERTIA_RUNTIME_OWNED_GUARDIAN: `${identity.pid}:${identity.startTimeSeconds}.000000x`,
    });

    expect(escapees(identity, false)).toEqual({
      status: 4,
      pids: [rootPid, escapedPid].sort((a, b) => a - b),
    });

    process.kill(guardian.pid!, "SIGTERM");
    await closeOf(guardian);
    expect(guardian.signalCode).toBe("SIGUSR2");
    await expect.poll(() => processIsAlive(rootPid)).toBe(false);
    expect(processIsAlive(escapedPid)).toBe(true);
    expect(escapees(identity, false)).toEqual({ status: 4, pids: [escapedPid] });

    expect(escapees(identity, true)).toEqual({ status: 0, pids: [] });
    await expect.poll(() => processIsAlive(escapedPid)).toBe(false);
    expect(processIsAlive(unmarkedPid)).toBe(true);
    expect(processIsAlive(foreignPid)).toBe(true);
    expect(escapees(identity, false)).toEqual({ status: 0, pids: [] });
  }, 20_000);

  it("rejects a malformed guardian identity", () => {
    for (const args of [
      ["escapees", "1", "1", "0"],
      ["escapees", "100", "0", "0"],
      ["escapees", "100", "1", "1000000"],
      ["escapees", "100", "-1", "0"],
      ["escapees", "100", "1", "0", "--kill"],
    ]) {
      expect(spawnSync(guardianPath, args, { shell: false, timeout: 5_000 }).status).toBe(64);
    }
  });
});
