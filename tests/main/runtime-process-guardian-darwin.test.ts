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
import { setTimeout as sleep } from "node:timers/promises";

import { spawn as spawnPty } from "node-pty";
import { afterEach, describe, expect, it } from "vitest";

import {
  confirmRuntimeOwnedProcessStopped,
  darwinProcessGuardianReady,
  darwinProcessGuardianReadyAsync,
  runtimeOwnedProcessInvocation,
  runtimeOwnedTerminalSessionInvocation,
  RuntimeOwnedProcessJournal,
  spawnRuntimeOwnedPidProcess,
  spawnRuntimeOwnedProcess,
} from "../../src/node/runtime-owned-processes";
import { activatePreparedRuntimeOwnedProcessRegistry as activateRuntimeOwnedProcessRegistry } from
  "../helpers/prepared-runtime-owned-process-registry";

const systemBootId = "test:10000000-0000-4000-8000-000000000001";
const runtimeGenerationId = "20000000-0000-4000-8000-000000000002:1";
const temporaryDirectories: string[] = [];
const liveChildren = new Set<ChildProcess>();
const deactivators: Array<() => void> = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "inertia-owned-process-"));
  chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}

function activate(directory: string): void {
  const deactivate = activateRuntimeOwnedProcessRegistry(
    directory,
    runtimeGenerationId,
    systemBootId,
    {
      darwinGuardianPath: join(
        process.cwd(),
        "resources/generated/runtime-process-guardian/runtime-process-guardian",
      ),
    },
  );
  if (deactivate) deactivators.push(deactivate);
}

function buildDarwinGuardian(
  directory: string,
  name: string,
  defines: readonly string[],
): string {
  const guardianPath = join(directory, name);
  const built = spawnSync("/usr/bin/xcrun", [
    "clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
    ...defines,
    join(process.cwd(), "native/runtime-process-guardian/darwin.c"),
    "-o", guardianPath,
  ], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    shell: false,
    timeout: 30_000,
  });
  expect(built.status, `${built.stderr}\n${built.stdout}`).toBe(0);
  return guardianPath;
}

function closeOf(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once("close", () => resolve()));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error
      && typeof error === "object"
      && "code" in error
      && error.code === "ESRCH"
    );
  }
}

