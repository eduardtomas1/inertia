import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";
import { build as viteBuild, type InlineConfig } from "vite";

import electronViteConfig from "../../electron.vite.config";
import { runBounded } from "../../scripts/bounded-process-tree.mjs";
import {
  acquireGuardianBuildLock,
  cleanGuardianLockArtifacts,
  guardianFileSyncOpenFlags,
  publishGuardianArtifacts,
  reclaimStaleGuardianBuildLock,
  recoverGuardianPublication,
  releaseGuardianBuildLock,
  renewGuardianBuildLock,
  startGuardianBuildLockHeartbeat,
} from "../../scripts/runtime-process-guardian-publication.mjs";
import {
  executableProcessExists as processExists,
} from "../helpers/executable-process";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const script = join(
  repositoryRoot,
  "scripts",
  "build-runtime-process-guardian.mjs",
);
const packageScript = join(
  repositoryRoot,
  "scripts",
  "run-electron-builder.mjs",
);
const roots: string[] = [];

describe("runtime guardian durability", () => {
  it("opens Windows files with write access before flushing them", () => {
    expect(guardianFileSyncOpenFlags("win32")).toBe("r+");
    expect(guardianFileSyncOpenFlags("linux")).toBe("r");
    expect(guardianFileSyncOpenFlags("darwin")).toBe("r");
  });
});

interface Fixture {
  readonly bundledIntegrity: string;
  readonly compiler: string;
  readonly guardian: string;
  readonly integrity: string;
  readonly outputDirectory: string;
  readonly root: string;
  readonly stateDirectory: string;
  readonly windowsJob: string;
}

function fixture(compilerSource: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), "inertia-guardian-build-"));
  roots.push(root);
  const outputDirectory = join(root, "generated", "runtime-process-guardian");
  const stateDirectory = join(
    dirname(outputDirectory),
    ".runtime-process-guardian-build",
  );
  const guardian = join(outputDirectory, "runtime-process-guardian");
  const windowsJob = join(outputDirectory, "windows-runtime-job.exe");
  const integrity = join(
    dirname(outputDirectory),
    "windows-runtime-job-integrity.json",
  );
  const bundledIntegrity = join(
    root,
    "windows-runtime-job-bundled-integrity.json",
  );
  const compiler = join(root, "compiler");
  mkdirSync(outputDirectory, { recursive: true });
  mkdirSync(stateDirectory, { recursive: true });
  writeFileSync(guardian, "known-good-guardian", { mode: 0o755 });
  writeFileSync(windowsJob, "known-good-windows-job");
  writeFileSync(
    integrity,
    `${JSON.stringify({ sha256: "known-good-integrity" })}\n`,
  );
  writeFileSync(compiler, `#!/bin/sh\n${compilerSource}\n`, { mode: 0o755 });
  chmodSync(compiler, 0o755);
  return {
    bundledIntegrity,
    compiler,
    guardian,
    integrity,
    outputDirectory,
    root,
    stateDirectory,
    windowsJob,
  };
}

function build(
  subject: Fixture,
  extraEnvironment: Record<string, string> = {},
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [script], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "test",
      INERTIA_TEST_GUARDIAN_COMPILER: subject.compiler,
      INERTIA_TEST_GUARDIAN_OUTPUT_DIRECTORY: subject.outputDirectory,
      ...extraEnvironment,
    },
  });
}

async function buildAsync(subject: Fixture, trace: string): Promise<number> {
  return await new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NODE_ENV: "test",
        INERTIA_TEST_GUARDIAN_COMPILER: subject.compiler,
        INERTIA_TEST_GUARDIAN_COMPILER_TRACE: trace,
        INERTIA_TEST_GUARDIAN_OUTPUT_DIRECTORY: subject.outputDirectory,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-64 * 1024);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0 && stderr) process.stderr.write(stderr);
      resolveExit(code ?? -1);
    });
  });
}

async function packageAsync(
  subject: Fixture,
  builder: string,
  platform: NodeJS.Platform,
  extraEnvironment: Record<string, string> = {},
  builderArguments: readonly string[] = ["--dir"],
): Promise<number> {
  return await new Promise((resolveExit, reject) => {
    const child = spawn(
      process.execPath,
      [packageScript, ...builderArguments],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          NODE_ENV: "test",
          INERTIA_TEST_ELECTRON_BUILDER_SCRIPT: builder,
          INERTIA_TEST_GUARDIAN_OUTPUT_DIRECTORY: subject.outputDirectory,
          INERTIA_TEST_GUARDIAN_PLATFORM: platform,
          INERTIA_TEST_GUARDIAN_BUNDLED_INTEGRITY: subject.bundledIntegrity,
          ...extraEnvironment,
        },
        stdio: "ignore",
      },
    );
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? -1));
  });
}

function packageProcess(
  subject: Fixture,
  builder: string,
  platform: NodeJS.Platform,
  extraEnvironment: Record<string, string> = {},
) {
  return spawn(process.execPath, [packageScript, "--dir"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      INERTIA_TEST_ELECTRON_BUILDER_SCRIPT: builder,
      INERTIA_TEST_GUARDIAN_OUTPUT_DIRECTORY: subject.outputDirectory,
      INERTIA_TEST_GUARDIAN_PLATFORM: platform,
      INERTIA_TEST_GUARDIAN_BUNDLED_INTEGRITY: subject.bundledIntegrity,
      ...extraEnvironment,
    },
    stdio: "ignore",
  });
}

function readFixturePid(path: string): number | null {
  if (!existsSync(path)) return null;
  const pid = Number.parseInt(readFileSync(path, "utf8"), 10);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
}

async function waitForFile(
  path: string,
  timeoutMs = 1_000,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (existsSync(path)) return;
    await delay(10, undefined, { signal });
  }
  signal?.throwIfAborted();
  if (existsSync(path)) return;
  throw new Error(`Timed out waiting for ${path}.`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!processExists(pid)) return;
    await delay(50);
  }
  if (!processExists(pid)) return;
  throw new Error(`Timed out waiting for test-owned process ${pid} to exit.`);
}

function useNativeWindowsGuardian(subject: Fixture): void {
  const source = join(
    repositoryRoot,
    "resources/generated/runtime-process-guardian/windows-runtime-job.exe",
  );
  const bytes = readFileSync(source);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  rmSync(subject.guardian);
  writeFileSync(subject.windowsJob, bytes);
  writeFileSync(subject.integrity, JSON.stringify({ sha256 }));
  writeFileSync(subject.bundledIntegrity, JSON.stringify({ sha256 }));
}

function writeLinuxIdentityGuardian(path: string, inodeOffset = 0n): void {
  writeFileSync(path, "identity-placeholder", { mode: 0o755 });
  const identity = statSync(path, { bigint: true });
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      'if [ "$1" = "seccomp-selftest-identity" ]; then',
      `  printf '1|1|1|1|${identity.dev}|${identity.ino + inodeOffset}\\n'`,
      "  exit 0",
      "fi",
      "exit 64",
    ].join("\n"),
  );
}

function expectKnownGoodArtifacts(subject: Fixture): void {
  expect(readFileSync(subject.guardian, "utf8")).toBe("known-good-guardian");
  expect(readFileSync(subject.windowsJob, "utf8")).toBe(
    "known-good-windows-job",
  );
  expect(JSON.parse(readFileSync(subject.integrity, "utf8"))).toEqual({
    sha256: "known-good-integrity",
  });
}

function expectCleanBuildState(subject: Fixture): void {
  expect(readdirSync(subject.stateDirectory)).toEqual([]);
  for (const directory of [
    subject.outputDirectory,
    dirname(subject.outputDirectory),
  ]) {
    expect(
      readdirSync(directory).every(
        (name) => !name.includes(".tmp") && !name.startsWith("compile-"),
      ),
    ).toBe(true);
  }
}

function writeSyntheticLock(
  subject: Fixture,
  {
    expiresAtMs,
    pid,
    processIdentity = null,
    token,
  }: {
    readonly expiresAtMs: number;
    readonly pid: number;
    readonly processIdentity?: string | null;
    readonly token: string;
  },
): void {
  const owner = join(subject.stateDirectory, `owner-${token}`);
  writeFileSync(
    owner,
    JSON.stringify({
      createdAtMs: expiresAtMs - 1_000,
      expiresAtMs,
      pid,
      processIdentity,
      token,
      version: 1,
    }),
  );
  linkSync(owner, join(subject.stateDirectory, "build.lock"));
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  }
});