afterEach(async () => {
  while (deactivators.length > 0) deactivators.pop()?.();
  for (const child of liveChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* Already gone. */ }
    }
  }
  await Promise.all([...liveChildren].map(closeOf));
  liveChildren.clear();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("macOS runtime process guardian", () => {
  it.runIf(process.platform === "darwin")(
    "retires an immediate PTY stop without a pre-fork machine census",
    async () => {
      const directory = temporaryDirectory();
      const guardianPath = join(directory, "runtime-process-guardian-no-early-census");
      const built = spawnSync("/usr/bin/xcrun", [
        "clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
        "-DINERTIA_RUNTIME_GUARDIAN_TEST_REJECT_EARLY_CENSUS=1",
        join(process.cwd(), "native/runtime-process-guardian/darwin.c"),
        "-o", guardianPath,
      ], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        shell: false,
        timeout: 30_000,
      });
      expect(built.status, `${built.stderr}\n${built.stdout}`).toBe(0);
      const deactivate = activateRuntimeOwnedProcessRegistry(
        directory,
        runtimeGenerationId,
        systemBootId,
        { darwinGuardianPath: guardianPath },
      );
      if (deactivate) deactivators.push(deactivate);
      const invocation = runtimeOwnedTerminalSessionInvocation("/bin/sleep", ["8"]);
      const owned = spawnRuntimeOwnedPidProcess(() => spawnPty(
        invocation.command,
        invocation.args,
        { cwd: directory, env: { PATH: "/usr/bin:/bin" } },
      ), { darwinGuardianCommand: invocation.command });
      const exited = new Promise<{ exitCode: number; signal: number | undefined }>(
        (resolve) => {
          owned.process.onExit((event) => {
            owned.releaseIfGroupExited(event.signal);
            resolve({ exitCode: event.exitCode, signal: event.signal });
          });
        },
      );

      expect(owned.requestGuardianStop()).toBe(true);
      await expect(owned.waitForGuardianStop()).resolves.toBe(true);
      await expect(exited).resolves.toEqual({ exitCode: 137, signal: 0 });
      await expect.poll(() => owned.confirmStopped()).toBe(true);
      expect(new RuntimeOwnedProcessJournal(directory, {
        platform: "darwin",
        darwinGuardianPath: guardianPath,
      }).records(runtimeGenerationId)).toEqual([]);
    },
    15_000,
  );

  it.runIf(process.platform === "darwin")(
    "falls back to the exact kernel identity during a strict PTY stop",
    async () => {
      const directory = temporaryDirectory();
      const guardianPath = buildDarwinGuardian(
        directory,
        "runtime-process-guardian-kernel-identity-fallback",
        [
          "-DINERTIA_RUNTIME_GUARDIAN_TEST_FORCE_LIBPROC_IDENTITY_FAILURE_DURING_STOP=1",
        ],
      );
      const deactivate = activateRuntimeOwnedProcessRegistry(
        directory,
        runtimeGenerationId,
        systemBootId,
        { darwinGuardianPath: guardianPath },
      );
      if (deactivate) deactivators.push(deactivate);
      const invocation = runtimeOwnedTerminalSessionInvocation("/bin/sleep", ["8"]);
      const owned = spawnRuntimeOwnedPidProcess(() => spawnPty(
        invocation.command,
        invocation.args,
        { cwd: directory, env: { PATH: "/usr/bin:/bin" } },
      ), { darwinGuardianCommand: invocation.command });
      const exited = new Promise<{ exitCode: number; signal: number | undefined }>(
        (resolve) => {
          owned.process.onExit((event) => {
            owned.releaseIfGroupExited(event.signal);
            resolve({ exitCode: event.exitCode, signal: event.signal });
          });
        },
      );

      await expect(owned.waitForGuardianStop()).resolves.toBe(true);
      expect(owned.requestGuardianStop()).toBe(true);
      await expect(owned.waitForGuardianStop()).resolves.toBe(true);
      await expect(exited).resolves.toEqual({ exitCode: 137, signal: 0 });
      await expect.poll(() => owned.confirmStopped()).toBe(true);
      expect(new RuntimeOwnedProcessJournal(directory, {
        platform: "darwin",
        darwinGuardianPath: guardianPath,
      }).records(runtimeGenerationId)).toEqual([]);
    },
    15_000,
  );

  it.runIf(process.platform === "darwin")(
    "retains the ownership claim when both exact identity sources fail",
    async () => {
      const directory = temporaryDirectory();
      const guardianPath = buildDarwinGuardian(
        directory,
        "runtime-process-guardian-unreadable-identities",
        [
          "-DINERTIA_RUNTIME_GUARDIAN_TEST_FORCE_LIBPROC_IDENTITY_FAILURE_DURING_STOP=1",
          "-DINERTIA_RUNTIME_GUARDIAN_TEST_FORCE_KERNEL_IDENTITY_FAILURE_DURING_STOP=1",
        ],
      );
      const deactivate = activateRuntimeOwnedProcessRegistry(
        directory,
        runtimeGenerationId,
        systemBootId,
        { darwinGuardianPath: guardianPath },
      );
      if (deactivate) deactivators.push(deactivate);
      const invocation = runtimeOwnedTerminalSessionInvocation("/bin/sleep", ["8"]);
      const owned = spawnRuntimeOwnedPidProcess(() => spawnPty(
        invocation.command,
        invocation.args,
        { cwd: directory, env: { PATH: "/usr/bin:/bin" } },
      ), { darwinGuardianCommand: invocation.command });
      const exited = new Promise<{ exitCode: number; signal: number | undefined }>(
        (resolve) => {
          owned.process.onExit((event) => {
            owned.releaseIfGroupExited(event.signal);
            resolve({ exitCode: event.exitCode, signal: event.signal });
          });
        },
      );

      await expect(owned.waitForGuardianStop()).resolves.toBe(true);
      try {
        expect(owned.requestGuardianStop()).toBe(true);
        await expect(owned.waitForGuardianStop()).resolves.toBe(true);
        await expect(exited).resolves.toEqual({ exitCode: 0, signal: 31 });
        expect(owned.confirmStopped()).toBe(false);
        expect(new RuntimeOwnedProcessJournal(directory, {
          platform: "darwin",
          darwinGuardianPath: guardianPath,
        }).records(runtimeGenerationId)).toHaveLength(1);
      } finally {
        try { process.kill(-owned.process.pid, "SIGKILL"); } catch {
          // The guardian or its payload may already have exited.
        }
      }
    },
    15_000,
  );

  it.runIf(process.platform === "darwin")(
    "maps the exact live-process identity through KERN_PROC_PID",
    async () => {
      const directory = temporaryDirectory();
      const fallbackGuardianPath = buildDarwinGuardian(
        directory,
        "runtime-process-guardian-kernel-identity",
        ["-DINERTIA_RUNTIME_GUARDIAN_TEST_FORCE_KERNEL_IDENTITY=1"],
      );
      const guardianPath = join(
        process.cwd(),
        "resources/generated/runtime-process-guardian/runtime-process-guardian",
      );
      const probe = spawn("/bin/sleep", ["8"], {
        detached: true,
        shell: false,
        stdio: "ignore",
      });
      liveChildren.add(probe);
      probe.once("close", () => liveChildren.delete(probe));
      const probePid = probe.pid ?? 0;
      expect(probePid).toBeGreaterThan(1);
      try {
        const readPrimaryIdentity = () => spawnSync(
          guardianPath,
          ["identity", String(probePid)],
          { encoding: "utf8", shell: false, timeout: 5_000 },
        );
        let primary = readPrimaryIdentity();
        for (let attempt = 1; primary.status === 2 && attempt < 50; attempt += 1) {
          await sleep(10);
          primary = readPrimaryIdentity();
        }
        const fallback = spawnSync(
          fallbackGuardianPath,
          ["identity", String(probePid)],
          { encoding: "utf8", shell: false, timeout: 5_000 },
        );
        expect(primary.status, primary.stderr).toBe(0);
        expect(fallback.status, fallback.stderr).toBe(0);
        expect(fallback.stdout.trim()).toBe(primary.stdout.trim());
      } finally {
        probe.kill("SIGKILL");
        await closeOf(probe);
      }
    },
    15_000,
  );

  it.runIf(process.platform === "darwin")(
    "rejects incomplete KERN_PROC_PID birth identities",
    async () => {
      const directory = temporaryDirectory();
      const probe = spawn("/bin/sleep", ["8"], {
        shell: false,
        stdio: "ignore",
      });
      liveChildren.add(probe);
      probe.once("close", () => liveChildren.delete(probe));
      const probePid = probe.pid ?? 0;
      expect(probePid).toBeGreaterThan(1);
      try {
        for (const [name, invalidIdentity] of [
          ["zero-start", "-DINERTIA_RUNTIME_GUARDIAN_TEST_FORCE_KERNEL_ZERO_START=1"],
          ["sidl", "-DINERTIA_RUNTIME_GUARDIAN_TEST_FORCE_KERNEL_SIDL=1"],
        ] as const) {
          const guardianPath = buildDarwinGuardian(
            directory,
            `runtime-process-guardian-kernel-${name}`,
            [
              "-DINERTIA_RUNTIME_GUARDIAN_TEST_FORCE_KERNEL_IDENTITY=1",
              invalidIdentity,
            ],
          );
          const identity = spawnSync(
            guardianPath,
            ["identity", String(probePid)],
            { encoding: "utf8", shell: false, timeout: 5_000 },
          );
          expect(identity.status, identity.stderr).toBe(2);
          expect(identity.stdout).toBe("");
        }
      } finally {
        probe.kill("SIGKILL");
        await closeOf(probe);
      }
    },
    15_000,
  );

  it.runIf(process.platform === "darwin")(
    "retires pre-fork parent loss without a machine census",
    async () => {
      const directory = temporaryDirectory();
      const guardianPath = join(directory, "runtime-process-guardian-parent-loss");
      const payloadMarkerPath = join(directory, "payload-started");
      const built = spawnSync("/usr/bin/xcrun", [
        "clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
        "-DINERTIA_RUNTIME_GUARDIAN_TEST_REJECT_EARLY_CENSUS=1",
        join(process.cwd(), "native/runtime-process-guardian/darwin.c"),
        "-o", guardianPath,
      ], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        shell: false,
        timeout: 30_000,
      });
      expect(built.status, `${built.stderr}\n${built.stdout}`).toBe(0);
      const runtimeParent = spawn("/bin/sleep", ["8"], {
        shell: false,
        stdio: "ignore",
      });
      liveChildren.add(runtimeParent);
      runtimeParent.once("close", () => liveChildren.delete(runtimeParent));
      const runtimePid = runtimeParent.pid ?? 0;
      expect(runtimePid).toBeGreaterThan(1);
      const guardian = spawn(guardianPath, [
        "watch-terminal-session",
        String(runtimePid),
        "--",
        "/usr/bin/touch",
        payloadMarkerPath,
      ], { detached: true, shell: false, stdio: "ignore" });
      liveChildren.add(guardian);
      guardian.once("close", () => liveChildren.delete(guardian));
      const guardianPid = guardian.pid ?? 0;
      expect(guardianPid).toBeGreaterThan(1);

      await expect(darwinProcessGuardianReadyAsync(
        guardianPid,
        guardianPath,
      )).resolves.toMatchObject({ pid: guardianPid, sessionId: guardianPid });
      runtimeParent.kill("SIGTERM");
      await closeOf(runtimeParent);
      await closeOf(guardian);

      expect(guardian.exitCode).toBe(137);
      expect(guardian.signalCode).toBeNull();
      expect(existsSync(payloadMarkerPath)).toBe(false);
    },
    15_000,
  );

  it.runIf(process.platform === "darwin")(
    "retires a terminal session with an unreaped helper zombie",
    async () => {
      const directory = temporaryDirectory();
      const payloadSourcePath = join(directory, "terminal-zombie-payload.c");
      const payloadPath = join(directory, "terminal-zombie-payload");
      const helperPidPath = join(directory, "helper.pid");
      writeFileSync(payloadSourcePath, [
        "#include <stdio.h>",
        "#include <sys/types.h>",
        "#include <unistd.h>",
        "int main(int argc, char **argv) {",
        "  if (argc != 2) return 64;",
        "  const pid_t helper = fork();",
        "  if (helper < 0) return 71;",
        "  if (helper == 0) _exit(0);",
        "  FILE *stream = fopen(argv[1], \"w\");",
        "  if (!stream) return 72;",
        "  const int written = fprintf(stream, \"%d\\n\", helper) > 0;",
        "  if (fclose(stream) != 0 || !written) return 73;",
        "  for (;;) pause();",
        "}",
      ].join("\n"), { encoding: "utf8", mode: 0o600 });
      const built = spawnSync("/usr/bin/xcrun", [
        "clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
        payloadSourcePath, "-o", payloadPath,
      ], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        shell: false,
        timeout: 30_000,
      });
      expect(built.status, `${built.stderr}\n${built.stdout}`).toBe(0);
      const guardianPath = buildDarwinGuardian(
        directory,
        "runtime-process-guardian-zombie-identity-failure",
        [
          "-DINERTIA_RUNTIME_GUARDIAN_TEST_FORCE_ZOMBIE_IDENTITY_FAILURE_DURING_STOP=1",
        ],
      );
      const deactivate = activateRuntimeOwnedProcessRegistry(
        directory,
        runtimeGenerationId,
        systemBootId,
        { darwinGuardianPath: guardianPath },
      );
      if (deactivate) deactivators.push(deactivate);
      const invocation = runtimeOwnedTerminalSessionInvocation(
        payloadPath,
        [helperPidPath],
      );
      const owned = spawnRuntimeOwnedPidProcess(() => spawnPty(
        invocation.command,
        invocation.args,
        { cwd: directory, env: { PATH: "/usr/bin:/bin" } },
      ), { darwinGuardianCommand: invocation.command });
      const exited = new Promise<{ exitCode: number; signal: number | undefined }>(
        (resolve) => {
          owned.process.onExit((event) => {
            owned.releaseIfGroupExited(event.signal);
            resolve({ exitCode: event.exitCode, signal: event.signal });
          });
        },
      );
      try {
        await expect(owned.waitForGuardianStop()).resolves.toBe(true);
        let helperPid = 0;
        await expect.poll(() => {
          if (existsSync(helperPidPath)) {
            helperPid = Number(readFileSync(helperPidPath, "utf8").trim());
          }
          if (helperPid <= 1) return "";
          return spawnSync("/bin/ps", ["-o", "state=", "-p", String(helperPid)], {
            encoding: "utf8",
            shell: false,
          }).stdout.trim();
        }, { timeout: 5_000 }).toMatch(/^Z/u);

        expect(owned.requestGuardianStop()).toBe(true);
        await expect(exited).resolves.toEqual({ exitCode: 137, signal: 0 });
        await expect.poll(() => owned.confirmStopped()).toBe(true);
        expect(new RuntimeOwnedProcessJournal(directory, {
          platform: "darwin",
          darwinGuardianPath: guardianPath,
        }).records(runtimeGenerationId)).toEqual([]);
      } finally {
        if (!owned.confirmStopped()) {
          try { process.kill(-owned.process.pid, "SIGKILL"); } catch {
            // The failed guardian may already have drained its session.
          }
        }
      }
    },
    15_000,
  );

  it.runIf(process.platform === "darwin")(
    "admits a guardian whose readiness is scheduler-delayed beyond 1.5 seconds",
    async () => {
      const directory = temporaryDirectory();
      const guardianPath = join(directory, "runtime-process-guardian-delayed-ready");
      const built = spawnSync("/usr/bin/xcrun", [
        "clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
        "-DINERTIA_RUNTIME_GUARDIAN_TEST_READY_DELAY=1",
        join(process.cwd(), "native/runtime-process-guardian/darwin.c"),
        "-o", guardianPath,
      ], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        shell: false,
        timeout: 30_000,
      });
      expect(built.status, `${built.stderr}\n${built.stdout}`).toBe(0);
      const guardian = spawn(guardianPath, [
        "watch",
        String(process.pid),
        "--",
        "/bin/sleep",
        "8",
      ], { detached: true, shell: false, stdio: "ignore" });
      liveChildren.add(guardian);
      guardian.once("close", () => liveChildren.delete(guardian));
      const guardianPid = guardian.pid ?? 0;
      expect(guardianPid).toBeGreaterThan(1);

      const startedAt = Date.now();
      await expect(darwinProcessGuardianReadyAsync(
        guardianPid,
        guardianPath,
      )).resolves.toMatchObject({ pid: guardianPid, sessionId: guardianPid });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_500);
      guardian.kill("SIGTERM");
      await closeOf(guardian);
    },
    15_000,
  );

  it.runIf(process.platform === "darwin")(
    "retires an exact payload on the authenticated graceful request",
    async () => {
      const directory = temporaryDirectory();
      const guardianPath = join(
        process.cwd(),
        "resources/generated/runtime-process-guardian/runtime-process-guardian",
      );
      activate(directory);
      const invocation = runtimeOwnedProcessInvocation("/bin/sleep", ["8"]);
      const owned = spawnRuntimeOwnedPidProcess(() => {
        const child = spawn(invocation.command, invocation.args, {
          detached: true,
          shell: false,
          stdio: "ignore",
        });
        if (!child.pid) throw new Error("Guardian did not publish its PID");
        return child as ChildProcess & { readonly pid: number };
      }, { darwinGuardianCommand: invocation.command });
      const guardian = owned.process;
      liveChildren.add(guardian);
      guardian.once("close", () => liveChildren.delete(guardian));

      await expect(owned.waitForGuardianStop()).resolves.toBe(true);
      expect(owned.requestPayloadExit?.()).toBe(true);
      await closeOf(guardian);

      expect(guardian.exitCode).toBe(128 + 1);
      expect(guardian.signalCode).toBeNull();
      owned.releaseIfGroupExited(0);
      await expect.poll(() => owned.confirmStopped()).toBe(true);
      expect(new RuntimeOwnedProcessJournal(directory, {
        platform: "darwin",
        darwinGuardianPath: guardianPath,
      }).records(runtimeGenerationId)).toEqual([]);
    },
    15_000,
  );

  it.runIf(process.platform === "darwin")(
    "applies a graceful request received in the payload pre-exec window",
    async () => {
      const directory = temporaryDirectory();
      const guardianPath = join(directory, "runtime-process-guardian-preexec");
      const preexecMarkerPath = join(directory, "preexec-ready");
      const markerPath = join(directory, "payload-started");
      const built = spawnSync("/usr/bin/xcrun", [
        "clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
        "-DINERTIA_RUNTIME_GUARDIAN_TEST_PREEXEC_DELAY=1",
        join(process.cwd(), "native/runtime-process-guardian/darwin.c"),
        "-o", guardianPath,
      ], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        shell: false,
        timeout: 30_000,
      });
      expect(built.status, `${built.stderr}\n${built.stdout}`).toBe(0);
      const deactivate = activateRuntimeOwnedProcessRegistry(
        directory, runtimeGenerationId, systemBootId, { darwinGuardianPath: guardianPath },
      );
      if (deactivate) deactivators.push(deactivate);
      const invocation = runtimeOwnedProcessInvocation(
        "/usr/bin/touch", [markerPath],
      );
      const owned = spawnRuntimeOwnedPidProcess(() => {
        const child = spawn(invocation.command, invocation.args, {
          detached: true,
          env: {
            ...process.env,
            INERTIA_RUNTIME_GUARDIAN_TEST_PREEXEC_MARKER: preexecMarkerPath,
          },
          shell: false,
          stdio: "ignore",
        });
        if (!child.pid) throw new Error("Guardian did not publish its PID");
        return child as ChildProcess & { readonly pid: number };
      }, { darwinGuardianCommand: invocation.command });
      const guardian = owned.process;
      liveChildren.add(guardian);
      guardian.once("close", () => liveChildren.delete(guardian));

      await expect(owned.waitForGuardianStop()).resolves.toBe(true);
      await expect.poll(() => existsSync(preexecMarkerPath)).toBe(true);
      expect(owned.requestPayloadExit?.()).toBe(true);
      await closeOf(guardian);

      expect(guardian.exitCode).toBe(128 + 1);
      expect(guardian.signalCode).toBeNull();
      expect(existsSync(markerPath)).toBe(false);
      owned.releaseIfGroupExited(0);
      await expect.poll(() => owned.confirmStopped()).toBe(true);
    },
    15_000,
  );

  it.runIf(process.platform === "darwin")(
    "releases an exact blocked root without a pre-exec machine census",
    async () => {
      const directory = temporaryDirectory();
      const guardianPath = join(directory, "runtime-process-guardian-no-preexec-census");
      const markerPath = join(directory, "payload-started");
      const built = spawnSync("/usr/bin/xcrun", [
        "clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
        "-DINERTIA_RUNTIME_GUARDIAN_TEST_REJECT_PREEXEC_CENSUS=1",
        join(process.cwd(), "native/runtime-process-guardian/darwin.c"),
        "-o", guardianPath,
      ], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        shell: false,
        timeout: 30_000,
      });
      expect(built.status, `${built.stderr}\n${built.stdout}`).toBe(0);
      const deactivate = activateRuntimeOwnedProcessRegistry(
        directory, runtimeGenerationId, systemBootId, { darwinGuardianPath: guardianPath },
      );
      if (deactivate) deactivators.push(deactivate);
      const invocation = runtimeOwnedProcessInvocation(
        "/usr/bin/touch", [markerPath],
      );
      const owned = spawnRuntimeOwnedPidProcess(() => {
        const child = spawn(invocation.command, invocation.args, {
          detached: true,
          shell: false,
          stdio: "ignore",
        });
        if (!child.pid) throw new Error("Guardian did not publish its PID");
        return child as ChildProcess & { readonly pid: number };
      }, { darwinGuardianCommand: invocation.command });
      const guardian = owned.process;
      liveChildren.add(guardian);
      guardian.once("close", () => liveChildren.delete(guardian));

      await expect(owned.waitForGuardianStop()).resolves.toBe(true);
      await closeOf(guardian);

      expect(guardian.exitCode).toBe(0);
      expect(guardian.signalCode).toBeNull();
      expect(existsSync(markerPath)).toBe(true);
      owned.releaseIfGroupExited(0);
      await expect.poll(() => owned.confirmStopped()).toBe(true);
    },
    15_000,
  );

  it.runIf(process.platform === "darwin")(
    "keeps graceful fork-tainted cleanup fail closed",
    async () => {
      const directory = temporaryDirectory();
      const payloadSourcePath = join(directory, "double-fork-payload.c");
      const payloadPath = join(directory, "double-fork-payload");
      const rootPidPath = join(directory, "root.pid");
      const escapedPidPath = join(directory, "escaped.pid");
      writeFileSync(payloadSourcePath, [
        "#include <signal.h>",
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
      const built = spawnSync(
        "/usr/bin/xcrun",
        [
          "clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
          payloadSourcePath, "-o", payloadPath,
        ],
        {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
          shell: false,
          timeout: 30_000,
        },
      );
      expect(built.status, `${built.stderr}\n${built.stdout}`).toBe(0);

      const guardianPath = join(
        process.cwd(),
        "resources/generated/runtime-process-guardian/runtime-process-guardian",
      );
      activate(directory);
      const invocation = runtimeOwnedProcessInvocation(
        payloadPath,
        [rootPidPath, escapedPidPath],
      );
      const owned = spawnRuntimeOwnedPidProcess(() => {
        const child = spawn(invocation.command, invocation.args, {
          detached: true,
          shell: false,
          stdio: "ignore",
        });
        if (!child.pid) throw new Error("Guardian did not publish its PID");
        return child as ChildProcess & { readonly pid: number };
      }, { darwinGuardianCommand: invocation.command });
      const guardian = owned.process;
      liveChildren.add(guardian);
      guardian.once("close", () => liveChildren.delete(guardian));

      let rootPid = 0;
      let escapedPid = 0;
      await expect(owned.waitForGuardianStop()).resolves.toBe(true);
      await expect.poll(() => {
        if (existsSync(rootPidPath)) {
          rootPid = Number(readFileSync(rootPidPath, "utf8").trim());
        }
        if (existsSync(escapedPidPath)) {
          escapedPid = Number(readFileSync(escapedPidPath, "utf8").trim());
        }
        return rootPid > 1 && escapedPid > 1;
      }, { timeout: 5_000 }).toBe(true);
      try {
        expect(owned.requestPayloadExit?.()).toBe(true);
        await closeOf(guardian);

        expect(guardian.exitCode).toBeNull();
        expect(guardian.signalCode).toBe("SIGUSR2");
        expect(processIsAlive(rootPid)).toBe(false);
        expect(processIsAlive(escapedPid)).toBe(true);
        owned.releaseIfGroupExited(1);
        expect(owned.confirmStopped()).toBe(false);
        expect(new RuntimeOwnedProcessJournal(directory, {
          platform: "darwin",
          darwinGuardianPath: guardianPath,
        }).records(runtimeGenerationId)).toHaveLength(1);
      } finally {
        for (const pid of [rootPid, escapedPid]) {
          if (pid <= 1 || !processIsAlive(pid)) continue;
          try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
        }
        await Promise.all([rootPid, escapedPid]
          .filter((pid) => pid > 1)
          .map(async (pid) => await expect.poll(() => !processIsAlive(pid), {
            timeout: 5_000,
          }).toBe(true)));
      }
    },
    15_000,
  );

  it.runIf(process.platform === "darwin")(
    "drains a user terminal session while leaving an escaped daemon outside its scope",
    async () => {
      const directory = temporaryDirectory();
      const payloadSourcePath = join(directory, "terminal-session-payload.c");
      const payloadPath = join(directory, "terminal-session-payload");
      const rootPidPath = join(directory, "root.pid");
      const sessionChildPidPath = join(directory, "session-child.pid");
      const escapedPidPath = join(directory, "escaped.pid");
      writeFileSync(payloadSourcePath, [
        "#include <signal.h>",
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
        "  if (argc != 4 || !write_pid(argv[1], getpid())) return 64;",
        "  const pid_t session_child = fork();",
        "  if (session_child < 0) return 71;",
        "  if (session_child == 0) for (;;) pause();",
        "  if (!write_pid(argv[2], session_child)) return 75;",
        "  const pid_t child = fork();",
        "  if (child < 0) return 76;",
        "  if (child > 0) for (;;) pause();",
        "  if (setsid() != getpid()) _exit(72);",
        "  const pid_t grandchild = fork();",
        "  if (grandchild < 0) _exit(73);",
        "  if (grandchild > 0) _exit(0);",
        "  if (!write_pid(argv[3], getpid())) _exit(74);",
        "  for (;;) pause();",
        "}",
      ].join("\n"), { encoding: "utf8", mode: 0o600 });
      const built = spawnSync(
        "/usr/bin/xcrun",
        [
          "clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
          payloadSourcePath, "-o", payloadPath,
        ],
        {
          encoding: "utf8",
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
          shell: false,
          timeout: 30_000,
        },
      );
      expect(built.status, `${built.stderr}\n${built.stdout}`).toBe(0);

      const guardianPath = join(
        process.cwd(),
        "resources/generated/runtime-process-guardian/runtime-process-guardian",
      );
      activate(directory);
      const owned = spawnRuntimeOwnedPidProcess(() => {
        const child = spawn(guardianPath, [
          "watch-terminal-session",
          String(process.pid),
          "--",
          payloadPath,
          rootPidPath,
          sessionChildPidPath,
          escapedPidPath,
        ], {
          detached: true,
          shell: false,
          stdio: "ignore",
        });
        if (!child.pid) throw new Error("Guardian did not publish its PID");
        return child as ChildProcess & { readonly pid: number };
      }, { darwinGuardianCommand: guardianPath });
      const guardian = owned.process;
      liveChildren.add(guardian);
      guardian.once("close", () => liveChildren.delete(guardian));

      let rootPid = 0;
      let sessionChildPid = 0;
      let escapedPid = 0;
      await expect(owned.waitForGuardianStop()).resolves.toBe(true);
      await expect.poll(() => {
        if (existsSync(rootPidPath)) {
          rootPid = Number(readFileSync(rootPidPath, "utf8").trim());
        }
        if (existsSync(sessionChildPidPath)) {
          sessionChildPid = Number(
            readFileSync(sessionChildPidPath, "utf8").trim(),
          );
        }
        if (existsSync(escapedPidPath)) {
          escapedPid = Number(readFileSync(escapedPidPath, "utf8").trim());
        }
        return rootPid > 1 && sessionChildPid > 1 && escapedPid > 1;
      }, { timeout: 5_000 }).toBe(true);
      try {
        expect(owned.requestPayloadExit?.()).toBe(true);
        await closeOf(guardian);

        expect(guardian.signalCode).toBeNull();
        expect(guardian.exitCode).toBe(129);
        expect(processIsAlive(rootPid)).toBe(false);
        expect(processIsAlive(sessionChildPid)).toBe(false);
        expect(processIsAlive(escapedPid)).toBe(true);
        owned.releaseIfGroupExited(0);
        await expect.poll(() => owned.confirmStopped()).toBe(true);
        expect(new RuntimeOwnedProcessJournal(directory, {
          platform: "darwin",
          darwinGuardianPath: guardianPath,
        }).records(runtimeGenerationId)).toEqual([]);
      } finally {
        for (const pid of [rootPid, sessionChildPid, escapedPid]) {
          if (pid <= 1 || !processIsAlive(pid)) continue;
          try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
        }
        await Promise.all([rootPid, sessionChildPid, escapedPid]
          .filter((pid) => pid > 1)
          .map(async (pid) => await expect.poll(() => !processIsAlive(pid), {
            timeout: 5_000,
          }).toBe(true)));
      }
    },
    15_000,
  );

  it.runIf(process.platform === "darwin")(
    "does not census the full machine while no-fork payloads run",
    async () => {
      const guardianPath = join(
        process.cwd(),
        "resources/generated/runtime-process-guardian/runtime-process-guardian",
      );
      const guardians: ChildProcess[] = [];
      for (let index = 0; index < 12; index += 1) {
        const guardian = spawn(guardianPath, [
          "watch",
          String(process.pid),
          "--",
          "/bin/sleep",
          "8",
        ], { detached: true, shell: false, stdio: "ignore" });
        liveChildren.add(guardian);
        guardian.once("close", () => liveChildren.delete(guardian));
        guardians.push(guardian);
        const guardianPid = guardian.pid ?? 0;
        expect(guardianPid).toBeGreaterThan(1);
        await expect.poll(
          () => darwinProcessGuardianReady(guardianPid, guardianPath)?.pid ?? 0,
          { timeout: 5_000 },
        ).toBe(guardianPid);
        process.kill(guardianPid, "SIGUSR1");
      }

      const sampleCpuSeconds = (): number => {
        for (const guardian of guardians) {
          expect(guardian.exitCode).toBeNull();
          expect(guardian.signalCode).toBeNull();
        }
        const sampled = spawnSync(
          "/bin/ps",
          [
            "-o",
            "time=",
            "-p",
            guardians.map((guardian) => String(guardian.pid)).join(","),
          ],
          { encoding: "utf8", shell: false, timeout: 5_000 },
        );
        expect(sampled.status, `${sampled.stderr}\n${sampled.stdout}`).toBe(0);
        const elapsedRows = sampled.stdout.split("\n")
          .map((elapsed) => elapsed.trim())
          .filter((elapsed) => elapsed.length > 0);
        expect(elapsedRows).toHaveLength(guardians.length);
        return elapsedRows.reduce((total, elapsed) => {
          const [minutes, seconds] = elapsed.split(":").map(Number);
          expect(minutes).toBeGreaterThanOrEqual(0);
          expect(seconds).toBeGreaterThanOrEqual(0);
          return total + (minutes! * 60) + seconds!;
        }, 0);
      };

      try {
        // Exclude the intentionally expensive one-time admission censuses.
        // During the idle interval the former 50 Hz PROC_ALL_PIDS loop burns
        // well over this budget with the same realistic burst.
        const baselineCpuSeconds = sampleCpuSeconds();
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        const idleCpuSeconds = sampleCpuSeconds() - baselineCpuSeconds;
        expect(idleCpuSeconds).toBeGreaterThanOrEqual(0);
        expect(idleCpuSeconds).toBeLessThan(0.25);
      } finally {
        for (const guardian of guardians) {
          if (guardian.exitCode === null && guardian.signalCode === null) {
            guardian.kill("SIGTERM");
          }
        }
        await Promise.all(guardians.map((guardian) => closeOf(guardian)));
      }
    },
    15_000,
  );

  it.runIf(process.platform === "darwin")(
    "resumes a killed stopped Node readline payload before retiring its guardian",
    async () => {
      const directory = temporaryDirectory();
      const payloadPidPath = join(directory, "readline-payload.pid");
      const guardianPath = join(
        process.cwd(),
        "resources/generated/runtime-process-guardian/runtime-process-guardian",
      );
      activate(directory);
      const source = [
        "const { writeFileSync } = require('node:fs')",
        "const { createInterface } = require('node:readline')",
        `writeFileSync(${JSON.stringify(payloadPidPath)}, String(process.pid))`,
        "createInterface({ input: process.stdin })",
        "setInterval(() => undefined, 1000)",
      ].join(";");
      const invocation = runtimeOwnedProcessInvocation(
        process.execPath,
        ["-e", source],
      );
      const guardian = spawnRuntimeOwnedProcess(() => spawn(
        invocation.command,
        invocation.args,
        { detached: true, shell: false, stdio: ["pipe", "ignore", "ignore"] },
      ));
      liveChildren.add(guardian);
      guardian.once("close", () => liveChildren.delete(guardian));

      let payloadPid = 0;
      await expect.poll(() => {
        if (existsSync(payloadPidPath)) {
          payloadPid = Number(readFileSync(payloadPidPath, "utf8").trim());
        }
        return Number.isSafeInteger(payloadPid) && payloadPid > 1;
      }, { timeout: 5_000 }).toBe(true);
      expect(processIsAlive(payloadPid)).toBe(true);

      guardian.kill("SIGTERM");
      await closeOf(guardian);

      expect(guardian.exitCode).toBe(137);
      expect(guardian.signalCode).toBeNull();
      expect(processIsAlive(payloadPid)).toBe(false);
      await expect.poll(() => new RuntimeOwnedProcessJournal(directory, {
        platform: "darwin",
        darwinGuardianPath: guardianPath,
      }).records(runtimeGenerationId)).toEqual([]);
      expect(confirmRuntimeOwnedProcessStopped(guardian)).toBe(true);
    },
    15_000,
  );
});