describe("runtime guardian build ownership", () => {
  it("does not launch a bootstrap leaf before GO admission", async () => {
    const subject = fixture("exit 1");
    const marker = join(subject.root, "bootstrap-leaf-started");
    const leaf = join(subject.root, "bootstrap-leaf.mjs");
    writeFileSync(
      leaf,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "started");`,
    );
    const payload = Buffer.from(
      JSON.stringify({
        args: [leaf],
        command: process.execPath,
        holdAuthority: true,
        input: null,
      }),
    ).toString("base64");
    const trampoline = spawn(
      process.execPath,
      [join(repositoryRoot, "scripts/bounded-command-trampoline.mjs"), payload],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    const completion = new Promise<number>((resolveExit, reject) => {
      trampoline.once("error", reject);
      trampoline.once("exit", (code) => resolveExit(code ?? -1));
    });
    let status = -2;
    try {
      await delay(50);
      expect(existsSync(marker)).toBe(false);
      trampoline.stdin.end();
      status = await Promise.race([completion, delay(2_000).then(() => -2)]);
    } finally {
      trampoline.stdin.end();
      if (trampoline.pid && processExists(trampoline.pid)) {
        trampoline.kill("SIGKILL");
        await Promise.race([completion, delay(2_000)]);
      }
    }
    expect(status).toBe(125);
    expect(existsSync(marker)).toBe(false);
  });

  it("terminates an admitted bootstrap leaf when authority closes", async () => {
    const subject = fixture("exit 1");
    const pidFile = join(subject.root, "bootstrap-leaf.pid");
    const leaf = join(subject.root, "bootstrap-leaf.mjs");
    writeFileSync(
      leaf,
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const payload = Buffer.from(
      JSON.stringify({
        args: [leaf],
        command: process.execPath,
        holdAuthority: true,
        input: null,
      }),
    ).toString("base64");
    const trampoline = spawn(
      process.execPath,
      [join(repositoryRoot, "scripts/bounded-command-trampoline.mjs"), payload],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    const completion = new Promise<number>((resolveExit, reject) => {
      trampoline.once("error", reject);
      trampoline.once("exit", (code) => resolveExit(code ?? -1));
    });
    let leafPid = 0;
    let status = -2;
    try {
      trampoline.stdin.write("GO\n");
      await waitForFile(pidFile);
      leafPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
      trampoline.stdin.end();
      status = await Promise.race([completion, delay(2_000).then(() => -2)]);
      await waitForProcessExit(leafPid);
    } finally {
      trampoline.stdin.end();
      if (trampoline.pid && processExists(trampoline.pid)) {
        trampoline.kill("SIGKILL");
        await Promise.race([completion, delay(2_000)]);
      }
      if (leafPid > 0 && processExists(leafPid)) {
        process.kill(leafPid, "SIGKILL");
        await waitForProcessExit(leafPid);
      }
    }
    expect(status).not.toBe(-2);
    expect(status).not.toBe(0);
  });

  it("flushes every bootstrap settlement marker before exit", async () => {
    const subject = fixture("exit 1");
    const leaf = join(subject.root, "settled-bootstrap-leaf.mjs");
    writeFileSync(
      leaf,
      'import { writeSync } from "node:fs";\n'
        + 'writeSync(2, `INERTIA_READY:${process.argv[2]}\\n`);',
    );
    await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        const settlementToken = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
        const readyMarker = `INERTIA_READY:${settlementToken}\n`;
        const payload = Buffer.from(
          JSON.stringify({
            args: [leaf, settlementToken],
            command: process.execPath,
            holdAuthority: true,
            input: null,
            settlementToken,
          }),
        ).toString("base64");
        const trampoline = spawn(
          process.execPath,
          [join(repositoryRoot, "scripts/bounded-command-trampoline.mjs"), payload],
          { stdio: ["pipe", "ignore", "pipe"] },
        );
        let stderr = "";
        const ready = new Promise<boolean>((resolveReady) => {
          trampoline.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
            if (stderr.includes(readyMarker)) resolveReady(true);
          });
        });
        const completion = new Promise<number>((resolveExit) => {
          trampoline.once("error", () => resolveExit(-1));
          trampoline.once("close", (code) => resolveExit(code ?? -1));
        });
        let status = -2;
        try {
          trampoline.stdin.write("GO\n");
          const started = await Promise.race([
            ready,
            completion.then(() => false),
            delay(8_000, false, { ref: false }),
          ]);
          expect(started).toBe(true);
          status = await Promise.race([
            completion,
            delay(2_000, -2, { ref: false }),
          ]);
        } finally {
          trampoline.stdin.end();
          if (trampoline.pid && processExists(trampoline.pid)) {
            trampoline.kill("SIGKILL");
            await Promise.race([completion, delay(2_000)]);
          }
        }
        expect(status).toBe(0);
        expect(stderr).toBe(
          `${readyMarker}INERTIA_SETTLED:${settlementToken}\n`,
        );
      }),
    );
  });

  it("records the exact current process birth identity", () => {
    const subject = fixture("exit 1");
    const lock = acquireGuardianBuildLock(subject.stateDirectory);
    try {
      const record = JSON.parse(readFileSync(lock.lockPath, "utf8")) as {
        readonly processIdentity: string | null;
      };
      if (["darwin", "linux", "win32"].includes(process.platform)) {
        expect(record.processIdentity).toMatch(
          new RegExp(`^${process.platform}:`, "u"),
        );
      }
    } finally {
      releaseGuardianBuildLock(lock);
    }
  });

  it("reclaims a fresh orphaned malformed lock with no owner inode", () => {
    const subject = fixture("exit 1");
    writeFileSync(join(subject.stateDirectory, "build.lock"), "malformed");
    const lock = acquireGuardianBuildLock(subject.stateDirectory, {
      timeoutMs: 200,
    });
    releaseGuardianBuildLock(lock);
    expect(readdirSync(subject.stateDirectory)).toEqual([]);
  });

  it("fails closed on a fresh malformed lock with a live owner inode", () => {
    const subject = fixture("exit 1");
    const lockPath = join(subject.stateDirectory, "build.lock");
    const ownerPath = join(subject.stateDirectory, "owner-malformed");
    writeFileSync(ownerPath, "malformed");
    linkSync(ownerPath, lockPath);
    expect(() =>
      acquireGuardianBuildLock(subject.stateDirectory, {
        timeoutMs: 40,
      }),
    ).toThrow("Timed out waiting");
    expect(readFileSync(lockPath, "utf8")).toBe("malformed");
  });

  it.skipIf(process.platform === "win32")(
    "fails closed without blocking on a FIFO lock",
    () => {
      const subject = fixture("exit 1");
      const lockPath = join(subject.stateDirectory, "build.lock");
      expect(spawnSync("mkfifo", [lockPath]).status).toBe(0);
      const publication = join(
        repositoryRoot,
        "scripts/runtime-process-guardian-publication.mjs",
      );
      const source = [
        `import { reclaimStaleGuardianBuildLock as reclaim } from ${JSON.stringify(publication)};`,
        `if (reclaim(${JSON.stringify(subject.stateDirectory)}, ${JSON.stringify(lockPath)}) !== false) process.exitCode = 2;`,
      ].join("\n");
      const child = spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", source],
        { encoding: "utf8", timeout: 1_000 },
      );
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
    },
  );

  it("recovers an incomplete claimant publication after its grace", () => {
    const subject = fixture("exit 1");
    const lockPath = join(subject.stateDirectory, "build.lock");
    const token = "56565656-5656-4656-8656-565656565656";
    writeSyntheticLock(subject, {
      expiresAtMs: Date.now() - 1,
      pid: 2_147_483_647,
      token,
    });
    const incomplete = join(
      subject.stateDirectory,
      `claimant-${token}-67676767-6767-4767-8767-676767676767.json`,
    );
    writeFileSync(incomplete, "");
    expect(
      reclaimStaleGuardianBuildLock(subject.stateDirectory, lockPath),
    ).toBe(false);
    const abandonedAt = new Date(Date.now() - 31_000);
    utimesSync(incomplete, abandonedAt, abandonedAt);
    expect(
      reclaimStaleGuardianBuildLock(subject.stateDirectory, lockPath),
    ).toBe(true);
    expect(readdirSync(subject.stateDirectory)).toEqual([]);
  });

  it("never reclaims an aged lock with the exact live process identity", () => {
    const subject = fixture("exit 1");
    const probe = acquireGuardianBuildLock(subject.stateDirectory);
    const processIdentity = JSON.parse(readFileSync(probe.lockPath, "utf8"))
      .processIdentity as string;
    releaseGuardianBuildLock(probe);
    writeSyntheticLock(subject, {
      expiresAtMs: Date.now() - 1,
      pid: process.pid,
      processIdentity,
      token: "11111111-1111-4111-8111-111111111111",
    });
    const aged = new Date(Date.now() - 4 * 60 * 60_000 - 1_000);
    utimesSync(
      join(
        subject.stateDirectory,
        "owner-11111111-1111-4111-8111-111111111111",
      ),
      aged,
      aged,
    );

    expect(() =>
      acquireGuardianBuildLock(subject.stateDirectory, {
        timeoutMs: 40,
      }),
    ).toThrow("Timed out waiting");

    expect(existsSync(join(subject.stateDirectory, "build.lock"))).toBe(true);
  });

  it("fails closed on a fresh live PID without a birth identity", () => {
    const subject = fixture("exit 1");
    writeSyntheticLock(subject, {
      expiresAtMs: Date.now() + 60_000,
      pid: process.pid,
      token: "12121212-1212-4212-8212-121212121212",
    });
    expect(() =>
      acquireGuardianBuildLock(subject.stateDirectory, {
        timeoutMs: 40,
      }),
    ).toThrow("Timed out waiting");
  });

  it("bounds process birth-identity probes while waiting on one lock inode", () => {
    const subject = fixture("exit 1");
    const probe = acquireGuardianBuildLock(subject.stateDirectory);
    const processIdentity = JSON.parse(readFileSync(probe.lockPath, "utf8"))
      .processIdentity as string;
    releaseGuardianBuildLock(probe);
    writeSyntheticLock(subject, {
      expiresAtMs: Date.now() + 60_000,
      pid: process.pid,
      processIdentity,
      token: "16161616-1616-4616-8616-161616161616",
    });
    const trace = join(subject.root, "identity-queries");
    const previous = process.env.INERTIA_TEST_PROCESS_IDENTITY_TRACE;
    process.env.INERTIA_TEST_PROCESS_IDENTITY_TRACE = trace;
    try {
      expect(() =>
        acquireGuardianBuildLock(subject.stateDirectory, {
          timeoutMs: 140,
        }),
      ).toThrow("Timed out waiting");
    } finally {
      if (previous === undefined) {
        delete process.env.INERTIA_TEST_PROCESS_IDENTITY_TRACE;
      } else {
        process.env.INERTIA_TEST_PROCESS_IDENTITY_TRACE = previous;
      }
    }
    expect(
      readFileSync(trace, "utf8").trim().split("\n").length,
    ).toBeLessThanOrEqual(2);
  });

  it("reclaims an aged live PID record without a birth identity", () => {
    const subject = fixture("exit 1");
    const token = "13131313-1313-4313-8313-131313131313";
    writeSyntheticLock(subject, {
      expiresAtMs: Date.now() - 1,
      pid: process.pid,
      token,
    });
    const aged = new Date(Date.now() - 4 * 60 * 60_000 - 1_000);
    utimesSync(join(subject.stateDirectory, `owner-${token}`), aged, aged);
    const lock = acquireGuardianBuildLock(subject.stateDirectory, {
      timeoutMs: 200,
    });
    releaseGuardianBuildLock(lock);
    expect(readdirSync(subject.stateDirectory)).toEqual([]);
  });

  it("bounds an unprobeable owner identity by the lease", () => {
    const subject = fixture("exit 1");
    const probe = acquireGuardianBuildLock(subject.stateDirectory);
    const processIdentity = JSON.parse(readFileSync(probe.lockPath, "utf8"))
      .processIdentity as string;
    releaseGuardianBuildLock(probe);
    const token = "17171717-1717-4717-8717-171717171717";
    writeSyntheticLock(subject, {
      expiresAtMs: Date.now() + 60_000,
      pid: process.pid,
      processIdentity,
      token,
    });
    process.env.INERTIA_TEST_PROCESS_IDENTITY_FORCE_NULL_PID = String(
      process.pid,
    );
    try {
      expect(() =>
        acquireGuardianBuildLock(subject.stateDirectory, {
          timeoutMs: 40,
        }),
      ).toThrow("Timed out waiting");
      const aged = new Date(Date.now() - 4 * 60 * 60_000 - 1_000);
      utimesSync(join(subject.stateDirectory, `owner-${token}`), aged, aged);
      const lock = acquireGuardianBuildLock(subject.stateDirectory, {
        timeoutMs: 200,
      });
      releaseGuardianBuildLock(lock);
    } finally {
      delete process.env.INERTIA_TEST_PROCESS_IDENTITY_FORCE_NULL_PID;
    }
    expect(readdirSync(subject.stateDirectory)).toEqual([]);
  });

  it("reclaims a fresh lock after its exact owner PID is dead", () => {
    const subject = fixture("exit 1");
    writeSyntheticLock(subject, {
      expiresAtMs: Date.now() + 60_000,
      pid: 2_147_483_647,
      token: "66666666-6666-4666-8666-666666666666",
    });

    const lock = acquireGuardianBuildLock(subject.stateDirectory, {
      timeoutMs: 200,
    });
    releaseGuardianBuildLock(lock);

    expect(readdirSync(subject.stateDirectory)).toEqual([]);
  });

  it.runIf(process.platform === "linux")(
    "reclaims a reused live PID only after boot and start identity mismatch",
    () => {
      const subject = fixture("exit 1");
      writeSyntheticLock(subject, {
        expiresAtMs: Date.now() + 60_000,
        pid: process.pid,
        processIdentity: "linux:00000000-0000-4000-8000-000000000000:1",
        token: "99999999-9999-4999-8999-999999999999",
      });

      const lock = acquireGuardianBuildLock(subject.stateDirectory, {
        timeoutMs: 200,
      });
      releaseGuardianBuildLock(lock);
      expect(readdirSync(subject.stateDirectory)).toEqual([]);
    },
  );

  it("reclaims a dead owner's pending admission trampoline immediately", () => {
    const subject = fixture("exit 1");
    const token = "77777777-7777-4777-8777-777777777777";
    writeSyntheticLock(subject, {
      expiresAtMs: Date.now() + 60_000,
      pid: 2_147_483_647,
      token,
    });
    const childAuthority = join(subject.stateDirectory, `child-${token}.json`);
    writeFileSync(
      childAuthority,
      JSON.stringify({
        state: "pending",
        token,
        version: 1,
      }),
    );

    const lock = acquireGuardianBuildLock(subject.stateDirectory, {
      timeoutMs: 200,
    });
    releaseGuardianBuildLock(lock);
    expect(readdirSync(subject.stateDirectory)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "does not reclaim a dead owner while its registered child group is live",
    async () => {
      const subject = fixture("exit 1");
      const token = "88888888-8888-4888-8888-888888888888";
      writeSyntheticLock(subject, {
        expiresAtMs: Date.now() + 60_000,
        pid: 2_147_483_647,
        token,
      });
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { detached: true, stdio: "ignore" },
      );
      if (!child.pid)
        throw new Error("The test-owned process group did not start.");
      writeFileSync(
        join(subject.stateDirectory, `child-${token}.json`),
        JSON.stringify({
          pid: child.pid,
          processGroupId: child.pid,
          processIdentity: null,
          state: "running",
          token,
          version: 1,
        }),
      );
      try {
        expect(() =>
          acquireGuardianBuildLock(subject.stateDirectory, {
            timeoutMs: 40,
          }),
        ).toThrow("Timed out waiting");
      } finally {
        process.kill(-child.pid, "SIGKILL");
        await new Promise<void>((resolveExit) =>
          child.once("exit", () => {
            resolveExit();
          }),
        );
      }
      const lock = acquireGuardianBuildLock(subject.stateDirectory, {
        timeoutMs: 200,
      });
      releaseGuardianBuildLock(lock);
      expect(readdirSync(subject.stateDirectory)).toEqual([]);
    },
  );

  it("bounds a live child PID record without a birth identity by the lease", () => {
    const subject = fixture("exit 1");
    const token = "14141414-1414-4414-8414-141414141414";
    writeSyntheticLock(subject, {
      expiresAtMs: Date.now() + 60_000,
      pid: 2_147_483_647,
      token,
    });
    const authorityPath = join(subject.stateDirectory, `child-${token}.json`);
    writeFileSync(
      authorityPath,
      JSON.stringify({
        pid: process.pid,
        processGroupId: null,
        processIdentity: null,
        state: "running",
        token,
        version: 1,
      }),
    );
    expect(() =>
      acquireGuardianBuildLock(subject.stateDirectory, {
        timeoutMs: 40,
      }),
    ).toThrow("Timed out waiting");
    const aged = new Date(Date.now() - 4 * 60 * 60_000 - 1_000);
    utimesSync(authorityPath, aged, aged);
    const lock = acquireGuardianBuildLock(subject.stateDirectory, {
      timeoutMs: 200,
    });
    releaseGuardianBuildLock(lock);
    expect(readdirSync(subject.stateDirectory)).toEqual([]);
  });

  it("preserves an aged live child with its exact birth identity", () => {
    const subject = fixture("exit 1");
    const probe = acquireGuardianBuildLock(subject.stateDirectory);
    const processIdentity = JSON.parse(readFileSync(probe.lockPath, "utf8"))
      .processIdentity as string;
    releaseGuardianBuildLock(probe);
    const token = "15151515-1515-4515-8515-151515151515";
    writeSyntheticLock(subject, {
      expiresAtMs: Date.now() + 60_000,
      pid: 2_147_483_647,
      token,
    });
    const authorityPath = join(subject.stateDirectory, `child-${token}.json`);
    writeFileSync(
      authorityPath,
      JSON.stringify({
        pid: process.pid,
        processGroupId: null,
        processIdentity,
        state: "running",
        token,
        version: 1,
      }),
    );
    const aged = new Date(Date.now() - 4 * 60 * 60_000 - 1_000);
    utimesSync(authorityPath, aged, aged);
    expect(() =>
      acquireGuardianBuildLock(subject.stateDirectory, {
        timeoutMs: 40,
      }),
    ).toThrow("Timed out waiting");
  });

  it("bounds an unprobeable child identity by the lease", () => {
    const subject = fixture("exit 1");
    const probe = acquireGuardianBuildLock(subject.stateDirectory);
    const processIdentity = JSON.parse(readFileSync(probe.lockPath, "utf8"))
      .processIdentity as string;
    releaseGuardianBuildLock(probe);
    const token = "18181818-1818-4818-8818-181818181818";
    writeSyntheticLock(subject, {
      expiresAtMs: Date.now() + 60_000,
      pid: 2_147_483_647,
      token,
    });
    const authorityPath = join(subject.stateDirectory, `child-${token}.json`);
    writeFileSync(
      authorityPath,
      JSON.stringify({
        pid: process.pid,
        processGroupId: null,
        processIdentity,
        state: "running",
        token,
        version: 1,
      }),
    );
    process.env.INERTIA_TEST_PROCESS_IDENTITY_FORCE_NULL_PID = String(
      process.pid,
    );
    try {
      expect(() =>
        acquireGuardianBuildLock(subject.stateDirectory, {
          timeoutMs: 40,
        }),
      ).toThrow("Timed out waiting");
      const aged = new Date(Date.now() - 4 * 60 * 60_000 - 1_000);
      utimesSync(authorityPath, aged, aged);
      const lock = acquireGuardianBuildLock(subject.stateDirectory, {
        timeoutMs: 200,
      });
      releaseGuardianBuildLock(lock);
    } finally {
      delete process.env.INERTIA_TEST_PROCESS_IDENTITY_FORCE_NULL_PID;
    }
    expect(readdirSync(subject.stateDirectory)).toEqual([]);
  });

  it.each([
    [
      "valid",
      (subject: Fixture) =>
        writeSyntheticLock(subject, {
          expiresAtMs: Date.now() - 1,
          pid: 2_147_483_647,
          token: "58585858-5858-4858-8858-585858585858",
        }),
      false,
    ],
    [
      "partially-written",
      (subject: Fixture) =>
        writeFileSync(join(subject.stateDirectory, "build.lock"), "partial"),
      false,
    ],
    [
      "pre-publication partially-written",
      (subject: Fixture) =>
        writeFileSync(join(subject.stateDirectory, "build.lock"), "partial"),
      true,
    ],
  ])(
    "fences a paused %s claimant after replacement",
    (_kind, setup, prePublication) => {
      const subject = fixture("exit 1");
      const lockPath = join(subject.stateDirectory, "build.lock");
      setup(subject);
      let nestedReclaim: boolean | null = null;
      const interleave = (): void => {
        if (!prePublication) {
          const name = readdirSync(subject.stateDirectory).find((candidate) =>
            candidate.startsWith("claimant-"),
          );
          const authorityPath = join(subject.stateDirectory, name ?? "missing");
          const authority = JSON.parse(readFileSync(authorityPath, "utf8"));
          writeFileSync(
            authorityPath,
            `${JSON.stringify({ ...authority, pid: 2_147_483_647, processIdentity: null })}\n`,
          );
        }
        nestedReclaim = reclaimStaleGuardianBuildLock(
          subject.stateDirectory,
          lockPath,
        );
        writeFileSync(lockPath, "replacement-owner");
      };
      const pausedReclaim = reclaimStaleGuardianBuildLock(
        subject.stateDirectory,
        lockPath,
        prePublication
          ? { beforeClaimantPublication: interleave }
          : { beforeUnlink: interleave },
      );
      expect(nestedReclaim).toBe(true);
      expect(pausedReclaim).toBe(false);
      expect(readFileSync(lockPath, "utf8")).toBe("replacement-owner");
      expect(
        readdirSync(subject.stateDirectory).some(
          (name) => name.startsWith("claimant-") || name.startsWith("reclaim-"),
        ),
      ).toBe(false);
    },
  );

  it.each(["valid", "malformed"])(
    "fails closed on an aged %s legacy claim until explicit cleanup",
    (kind) => {
      const subject = fixture("exit 1");
      const token = "57575757-5757-4757-8757-575757575757";
      const lockPath = join(subject.stateDirectory, "build.lock");
      let owner: string | null = null;
      let claim: string;
      if (kind === "valid") {
        writeSyntheticLock(subject, {
          expiresAtMs: Date.now() - 1,
          pid: 2_147_483_647,
          token,
        });
        owner = join(subject.stateDirectory, `owner-${token}`);
        claim = join(subject.stateDirectory, `reclaim-${token}`);
        linkSync(owner, claim);
        rmSync(owner);
      } else {
        writeFileSync(lockPath, "malformed");
        const metadata = statSync(lockPath);
        claim = join(
          subject.stateDirectory,
          `reclaim-malformed-${metadata.dev}-${metadata.ino}`,
        );
        linkSync(lockPath, claim);
      }
      const aged = new Date(Date.now() - 4 * 60 * 60_000 - 1_000);
      utimesSync(claim, aged, aged);
      expect(
        reclaimStaleGuardianBuildLock(subject.stateDirectory, lockPath),
      ).toBe(false);
      if (owner) expect(existsSync(owner)).toBe(false);
      expect(existsSync(claim)).toBe(true);
      expect(existsSync(lockPath)).toBe(true);
      rmSync(claim);
      expect(
        reclaimStaleGuardianBuildLock(subject.stateDirectory, lockPath),
      ).toBe(true);
      expect(readdirSync(subject.stateDirectory)).toEqual([]);
    },
  );

  it("does not unlink a replacement lock during release", () => {
    const subject = fixture("exit 1");
    const lock = acquireGuardianBuildLock(subject.stateDirectory);
    rmSync(lock.lockPath);
    writeFileSync(lock.lockPath, "replacement-owner");

    releaseGuardianBuildLock(lock);

    expect(readFileSync(lock.lockPath, "utf8")).toBe("replacement-owner");
  });

  it("renews ownership before an aged live build can be reclaimed", () => {
    const subject = fixture("exit 1");
    const lock = acquireGuardianBuildLock(subject.stateDirectory);
    const aged = new Date(Date.now() - 4 * 60 * 60_000 - 1_000);
    utimesSync(lock.ownerPath, aged, aged);

    renewGuardianBuildLock(lock);

    expect(() =>
      acquireGuardianBuildLock(subject.stateDirectory, {
        timeoutMs: 40,
      }),
    ).toThrow("Timed out waiting");
    releaseGuardianBuildLock(lock);
    expect(readdirSync(subject.stateDirectory)).toEqual([]);
  });

  it("heartbeats a long-running owner lease", async () => {
    const subject = fixture("exit 1");
    const lock = acquireGuardianBuildLock(subject.stateDirectory);
    const aged = new Date(Date.now() - 4 * 60 * 60_000 - 1_000);
    utimesSync(lock.ownerPath, aged, aged);
    const stop = startGuardianBuildLockHeartbeat(lock, { intervalMs: 5 });
    try {
      await delay(25);
      expect(statSync(lock.lockPath).mtimeMs).toBeGreaterThan(
        Date.now() - 1_000,
      );
      expect(() =>
        acquireGuardianBuildLock(subject.stateDirectory, {
          timeoutMs: 40,
        }),
      ).toThrow("Timed out waiting");
    } finally {
      stop();
      releaseGuardianBuildLock(lock);
    }
    expect(readdirSync(subject.stateDirectory)).toEqual([]);
  });

  it("cleans abandoned reclaim links without touching the owned lock inode", () => {
    const subject = fixture("exit 1");
    const lock = acquireGuardianBuildLock(subject.stateDirectory);
    const abandoned = join(subject.stateDirectory, "reclaim-abandoned");
    const activeClaim = join(subject.stateDirectory, "reclaim-active");
    const abandonedToken = "59595959-5959-4959-8959-595959595959";
    const abandonedGeneration = "60606060-6060-4060-8060-606060606060";
    const abandonedAuthority = join(
      subject.stateDirectory,
      `claimant-${abandonedToken}-${abandonedGeneration}.json`,
    );
    const abandonedProof = join(
      subject.stateDirectory,
      `reclaim-${abandonedToken}-${abandonedGeneration}`,
    );
    writeFileSync(abandoned, "abandoned");
    linkSync(lock.ownerPath, activeClaim);
    writeFileSync(abandonedAuthority, "abandoned-authority");
    linkSync(lock.ownerPath, abandonedProof);

    cleanGuardianLockArtifacts(subject.stateDirectory, lock);

    expect(existsSync(abandoned)).toBe(false);
    expect(existsSync(activeClaim)).toBe(true);
    expect(existsSync(abandonedAuthority)).toBe(false);
    expect(existsSync(abandonedProof)).toBe(false);
    rmSync(activeClaim);
    releaseGuardianBuildLock(lock);
    expect(readdirSync(subject.stateDirectory)).toEqual([]);
  });

  it("does not unlink a replacement introduced during stale reclamation", () => {
    const subject = fixture("exit 1");
    const lockPath = join(subject.stateDirectory, "build.lock");
    writeSyntheticLock(subject, {
      expiresAtMs: Date.now() + 60_000,
      pid: 2_147_483_647,
      token: "44444444-4444-4444-8444-444444444444",
    });
    const aged = new Date(Date.now() - 4 * 60 * 60_000 - 1_000);
    utimesSync(
      join(
        subject.stateDirectory,
        "owner-44444444-4444-4444-8444-444444444444",
      ),
      aged,
      aged,
    );

    expect(
      reclaimStaleGuardianBuildLock(subject.stateDirectory, lockPath, {
        beforeUnlink: () => {
          rmSync(lockPath);
          writeFileSync(lockPath, "replacement-owner");
        },
      }),
    ).toBe(false);

    expect(readFileSync(lockPath, "utf8")).toBe("replacement-owner");
  });
});

describe.skipIf(process.platform === "win32")(
  "runtime process guardian build",
  () => {
    it("preserves known-good artifacts when a compiler leaves partial output", () => {
      const subject = fixture(
        [
          'for argument do output="$argument"; done',
          'printf partial-output > "$output"',
          "exit 19",
        ].join("\n"),
      );
      const guardianIdentity = statSync(subject.guardian).ino;

      const result = build(subject);

      expect(result.status).not.toBe(0);
      expectKnownGoodArtifacts(subject);
      expect(statSync(subject.guardian).ino).toBe(guardianIdentity);
      expectCleanBuildState(subject);
    });

    it("rejects empty successful compiler output without publishing it", () => {
      const subject = fixture(
        [
          'for argument do output="$argument"; done',
          ': > "$output"',
          "exit 0",
        ].join("\n"),
      );

      const result = build(subject);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("did not produce a valid executable");
      expectKnownGoodArtifacts(subject);
      expectCleanBuildState(subject);
    });

    it.each([1, 2, 3])(
      "rolls back every Unix target after publication operation %s fails",
      (operation) => {
        const subject = fixture(
          [
            'for argument do output="$argument"; done',
            'printf replacement-guardian > "$output"',
            "exit 0",
          ].join("\n"),
        );

        const result = build(subject, {
          INERTIA_TEST_GUARDIAN_PUBLICATION_FAILURE_AFTER: String(operation),
        });

        expect(result.status).not.toBe(0);
        expectKnownGoodArtifacts(subject);
        expectCleanBuildState(subject);
      },
    );

    it("publishes one validated Unix artifact set after success", () => {
      const subject = fixture(
        [
          'for argument do output="$argument"; done',
          'printf replacement-guardian > "$output"',
          "exit 0",
        ].join("\n"),
      );
      writeFileSync(
        join(
          subject.outputDirectory,
          ".runtime-process-guardian.1.11111111-1111-4111-8111-111111111111.tmp",
        ),
        "stale",
      );
      writeFileSync(
        join(
          dirname(subject.outputDirectory),
          ".windows-runtime-job-integrity.json.2.22222222-2222-4222-8222-222222222222.tmp",
        ),
        "stale",
      );
      const guardianIdentity = statSync(subject.guardian).ino;

      const result = build(subject);

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(subject.guardian, "utf8")).toBe(
        "replacement-guardian",
      );
      expect(statSync(subject.guardian).ino).not.toBe(guardianIdentity);
      expect(statSync(subject.guardian).mode & 0o777).toBe(0o755);
      expect(() => statSync(subject.windowsJob)).toThrow();
      expect(JSON.parse(readFileSync(subject.integrity, "utf8"))).toEqual({
        sha256: null,
      });
      expectCleanBuildState(subject);
    });

    it("serializes concurrent builders before compilation and publication", async () => {
      const subject = fixture(
        [
          "trace=$INERTIA_TEST_GUARDIAN_COMPILER_TRACE",
          "printf 'start %s\\n' $$ >> \"$trace\"",
          "sleep 0.15",
          'for argument do output="$argument"; done',
          "printf 'guardian-%s' $$ > \"$output\"",
          "printf 'end %s\\n' $$ >> \"$trace\"",
          "exit 0",
        ].join("\n"),
      );
      const trace = join(subject.root, "compiler-trace");

      const statuses = await Promise.all([
        buildAsync(subject, trace),
        buildAsync(subject, trace),
      ]);

      expect(statuses).toEqual([0, 0]);
      const events = readFileSync(trace, "utf8").trim().split("\n");
      expect(events).toHaveLength(4);
      expect(events[0]).toMatch(/^start \d+$/u);
      expect(events[1]).toBe(events[0].replace("start", "end"));
      expect(events[2]).toMatch(/^start \d+$/u);
      expect(events[3]).toBe(events[2].replace("start", "end"));
      expect(readFileSync(subject.guardian, "utf8")).toMatch(/^guardian-\d+$/u);
      expectCleanBuildState(subject);
    });

    it("aborts without publication when the build lock heartbeat is compromised", async () => {
      const subject = fixture(
        [
          'printf started > "$INERTIA_TEST_GUARDIAN_COMPILER_TRACE"',
          "sleep 1000",
        ].join("\n"),
      );
      const marker = join(subject.root, "compiler-started");
      const child = spawn(process.execPath, [script], {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          NODE_ENV: "test",
          INERTIA_TEST_GUARDIAN_COMPILER: subject.compiler,
          INERTIA_TEST_GUARDIAN_COMPILER_TRACE: marker,
          INERTIA_TEST_GUARDIAN_HEARTBEAT_INTERVAL_MS: "5",
          INERTIA_TEST_GUARDIAN_OUTPUT_DIRECTORY: subject.outputDirectory,
        },
        stdio: "ignore",
      });
      const completion = new Promise<number>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => resolveExit(code ?? -1));
      });
      await waitForFile(marker);
      const lockPath = join(subject.stateDirectory, "build.lock");
      rmSync(lockPath);
      writeFileSync(lockPath, "replacement-owner");
      expect(await completion).not.toBe(0);
      expectKnownGoodArtifacts(subject);
      expect(readFileSync(lockPath, "utf8")).toBe("replacement-owner");
      rmSync(lockPath);
      expectCleanBuildState(subject);
    });

    it("allows only one contender to reclaim a dead owner before serializing", async () => {
      const subject = fixture(
        [
          "trace=$INERTIA_TEST_GUARDIAN_COMPILER_TRACE",
          "printf 'start %s\\n' $$ >> \"$trace\"",
          "sleep 0.15",
          'for argument do output="$argument"; done',
          "printf 'guardian-%s' $$ > \"$output\"",
          "printf 'end %s\\n' $$ >> \"$trace\"",
          "exit 0",
        ].join("\n"),
      );
      const trace = join(subject.root, "compiler-trace");
      writeSyntheticLock(subject, {
        expiresAtMs: Date.now() + 60_000,
        pid: 2_147_483_647,
        token: "22222222-2222-4222-8222-222222222222",
      });
      const aged = new Date(Date.now() - 4 * 60 * 60_000 - 1_000);
      utimesSync(
        join(
          subject.stateDirectory,
          "owner-22222222-2222-4222-8222-222222222222",
        ),
        aged,
        aged,
      );

      const statuses = await Promise.all([
        buildAsync(subject, trace),
        buildAsync(subject, trace),
      ]);

      expect(statuses).toEqual([0, 0]);
      const events = readFileSync(trace, "utf8").trim().split("\n");
      expect(events).toHaveLength(4);
      expect(events[1]).toBe(events[0].replace("start", "end"));
      expect(events[3]).toBe(events[2].replace("start", "end"));
      expectCleanBuildState(subject);
    });
  },
);

describe.runIf(process.platform === "win32")(
  "native Windows guardian package ownership",
  () => {
    it("bounds a guardian that never emits READY before admitting payload", async () => {
      const subject = fixture("exit 1");
      useNativeWindowsGuardian(subject);
      const marker = join(subject.root, "unadmitted-builder");
      const builder = join(subject.root, "fake-electron-builder.mjs");
      writeFileSync(
        builder,
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");`,
      );
      const startedAt = Date.now();
      await expect(
        runBounded(process.execPath, [builder], {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            INERTIA_TEST_WINDOWS_GUARDIAN_HANG_BEFORE_READY: "1",
            NODE_ENV: "test",
          },
          label: "hung Windows guardian fixture",
          timeoutMs: 5_000,
          windowsJobGuardian: {
            cleanupTimeoutMs: 100,
            integrityPath: subject.integrity,
            path: subject.windowsJob,
            readyTimeoutMs: 50,
          },
        }),
      ).rejects.toThrow("could not establish its Windows Job authority");
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(existsSync(marker)).toBe(false);
    });

    it.each([0, 17])(
      "kills a lingering descendant after builder root exit %s",
      async (exitCode) => {
        const subject = fixture("exit 1");
        useNativeWindowsGuardian(subject);
        const pidFile = join(subject.root, "windows-descendant.pid");
        const stopFile = join(subject.root, "stop-windows-descendant");
        const watchdogFile = join(subject.root, "windows-descendant-watchdog");
        const descendantSource = [
          'import { existsSync, writeFileSync } from "node:fs";',
          `const pidFile = ${JSON.stringify(pidFile)};`,
          `const stopFile = ${JSON.stringify(stopFile)};`,
          `const watchdogFile = ${JSON.stringify(watchdogFile)};`,
          "setTimeout(() => { writeFileSync(watchdogFile, 'expired'); process.exit(124); }, 15_000);",
          "setInterval(() => { if (existsSync(stopFile)) process.exit(0); }, 10);",
          "writeFileSync(pidFile, String(process.pid));",
        ].join("\n");
        const builder = join(subject.root, "fake-electron-builder.mjs");
        writeFileSync(
          builder,
          [
            'import { spawn } from "node:child_process";',
            'import { existsSync } from "node:fs";',
            `const pidFile = ${JSON.stringify(pidFile)};`,
            `const descendant = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(descendantSource)}], { detached: true, stdio: "ignore" });`,
            "descendant.unref();",
            "for (let attempt = 0; attempt < 200 && !existsSync(pidFile); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));",
            "if (!existsSync(pidFile)) process.exit(123);",
            `process.exit(${exitCode});`,
          ].join("\n"),
        );

        let descendantPid: number | null = null;
        let descendantSettled = false;
        try {
          const status = await packageAsync(subject, builder, "win32");
          const parsedPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
          expect(Number.isSafeInteger(parsedPid)).toBe(true);
          expect(parsedPid).toBeGreaterThan(1);
          descendantPid = parsedPid;
          expect(status).not.toBe(0);
          await waitForProcessExit(descendantPid);
          descendantSettled = true;
          expect(existsSync(watchdogFile)).toBe(false);
          expectCleanBuildState(subject);
        } finally {
          writeFileSync(stopFile, "stop");
          if (!descendantSettled) {
            const cleanupPid = descendantPid ?? readFixturePid(pidFile);
            if (cleanupPid !== null) await waitForProcessExit(cleanupPid);
          }
        }
      },
    );

    it("retains native Job cleanup when the JavaScript wrapper is killed", async () => {
      const subject = fixture("exit 1");
      useNativeWindowsGuardian(subject);
      const pidFile = join(subject.root, "windows-builder-pids.json");
      const descendantPidFile = join(
        subject.root,
        "windows-builder-descendant.pid",
      );
      const rootPidFile = join(subject.root, "windows-builder-root.pid");
      const stopFile = join(subject.root, "stop-windows-builder-tree");
      const watchdogFile = join(subject.root, "windows-builder-watchdog");
      const descendantSource = [
        'import { existsSync, writeFileSync } from "node:fs";',
        `const pidFile = ${JSON.stringify(descendantPidFile)};`,
        `const stopFile = ${JSON.stringify(stopFile)};`,
        `const watchdogFile = ${JSON.stringify(watchdogFile)};`,
        "setTimeout(() => { writeFileSync(watchdogFile, 'descendant'); process.exit(124); }, 20_000);",
        "setInterval(() => { if (existsSync(stopFile)) process.exit(0); }, 10);",
        "writeFileSync(pidFile, String(process.pid));",
      ].join("\n");
      const builder = join(subject.root, "fake-electron-builder.mjs");
      writeFileSync(
        builder,
        [
          'import { spawn } from "node:child_process";',
          'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
          `const descendantPidFile = ${JSON.stringify(descendantPidFile)};`,
          `const rootPidFile = ${JSON.stringify(rootPidFile)};`,
          `const stopFile = ${JSON.stringify(stopFile)};`,
          `const watchdogFile = ${JSON.stringify(watchdogFile)};`,
          "setTimeout(() => { writeFileSync(watchdogFile, 'root'); process.exit(124); }, 20_000);",
          "setInterval(() => { if (existsSync(stopFile)) process.exit(0); }, 10);",
          "writeFileSync(rootPidFile, String(process.pid));",
          `spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(descendantSource)}], { stdio: "ignore" });`,
          "for (let attempt = 0; attempt < 1000 && !existsSync(descendantPidFile); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));",
          "if (!existsSync(descendantPidFile)) process.exit(123);",
          "const descendant = Number.parseInt(readFileSync(descendantPidFile, 'utf8'), 10);",
          "if (!Number.isSafeInteger(descendant) || descendant <= 1) process.exit(122);",
          `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ root: process.pid, descendant }));`,
        ].join("\n"),
      );
      const wrapper = packageProcess(subject, builder, "win32");
      if (!Number.isSafeInteger(wrapper.pid) || !wrapper.pid)
        throw new Error("The package wrapper did not start.");
      const wrapperCompletion = new Promise<{
        readonly code?: number | null;
        readonly error?: Error;
        readonly signal?: NodeJS.Signals | null;
      }>((resolveExit) => {
        wrapper.once("error", (error) => resolveExit({ error }));
        wrapper.once("exit", (code, signal) => resolveExit({ code, signal }));
      });
      let pids: {
        readonly root: number;
        readonly descendant: number;
      } | null = null;
      let treeSettled = false;
      try {
        const readinessController = new AbortController();
        const readiness = waitForFile(
          pidFile,
          10_000,
          readinessController.signal,
        );
        try {
          await Promise.race([
            readiness,
            wrapperCompletion.then((result) => {
              if (result.error) throw result.error;
              throw new Error(
                `The package wrapper exited before its builder was ready (${String(result.code ?? result.signal)}).`,
              );
            }),
          ]);
        } finally {
          readinessController.abort();
          await readiness.catch(() => undefined);
        }
        const parsedPids = JSON.parse(readFileSync(pidFile, "utf8")) as {
          readonly root: number;
          readonly descendant: number;
        };
        expect(Number.isSafeInteger(parsedPids.root)).toBe(true);
        expect(parsedPids.root).toBeGreaterThan(1);
        expect(Number.isSafeInteger(parsedPids.descendant)).toBe(true);
        expect(parsedPids.descendant).toBeGreaterThan(1);
        pids = parsedPids;
        expect(wrapper.kill("SIGKILL")).toBe(true);
        const wrapperResult = await wrapperCompletion;
        if (wrapperResult.error) throw wrapperResult.error;
        await Promise.all([
          waitForProcessExit(pids.root),
          waitForProcessExit(pids.descendant),
        ]);
        treeSettled = true;
        expect(existsSync(watchdogFile)).toBe(false);
        const lock = acquireGuardianBuildLock(subject.stateDirectory, {
          timeoutMs: 1_000,
        });
        releaseGuardianBuildLock(lock);
        expectCleanBuildState(subject);
      } finally {
        if (wrapper.exitCode === null && wrapper.signalCode === null) {
          try {
            wrapper.kill("SIGKILL");
          } catch {
            // The retained child handle's completion remains authoritative.
          }
        }
        writeFileSync(stopFile, "stop");
        if (!treeSettled) {
          const cleanupPids = pids
            ? [pids.root, pids.descendant]
            : [
                readFixturePid(rootPidFile),
                readFixturePid(descendantPidFile),
              ].filter((pid) => pid !== null);
          await Promise.all(cleanupPids.map((pid) => waitForProcessExit(pid)));
        }
        await wrapperCompletion;
      }
    }, 30_000);
  },
);

describe("runtime guardian cross-platform publication", () => {
  it("fails closed when interrupted-publication backup evidence is missing", () => {
    const subject = fixture("exit 1");
    const transactionId = "33333333-3333-4333-8333-333333333333";
    mkdirSync(join(subject.stateDirectory, `transaction-${transactionId}`));
    const journal = join(subject.stateDirectory, "publication-journal.json");
    writeFileSync(
      journal,
      JSON.stringify({
        entries: [
          { existed: true, key: "guardian", mode: 0o755 },
          { existed: false, key: "windowsJob", mode: 0o644 },
          { existed: false, key: "integrity", mode: 0o644 },
        ],
        transactionId,
        version: 1,
      }),
    );

    expect(() =>
      recoverGuardianPublication(subject.stateDirectory, {
        guardian: subject.guardian,
        integrity: subject.integrity,
        windowsJob: subject.windowsJob,
      }),
    ).toThrow();

    expect(existsSync(journal)).toBe(true);
    expectKnownGoodArtifacts(subject);
  });

  it.skipIf(process.platform === "win32")(
    "terminates the compiler's complete process group on timeout",
    async () => {
      const subject = fixture(
        [
          "(",
          "  remaining=240",
          '  while [ "$remaining" -gt 0 ]; do',
          '    if [ -e "$INERTIA_TEST_GUARDIAN_COMPILER_TRACE.stop" ]; then exit 0; fi',
          "    remaining=$((remaining - 1))",
          "    sleep 0.05",
          "  done",
          "  printf 'expired' > \"$INERTIA_TEST_GUARDIAN_COMPILER_TRACE.watchdog\"",
          "  exit 124",
          ") &",
          "descendant=$!",
          'printf \'%s\' "$descendant" > "$INERTIA_TEST_GUARDIAN_COMPILER_TRACE"',
          'wait "$descendant"',
        ].join("\n"),
      );
      const pidFile = join(subject.root, "compiler-descendant-pid");
      const stopFile = `${pidFile}.stop`;
      const watchdogFile = `${pidFile}.watchdog`;
      let descendantPid: number | null = null;
      let descendantSettled = false;
      try {
        // The timeout must leave enough admission time for the fixture to
        // publish its descendant PID. Its 12-second watchdog loop still
        // guarantees this five-second result can only come from cleanup.
        const result = build(subject, {
          INERTIA_TEST_GUARDIAN_COMPILER_TIMEOUT_MS: "5000",
          INERTIA_TEST_GUARDIAN_COMPILER_TRACE: pidFile,
        });
        expect(result.status).not.toBe(0);
        const parsedPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
        expect(Number.isSafeInteger(parsedPid)).toBe(true);
        expect(parsedPid).toBeGreaterThan(1);
        descendantPid = parsedPid;
        await waitForProcessExit(descendantPid);
        descendantSettled = true;
        expect(existsSync(watchdogFile)).toBe(false);
        expectKnownGoodArtifacts(subject);
        expectCleanBuildState(subject);
      } finally {
        writeFileSync(stopFile, "stop");
        if (!descendantSettled) {
          const cleanupPid = descendantPid ?? readFixturePid(pidFile);
          if (cleanupPid !== null) await waitForProcessExit(cleanupPid);
        }
      }
    },
    30_000,
  );

  it("restores an entirely absent target set after publication failure", () => {
    const subject = fixture("exit 1");
    rmSync(subject.guardian);
    rmSync(subject.windowsJob);
    rmSync(subject.integrity);
    const staged = join(subject.stateDirectory, "compile-unix");
    writeFileSync(staged, "replacement-guardian");

    expect(() =>
      publishGuardianArtifacts({
        failAfterOperation: 3,
        platform: "linux",
        stagedExecutable: staged,
        stateDirectory: subject.stateDirectory,
        targets: {
          guardian: subject.guardian,
          integrity: subject.integrity,
          windowsJob: subject.windowsJob,
        },
      }),
    ).toThrow("Injected runtime guardian publication failure");

    expect(existsSync(subject.guardian)).toBe(false);
    expect(existsSync(subject.windowsJob)).toBe(false);
    expect(existsSync(subject.integrity)).toBe(false);
    expect(readdirSync(subject.stateDirectory)).toEqual([]);
  });

  it("recovers a crash-interrupted publication before another build", () => {
    const subject = fixture("exit 1");
    const transactionId = "11111111-1111-4111-8111-111111111111";
    const transaction = join(
      subject.stateDirectory,
      `transaction-${transactionId}`,
    );
    mkdirSync(transaction);
    for (const [key, source] of [
      ["guardian", subject.guardian],
      ["windowsJob", subject.windowsJob],
      ["integrity", subject.integrity],
    ] as const) {
      writeFileSync(join(transaction, `${key}.backup`), readFileSync(source));
    }
    writeFileSync(subject.guardian, "interrupted-guardian");
    rmSync(subject.windowsJob);
    writeFileSync(subject.integrity, JSON.stringify({ sha256: null }));
    writeFileSync(
      join(subject.stateDirectory, "publication-journal.json"),
      JSON.stringify({
        entries: [
          { existed: true, key: "guardian", mode: 0o755 },
          { existed: true, key: "windowsJob", mode: 0o644 },
          { existed: true, key: "integrity", mode: 0o644 },
        ],
        transactionId,
        version: 1,
      }),
    );

    expect(
      recoverGuardianPublication(subject.stateDirectory, {
        guardian: subject.guardian,
        integrity: subject.integrity,
        windowsJob: subject.windowsJob,
      }),
    ).toBe(true);

    expectKnownGoodArtifacts(subject);
    expect(readdirSync(subject.stateDirectory)).toEqual([]);
  });

  it("rejects a Windows hash that does not belong to the staged executable", () => {
    const subject = fixture("exit 1");
    const staged = join(subject.stateDirectory, "compile-windows.exe");
    writeFileSync(staged, "replacement-windows-job");

    expect(() =>
      publishGuardianArtifacts({
        expectedWindowsHash: "0".repeat(64),
        platform: "win32",
        stagedExecutable: staged,
        stateDirectory: subject.stateDirectory,
        targets: {
          guardian: subject.guardian,
          integrity: subject.integrity,
          windowsJob: subject.windowsJob,
        },
      }),
    ).toThrow("hash is invalid");

    expectKnownGoodArtifacts(subject);
    expect(readdirSync(subject.stateDirectory)).toEqual([
      "compile-windows.exe",
    ]);
  });

  it("publishes a Windows executable with the hash of that exact stage", () => {
    const subject = fixture("exit 1");
    const staged = join(subject.stateDirectory, "compile-windows.exe");
    writeFileSync(staged, "replacement-windows-job");
    const sha256 = createHash("sha256")
      .update(readFileSync(staged))
      .digest("hex");
    const lock = acquireGuardianBuildLock(subject.stateDirectory);
    try {
      publishGuardianArtifacts({
        expectedWindowsHash: sha256,
        platform: "win32",
        stagedExecutable: staged,
        stateDirectory: subject.stateDirectory,
        targets: {
          guardian: subject.guardian,
          integrity: subject.integrity,
          windowsJob: subject.windowsJob,
        },
      });
    } finally {
      releaseGuardianBuildLock(lock);
    }

    expect(() => statSync(subject.guardian)).toThrow();
    expect(readFileSync(subject.windowsJob, "utf8")).toBe(
      "replacement-windows-job",
    );
    expect(JSON.parse(readFileSync(subject.integrity, "utf8"))).toEqual({
      sha256,
    });
    expect(readdirSync(subject.stateDirectory)).toEqual([]);
  });

  it.each([1, 2, 3])(
    "rolls back every Windows target after publication operation %s fails",
    (operation) => {
      const subject = fixture("exit 1");
      const staged = join(subject.stateDirectory, "compile-windows.exe");
      writeFileSync(staged, "replacement-windows-job");
      const sha256 = createHash("sha256")
        .update(readFileSync(staged))
        .digest("hex");

      expect(() =>
        publishGuardianArtifacts({
          expectedWindowsHash: sha256,
          failAfterOperation: operation,
          platform: "win32",
          stagedExecutable: staged,
          stateDirectory: subject.stateDirectory,
          targets: {
            guardian: subject.guardian,
            integrity: subject.integrity,
            windowsJob: subject.windowsJob,
          },
        }),
      ).toThrow("Injected runtime guardian publication failure");

      expectKnownGoodArtifacts(subject);
      expect(readdirSync(subject.stateDirectory)).toEqual([]);
    },
  );
});

describe.skipIf(process.platform === "win32")(
  "runtime guardian package consumption",
  () => {
    it("refuses a stale Linux guardian before invoking the packager", async () => {
      const subject = fixture("exit 1");
      rmSync(subject.windowsJob);
      writeFileSync(subject.integrity, JSON.stringify({ sha256: null }));
      writeFileSync(subject.bundledIntegrity, JSON.stringify({ sha256: null }));
      writeFileSync(
        subject.guardian,
        [
          "#!/bin/sh",
          '[ "$1" = "seccomp-selftest" ] && exit 0',
          "exit 64",
        ].join("\n"),
        { mode: 0o755 },
      );
      const marker = join(subject.root, "linux-builder-ran");
      const builder = join(subject.root, "fake-electron-builder.mjs");
      writeFileSync(
        builder,
        [
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(marker)}, "ran");`,
        ].join("\n"),
      );

      expect(await packageAsync(subject, builder, "linux")).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
      expectCleanBuildState(subject);
    });

    it("rejects a package target for a different guardian host", async () => {
      const subject = fixture("exit 1");
      const marker = join(subject.root, "cross-host-builder-ran");
      const builder = join(subject.root, "fake-electron-builder.mjs");
      writeFileSync(
        builder,
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");`,
      );
      expect(
        await packageAsync(subject, builder, "linux", {}, ["--win"]),
      ).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
      expectCleanBuildState(subject);
    });

    it("rejects a package architecture different from the guardian host", async () => {
      const subject = fixture("exit 1");
      const marker = join(subject.root, "cross-architecture-builder-ran");
      const builder = join(subject.root, "fake-electron-builder.mjs");
      writeFileSync(
        builder,
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");`,
      );
      const foreignArchitecture =
        process.arch === "arm64" ? "--x64" : "--arm64";
      expect(
        await packageAsync(subject, builder, process.platform, {}, [
          foreignArchitecture,
        ]),
      ).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
      expectCleanBuildState(subject);
    });

    it("admits the rebuilt Linux guardian identity protocol", async () => {
      const subject = fixture("exit 1");
      rmSync(subject.windowsJob);
      writeFileSync(subject.integrity, JSON.stringify({ sha256: null }));
      writeFileSync(subject.bundledIntegrity, JSON.stringify({ sha256: null }));
      writeLinuxIdentityGuardian(subject.guardian);
      const marker = join(subject.root, "linux-builder-ran");
      const builder = join(subject.root, "fake-electron-builder.mjs");
      writeFileSync(
        builder,
        [
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(marker)}, "ran");`,
        ].join("\n"),
      );

      expect(await packageAsync(subject, builder, "linux")).toBe(0);
      expect(readFileSync(marker, "utf8")).toBe("ran");
      expectCleanBuildState(subject);
    });

    it("rejects an empty Linux guardian identity response", async () => {
      const subject = fixture("exit 1");
      rmSync(subject.windowsJob);
      writeFileSync(subject.integrity, JSON.stringify({ sha256: null }));
      writeFileSync(subject.bundledIntegrity, JSON.stringify({ sha256: null }));
      writeFileSync(
        subject.guardian,
        [
          "#!/bin/sh",
          '[ "$1" = "seccomp-selftest-identity" ] && exit 0',
          "exit 64",
        ].join("\n"),
        { mode: 0o755 },
      );
      const marker = join(subject.root, "empty-identity-builder-ran");
      const builder = join(subject.root, "fake-electron-builder.mjs");
      writeFileSync(
        builder,
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");`,
      );
      expect(await packageAsync(subject, builder, "linux")).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
      expectCleanBuildState(subject);
    });

    it("rejects a Linux guardian identity for a different inode", async () => {
      const subject = fixture("exit 1");
      rmSync(subject.windowsJob);
      writeFileSync(subject.integrity, JSON.stringify({ sha256: null }));
      writeFileSync(subject.bundledIntegrity, JSON.stringify({ sha256: null }));
      writeLinuxIdentityGuardian(subject.guardian, 1n);
      const marker = join(subject.root, "wrong-inode-builder-ran");
      const builder = join(subject.root, "fake-electron-builder.mjs");
      writeFileSync(
        builder,
        `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");`,
      );
      expect(await packageAsync(subject, builder, "linux")).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
      expectCleanBuildState(subject);
    });

    it("holds the build lock while a Windows executable and hash are consumed", async () => {
      const subject = fixture(
        [
          "trace=$INERTIA_TEST_GUARDIAN_COMPILER_TRACE",
          "printf 'compile-start\\n' >> \"$trace\"",
          'for argument do output="$argument"; done',
          'printf replacement-guardian > "$output"',
          "printf 'compile-end\\n' >> \"$trace\"",
          "exit 0",
        ].join("\n"),
      );
      rmSync(subject.guardian);
      writeFileSync(subject.windowsJob, "package-windows-job");
      const sha256 = createHash("sha256")
        .update(readFileSync(subject.windowsJob))
        .digest("hex");
      writeFileSync(subject.integrity, JSON.stringify({ sha256 }));
      writeFileSync(subject.bundledIntegrity, JSON.stringify({ sha256 }));
      const trace = join(subject.root, "package-trace");
      const builder = join(subject.root, "fake-electron-builder.mjs");
      writeFileSync(
        builder,
        [
          'import { createHash } from "node:crypto";',
          'import { appendFileSync, readFileSync } from "node:fs";',
          'import { join, resolve } from "node:path";',
          'import { setTimeout as delay } from "node:timers/promises";',
          `const trace = ${JSON.stringify(trace)};`,
          "const output = resolve(process.env.INERTIA_TEST_GUARDIAN_OUTPUT_DIRECTORY);",
          "const executable = join(output, 'windows-runtime-job.exe');",
          "const integrity = join(output, '..', 'windows-runtime-job-integrity.json');",
          "const verify = () => {",
          "  const expected = JSON.parse(readFileSync(integrity, 'utf8')).sha256;",
          "  const actual = createHash('sha256').update(readFileSync(executable)).digest('hex');",
          "  if (actual !== expected) throw new Error('package input mismatch');",
          "};",
          "appendFileSync(trace, 'package-start\\n');",
          "verify();",
          "await delay(200);",
          "verify();",
          "appendFileSync(trace, 'package-end\\n');",
        ].join("\n"),
      );

      const packageResult = packageAsync(subject, builder, "win32");
      await waitForFile(trace);
      const buildResult = buildAsync(subject, trace);

      expect(await Promise.all([packageResult, buildResult])).toEqual([0, 0]);
      expect(readFileSync(trace, "utf8").trim().split("\n")).toEqual([
        "package-start",
        "package-end",
        "compile-start",
        "compile-end",
      ]);
    });

    it("refuses to package when the bundled integrity snapshot is stale", async () => {
      const subject = fixture("exit 1");
      rmSync(subject.guardian);
      writeFileSync(subject.windowsJob, "package-windows-job");
      const sha256 = createHash("sha256")
        .update(readFileSync(subject.windowsJob))
        .digest("hex");
      writeFileSync(subject.integrity, JSON.stringify({ sha256 }));
      writeFileSync(
        subject.bundledIntegrity,
        JSON.stringify({ sha256: "0".repeat(64) }),
      );
      const marker = join(subject.root, "builder-ran");
      const builder = join(subject.root, "fake-electron-builder.mjs");
      writeFileSync(
        builder,
        [
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(marker)}, "ran");`,
        ].join("\n"),
      );

      expect(await packageAsync(subject, builder, "win32")).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
      expectCleanBuildState(subject);
    });

    it("forwards termination and owns the complete builder process tree", async () => {
      const subject = fixture("exit 1");
      rmSync(subject.guardian);
      writeFileSync(subject.windowsJob, "package-windows-job");
      const sha256 = createHash("sha256")
        .update(readFileSync(subject.windowsJob))
        .digest("hex");
      writeFileSync(subject.integrity, JSON.stringify({ sha256 }));
      writeFileSync(subject.bundledIntegrity, JSON.stringify({ sha256 }));
      const pidFile = join(subject.root, "builder-pids.json");
      const builder = join(subject.root, "fake-electron-builder.mjs");
      writeFileSync(
        builder,
        [
          'import { spawn } from "node:child_process";',
          'import { renameSync, writeFileSync } from "node:fs";',
          'const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
          `writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, JSON.stringify({ root: process.pid, descendant: descendant.pid }));`,
          `renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)});`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );
      const wrapper = packageProcess(subject, builder, "win32");
      let rootPid = 0;
      let descendantPid = 0;
      try {
        await waitForFile(pidFile);
        const pids = JSON.parse(readFileSync(pidFile, "utf8")) as {
          readonly root: number;
          readonly descendant: number;
        };
        rootPid = pids.root;
        descendantPid = pids.descendant;
        const wrapperExit = new Promise<number>((resolveExit, reject) => {
          wrapper.once("error", reject);
          wrapper.once("exit", (code) => resolveExit(code ?? -1));
        });
        wrapper.kill("SIGTERM");
        const status = await Promise.race([
          wrapperExit,
          delay(15_000).then(() => -2),
        ]);
        expect(status).not.toBe(-2);
        expect(status).not.toBe(0);
        expect(processExists(rootPid)).toBe(false);
        expect(processExists(descendantPid)).toBe(false);
        expectCleanBuildState(subject);
      } finally {
        for (const pid of [rootPid, descendantPid]) {
          if (pid <= 0 || !processExists(pid)) continue;
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Best-effort cleanup for a failing test-owned process fixture.
          }
        }
      }
    });

    it("aborts packaging when the lock heartbeat detects replacement", async () => {
      const subject = fixture("exit 1");
      rmSync(subject.guardian);
      writeFileSync(subject.windowsJob, "package-windows-job");
      const sha256 = createHash("sha256")
        .update(readFileSync(subject.windowsJob))
        .digest("hex");
      writeFileSync(subject.integrity, JSON.stringify({ sha256 }));
      writeFileSync(subject.bundledIntegrity, JSON.stringify({ sha256 }));
      const started = join(subject.root, "builder-started");
      const builder = join(subject.root, "fake-electron-builder.mjs");
      writeFileSync(
        builder,
        [
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(started)}, "started");`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );
      const wrapper = packageProcess(subject, builder, "win32", {
        INERTIA_TEST_GUARDIAN_HEARTBEAT_INTERVAL_MS: "5",
      });
      const wrapperExit = new Promise<number>((resolveExit, reject) => {
        wrapper.once("error", reject);
        wrapper.once("exit", (code) => resolveExit(code ?? -1));
      });
      await waitForFile(started);
      const lockPath = join(subject.stateDirectory, "build.lock");
      rmSync(lockPath);
      writeFileSync(lockPath, "replacement-owner");

      const status = await Promise.race([
        wrapperExit,
        delay(15_000).then(() => -2),
      ]);
      expect(status).not.toBe(-2);
      expect(status).not.toBe(0);
      expect(readFileSync(lockPath, "utf8")).toBe("replacement-owner");
      rmSync(lockPath);
      expectCleanBuildState(subject);
    });

    it("does not swallow a signal after the builder has settled", async () => {
      const subject = fixture("exit 1");
      rmSync(subject.guardian);
      writeFileSync(subject.windowsJob, "package-windows-job");
      const sha256 = createHash("sha256")
        .update(readFileSync(subject.windowsJob))
        .digest("hex");
      writeFileSync(subject.integrity, JSON.stringify({ sha256 }));
      writeFileSync(subject.bundledIntegrity, JSON.stringify({ sha256 }));
      const completed = join(subject.root, "builder-completed");
      const settled = join(subject.root, "wrapper-builder-settled");
      const builder = join(subject.root, "fake-electron-builder.mjs");
      writeFileSync(
        builder,
        [
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(completed)}, "completed");`,
        ].join("\n"),
      );
      const wrapper = packageProcess(subject, builder, "win32", {
        INERTIA_TEST_POST_BUILDER_DELAY_MS: "500",
        INERTIA_TEST_POST_BUILDER_MARKER: settled,
      });
      const wrapperExit = new Promise<number>((resolveExit, reject) => {
        wrapper.once("error", reject);
        wrapper.once("exit", (code) => resolveExit(code ?? -1));
      });
      await waitForFile(completed);
      await waitForFile(settled);
      wrapper.kill("SIGTERM");

      expect(await wrapperExit).not.toBe(0);
      expectCleanBuildState(subject);
    });

    it("does not swallow a signal during final lock cleanup", async () => {
      const subject = fixture("exit 1");
      rmSync(subject.guardian);
      writeFileSync(subject.windowsJob, "package-windows-job");
      const sha256 = createHash("sha256")
        .update(readFileSync(subject.windowsJob))
        .digest("hex");
      writeFileSync(subject.integrity, JSON.stringify({ sha256 }));
      writeFileSync(subject.bundledIntegrity, JSON.stringify({ sha256 }));
      const marker = join(subject.root, "wrapper-final-cleanup");
      const builder = join(subject.root, "fake-electron-builder.mjs");
      writeFileSync(builder, "// exits successfully\n");
      const wrapper = packageProcess(subject, builder, "win32", {
        INERTIA_TEST_FINAL_CLEANUP_DELAY_MS: "500",
        INERTIA_TEST_FINAL_CLEANUP_MARKER: marker,
      });
      const wrapperExit = new Promise<number>((resolveExit, reject) => {
        wrapper.once("error", reject);
        wrapper.once("exit", (code) => resolveExit(code ?? -1));
      });
      await waitForFile(marker);
      wrapper.kill("SIGTERM");
      expect(await wrapperExit).not.toBe(0);
      expectCleanBuildState(subject);
    });

    it("fails if the lock heartbeat is compromised after the builder settles", async () => {
      const subject = fixture("exit 1");
      rmSync(subject.guardian);
      writeFileSync(subject.windowsJob, "package-windows-job");
      const sha256 = createHash("sha256")
        .update(readFileSync(subject.windowsJob))
        .digest("hex");
      writeFileSync(subject.integrity, JSON.stringify({ sha256 }));
      writeFileSync(subject.bundledIntegrity, JSON.stringify({ sha256 }));
      const marker = join(subject.root, "wrapper-post-builder");
      const builder = join(subject.root, "fake-electron-builder.mjs");
      writeFileSync(builder, "// exits successfully\n");
      const wrapper = packageProcess(subject, builder, "win32", {
        INERTIA_TEST_GUARDIAN_HEARTBEAT_INTERVAL_MS: "5",
        INERTIA_TEST_POST_BUILDER_DELAY_MS: "500",
        INERTIA_TEST_POST_BUILDER_MARKER: marker,
      });
      const wrapperExit = new Promise<number>((resolveExit, reject) => {
        wrapper.once("error", reject);
        wrapper.once("exit", (code) => resolveExit(code ?? -1));
      });
      await waitForFile(marker);
      const lockPath = join(subject.stateDirectory, "build.lock");
      rmSync(lockPath);
      writeFileSync(lockPath, "replacement-owner");
      expect(await wrapperExit).not.toBe(0);
      expect(readFileSync(lockPath, "utf8")).toBe("replacement-owner");
      rmSync(lockPath);
      expectCleanBuildState(subject);
    });

    it("fails if the lock heartbeat is compromised during final cleanup", async () => {
      const subject = fixture("exit 1");
      rmSync(subject.guardian);
      writeFileSync(subject.windowsJob, "package-windows-job");
      const sha256 = createHash("sha256")
        .update(readFileSync(subject.windowsJob))
        .digest("hex");
      writeFileSync(subject.integrity, JSON.stringify({ sha256 }));
      writeFileSync(subject.bundledIntegrity, JSON.stringify({ sha256 }));
      const marker = join(subject.root, "wrapper-final-heartbeat");
      const builder = join(subject.root, "fake-electron-builder.mjs");
      writeFileSync(builder, "// exits successfully\n");
      const wrapper = packageProcess(subject, builder, "win32", {
        INERTIA_TEST_FINAL_CLEANUP_DELAY_MS: "500",
        INERTIA_TEST_FINAL_CLEANUP_MARKER: marker,
        INERTIA_TEST_GUARDIAN_HEARTBEAT_INTERVAL_MS: "5",
      });
      const wrapperExit = new Promise<number>((resolveExit, reject) => {
        wrapper.once("error", reject);
        wrapper.once("exit", (code) => resolveExit(code ?? -1));
      });
      await waitForFile(marker);
      const lockPath = join(subject.stateDirectory, "build.lock");
      rmSync(lockPath);
      writeFileSync(lockPath, "replacement-owner");
      expect(await wrapperExit).not.toBe(0);
      expect(readFileSync(lockPath, "utf8")).toBe("replacement-owner");
      rmSync(lockPath);
      expectCleanBuildState(subject);
    });

    it("reclaims cleanup-unconfirmed authority after the exact child exits", async () => {
      const subject = fixture("exit 1");
      rmSync(subject.guardian);
      writeFileSync(subject.windowsJob, "package-windows-job");
      const sha256 = createHash("sha256")
        .update(readFileSync(subject.windowsJob))
        .digest("hex");
      writeFileSync(subject.integrity, JSON.stringify({ sha256 }));
      writeFileSync(subject.bundledIntegrity, JSON.stringify({ sha256 }));
      const builder = join(subject.root, "fake-electron-builder.mjs");
      writeFileSync(builder, "// exits successfully\n");
      expect(
        await packageAsync(subject, builder, "win32", {
          INERTIA_TEST_PROCESS_TREE_CLEANUP_UNCONFIRMED: "1",
        }),
      ).not.toBe(0);
      expect(existsSync(join(subject.stateDirectory, "build.lock"))).toBe(true);
      const childName = readdirSync(subject.stateDirectory).find((name) =>
        name.startsWith("child-"),
      );
      if (!childName)
        throw new Error("The quarantined child authority is missing.");
      const childPath = join(subject.stateDirectory, childName);
      expect(JSON.parse(readFileSync(childPath, "utf8")).state).toBe(
        "cleanup-unconfirmed",
      );
      const recovered = acquireGuardianBuildLock(subject.stateDirectory, {
        timeoutMs: 1_500,
      });
      releaseGuardianBuildLock(recovered);
      expectCleanBuildState(subject);
    });

    it("keeps a killed wrapper lock bound to its live builder process group", async () => {
      const subject = fixture("exit 1");
      rmSync(subject.guardian);
      writeFileSync(subject.windowsJob, "package-windows-job");
      const sha256 = createHash("sha256")
        .update(readFileSync(subject.windowsJob))
        .digest("hex");
      writeFileSync(subject.integrity, JSON.stringify({ sha256 }));
      writeFileSync(subject.bundledIntegrity, JSON.stringify({ sha256 }));
      const pidFile = join(subject.root, "orphaned-builder-pids.json");
      const builder = join(subject.root, "fake-electron-builder.mjs");
      writeFileSync(
        builder,
        [
          'import { spawn } from "node:child_process";',
          'import { writeFileSync } from "node:fs";',
          'const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
          `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ root: process.pid, descendant: descendant.pid }));`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );
      const wrapper = packageProcess(subject, builder, "win32");
      await waitForFile(pidFile);
      const pids = JSON.parse(readFileSync(pidFile, "utf8")) as {
        readonly root: number;
        readonly descendant: number;
      };
      const authorityName = readdirSync(subject.stateDirectory).find((name) =>
        name.startsWith("child-"),
      );
      if (!authorityName)
        throw new Error("The package child authority was not recorded.");
      const authority = JSON.parse(
        readFileSync(join(subject.stateDirectory, authorityName), "utf8"),
      ) as { readonly processGroupId: number };
      const wrapperExit = new Promise<void>((resolveExit) => {
        wrapper.once("exit", () => resolveExit());
      });
      wrapper.kill("SIGKILL");
      await wrapperExit;
      try {
        expect(() =>
          acquireGuardianBuildLock(subject.stateDirectory, {
            timeoutMs: 40,
          }),
        ).toThrow("Timed out waiting");
      } finally {
        process.kill(-authority.processGroupId, "SIGKILL");
        await waitForProcessExit(pids.root);
        await waitForProcessExit(pids.descendant);
      }
      const lock = acquireGuardianBuildLock(subject.stateDirectory, {
        timeoutMs: 200,
      });
      releaseGuardianBuildLock(lock);
      expectCleanBuildState(subject);
    });
  },
);

describe("runtime guardian package contract", () => {
  it("emits the exact integrity value compiled into the main bundle", () => {
    interface EmittedAsset {
      readonly fileName?: string;
      readonly source?: string | Uint8Array;
      readonly type: string;
    }
    interface IntegrityPlugin {
      readonly name?: string;
      generateBundle?: (this: { emitFile(asset: EmittedAsset): void }) => void;
    }
    const config = electronViteConfig as unknown as {
      readonly main?: {
        readonly define?: Record<string, string>;
        readonly plugins?: IntegrityPlugin[];
      };
    };
    const plugin = config.main?.plugins?.find(
      (candidate) =>
        candidate.name === "windows-runtime-job-integrity-snapshot",
    );
    let emitted: EmittedAsset | undefined;
    plugin?.generateBundle?.call({
      emitFile(asset) {
        emitted = asset;
      },
    });
    const generated = JSON.parse(
      readFileSync(
        join(
          repositoryRoot,
          "resources",
          "generated",
          "windows-runtime-job-integrity.json",
        ),
        "utf8",
      ),
    ) as { readonly sha256: string | null };

    expect(config.main?.define?.__INERTIA_WINDOWS_RUNTIME_JOB_SHA256__).toBe(
      JSON.stringify(generated.sha256),
    );
    expect(emitted?.type).toBe("asset");
    expect(emitted?.fileName).toBe(
      "windows-runtime-job-bundled-integrity.json",
    );
    expect(JSON.parse(String(emitted?.source))).toEqual(generated);
  });

  it("keeps the emitted Vite sidecar identical to the compiled main value", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-integrity-bundle-"));
    roots.push(root);
    const config = electronViteConfig as unknown as {
      readonly main?: InlineConfig;
    };
    if (!config.main)
      throw new Error("The Electron main Vite config is unavailable.");
    await viteBuild({
      ...config.main,
      build: {
        ...config.main.build,
        emptyOutDir: true,
        outDir: root,
        ssr: true,
      },
      configFile: false,
    });
    const generated = JSON.parse(
      readFileSync(
        join(
          repositoryRoot,
          "resources/generated/windows-runtime-job-integrity.json",
        ),
        "utf8",
      ),
    ) as { readonly sha256: string | null };
    const sidecar = JSON.parse(
      readFileSync(
        join(root, "windows-runtime-job-bundled-integrity.json"),
        "utf8",
      ),
    );
    const index = readFileSync(join(root, "index.js"), "utf8");
    const expectedLiteral = JSON.stringify(generated.sha256);

    expect(sidecar).toEqual(generated);
    expect(index).toContain(
      [
        "const windowsRuntimeJobIntegrity = Object.freeze({",
        `  sha256: ${expectedLiteral}`,
        "});",
      ].join("\n"),
    );
  }, 30_000);

  it("keeps the Windows compiler and transactional package contract explicit", () => {
    const buildSource = readFileSync(script, "utf8");
    const packageSource = readFileSync(packageScript, "utf8");
    const boundedSource = readFileSync(
      join(repositoryRoot, "scripts/bounded-process-tree.mjs"),
      "utf8",
    );
    const trampolineSource = readFileSync(
      join(repositoryRoot, "scripts/bounded-command-trampoline.mjs"),
      "utf8",
    );
    const windowsGuardianSource = readFileSync(
      join(repositoryRoot, "native/runtime-process-guardian/windows.cs"),
      "utf8",
    );
    const manifest = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(buildSource).toContain('"/platform:anycpu"');
    expect(buildSource).toContain("runBootstrapLeaf(compiler");
    expect(buildSource).toContain("integrityPath: bootstrapIntegrity");
    expect(buildSource).toContain("publishGuardianArtifacts({");
    expect(packageSource).toContain("acquireGuardianBuildLock(stateDirectory)");
    expect(packageSource).toContain("startGuardianBuildLockHeartbeat(lock");
    expect(packageSource).toContain("validateBundledGuardianIntegrity()");
    expect(packageSource).toContain(
      'spawnSync(targets.guardian, ["seccomp-selftest-identity"]',
    );
    expect(boundedSource).toContain('"guard-owned"');
    expect(boundedSource).toContain("bounded-command-trampoline.mjs");
    expect(trampolineSource).toContain('admission !== "GO"');
    expect(windowsGuardianSource).toContain("public static int GuardOwned(");
    expect(windowsGuardianSource).toContain(
      "ExpectedParent(processId, expectedParent)",
    );
    expect(windowsGuardianSource).toContain("residualProcesses == 0 ? 0 : 28");
    expect(
      packageSource.match(/validateGuardianArtifactSet/gu)?.length,
    ).toBeGreaterThanOrEqual(3);
    for (const [name, value] of Object.entries(manifest.scripts)) {
      if (!name.startsWith("package:")) continue;
      expect(value).toContain("scripts/run-electron-builder.mjs");
    }
    expect(manifest.scripts["prebuild:bundle"]).toBe(
      "node scripts/build-runtime-process-guardian.mjs",
    );
  });
});
