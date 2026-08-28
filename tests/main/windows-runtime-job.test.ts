import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, win32 } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  armWindowsRuntimeJob,
  recoverWindowsRuntimeJob,
  resolveRequiredWindowsRuntimeJobAssembly,
  validateWindowsRuntimeJobAssembly,
  windowsRuntimeJobName,
  windowsRuntimeJobEnvironment,
  windowsRuntimeProcessCreationIdentity,
  waitForWindowsRuntimeProcessCreationIdentity,
} from "../../src/main/windows-runtime-job";

const runtimeGenerationId = "20000000-0000-4000-8000-000000000002:1";
const runtimeCreationTimeMs = 1_700_000_000_123.456;
const runtimeCreationTimeBits = "4789786004267972428";
const stubAssembly = {
  path: resolve("/trusted/windows-runtime-job.exe"),
  root: resolve("/trusted"),
  sha256: "a".repeat(64),
} as const;
const children = new Set<ChildProcessWithoutNullStreams>();

function nodeChild(source: string): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, ["-e", source], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
}

function protocolChild(stderr: string): ChildProcessWithoutNullStreams {
  const stderrStream = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: stderrStream,
    exitCode: null,
    signalCode: null,
    kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams;
  queueMicrotask(() => stderrStream.write(stderr));
  return child;
}

function realWindowsRuntimeJobAssembly() {
  const assembly = resolveRequiredWindowsRuntimeJobAssembly({
    platform: "win32",
    locations: {
      isPackaged: false,
      resourcesPath: process.cwd(),
      appPath: process.cwd(),
    },
  });
  if (!assembly) throw new Error("The generated Windows Job Object assembly is unavailable.");
  return assembly;
}

async function closeChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!children.has(child)) return;
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
}

async function windowsProcessCreationIdentity(pid: number): Promise<string> {
  const trustedEnvironment = windowsRuntimeJobEnvironment(process.env);
  const systemRoot = trustedEnvironment?.SystemRoot;
  if (!trustedEnvironment || !systemRoot) {
    throw new Error("Trusted Windows runtime environment is unavailable.");
  }
  const script = `$process = [Diagnostics.Process]::GetProcessById(${pid})
try {
  $unixMicroseconds = [Math]::Floor(
    ($process.StartTime.ToUniversalTime().Ticks - 621355968000000000) / 10
  )
  $creationTimeMs = [double]$unixMicroseconds / 1000.0
  [Console]::Out.Write([BitConverter]::DoubleToInt64Bits($creationTimeMs))
} finally {
  $process.Dispose()
}`;
  const child = spawn(win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  ), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ], {
    env: trustedEnvironment,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const code = await new Promise<number | null>((resolve) => {
    child.once("close", resolve);
  });
  const creationIdentity = stdout.replaceAll("\0", "").trim();
  if (code !== 0 || !/^[1-9][0-9]{0,18}$/u.test(creationIdentity)) {
    throw new Error(`Could not read the Windows process creation time: ${stderr}`);
  }
  return creationIdentity;
}

afterEach(async () => {
  const closing = [...children].map(async (child) => {
    child.kill("SIGKILL");
    await closeChild(child);
  });
  await Promise.all(closing);
});

describe("Windows runtime Job Object containment", () => {
  it("accepts exactly one bounded Utility process creation identity", () => {
    expect(windowsRuntimeProcessCreationIdentity([
      {
        pid: 4_242, creationTime: runtimeCreationTimeMs,
        name: "Inertia Runtime", type: "Utility",
      },
    ], 4_242)).toBe(runtimeCreationTimeBits);

    expect(() => windowsRuntimeProcessCreationIdentity([], 4_242)).toThrow(
      "process metric is not unique",
    );
    expect(() => windowsRuntimeProcessCreationIdentity([
      {
        pid: 4_242, creationTime: runtimeCreationTimeMs,
        name: "Inertia Runtime", type: "Utility",
      },
      {
        pid: 4_242, creationTime: runtimeCreationTimeMs,
        name: "Inertia Runtime", type: "Utility",
      },
    ], 4_242)).toThrow("process metric is not unique");
    expect(() => windowsRuntimeProcessCreationIdentity([
      {
        pid: 4_242, creationTime: runtimeCreationTimeMs,
        name: "Inertia Runtime", type: "GPU",
      },
    ], 4_242)).toThrow("process metric is not unique");
    expect(() => windowsRuntimeProcessCreationIdentity([
      {
        pid: 4_242, creationTime: runtimeCreationTimeMs,
        name: "Other Utility", type: "Utility",
      },
    ], 4_242)).toThrow("process metric is not unique");
    for (const creationTime of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => windowsRuntimeProcessCreationIdentity([
        {
          pid: 4_242, creationTime,
          name: "Inertia Runtime", type: "Utility",
        },
      ], 4_242)).toThrow("creation identity is invalid");
    }
  });

  it("waits boundedly for Electron to publish the exact Utility metric", async () => {
    let reads = 0;
    let yields = 0;
    let now = 0;
    await expect(waitForWindowsRuntimeProcessCreationIdentity(() => {
      reads += 1;
      return reads === 1 ? [
        {
          pid: 9_999, creationTime: runtimeCreationTimeMs,
          name: "Inertia Runtime", type: "Utility",
        },
        {
          pid: 4_242, creationTime: runtimeCreationTimeMs,
          name: "Inertia Runtime", type: "GPU",
        },
        {
          pid: 4_242, creationTime: runtimeCreationTimeMs,
          name: "Other Utility", type: "Utility",
        },
      ] : [{
        pid: 4_242,
        creationTime: runtimeCreationTimeMs,
        name: "Inertia Runtime",
        type: "Utility",
      }];
    }, 4_242, {
      timeoutMs: 100,
      now: () => now,
      yieldTurn: async () => { yields += 1; now += 10; },
    })).resolves.toBe(runtimeCreationTimeBits);
    expect({ reads, yields }).toEqual({ reads: 2, yields: 2 });

    await expect(waitForWindowsRuntimeProcessCreationIdentity(
      () => [],
      4_242,
      {
        timeoutMs: 2,
        now: (() => { let time = 0; return () => time++; })(),
        yieldTurn: async () => undefined,
      },
    )).rejects.toThrow("process metric is unavailable");

    await expect(waitForWindowsRuntimeProcessCreationIdentity(
      () => Array.from({ length: 1_025 }, (_, pid) => ({
        pid: pid + 2,
        creationTime: runtimeCreationTimeMs,
        name: "Inertia Runtime",
        type: "Utility",
      })),
      4_242,
      { timeoutMs: 1, now: () => 0, yieldTurn: async () => undefined },
    )).rejects.toThrow("process metrics are oversized");

    await expect(waitForWindowsRuntimeProcessCreationIdentity(
      () => [],
      4_242,
      {
        shouldContinue: () => false,
        yieldTurn: async () => undefined,
      },
    )).rejects.toThrow("admission is no longer current");
  });

  it("derives one bounded cross-session Job Object name", () => {
    expect(windowsRuntimeJobName(runtimeGenerationId)).toMatch(
      /^Global\\InertiaRuntime-[0-9a-f]{64}$/u,
    );
    expect(() => windowsRuntimeJobName("../not-a-generation")).toThrow(
      "runtime generation identity is invalid",
    );
  });

  it("uses a bounded trusted runtime environment and never inherits user secrets", () => {
    expect(windowsRuntimeJobEnvironment({
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Users\\Test\\AppData\\Local\\Temp",
      PATH: "C:\\attacker",
      SECRET_TOKEN: "must-not-be-inherited",
    })).toEqual({
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATH: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      SYSTEMROOT: "C:\\Windows",
      WINDIR: "C:\\Windows",
      TEMP: "C:\\Users\\Test\\AppData\\Local\\Temp",
      TMP: "C:\\Users\\Test\\AppData\\Local\\Temp",
    });
    expect(windowsRuntimeJobEnvironment({ SystemRoot: "relative" }))
      .toBeNull();
  });

  it("accepts only one bounded direct precompiled executable", () => {
    const directory = mkdtempSync(join(process.cwd(), ".windows-job-assembly-"));
    try {
      const root = join(directory, "runtime");
      mkdirSync(root);
      const path = join(root, "windows-runtime-job.exe");
      const bytes = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
      writeFileSync(path, bytes);
      const assembly = {
        path,
        root,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      expect(validateWindowsRuntimeJobAssembly(assembly)).toEqual({
        path: resolve(path),
        root: resolve(root),
        sha256: assembly.sha256,
      });
      writeFileSync(path, Buffer.from([0x4d, 0x5a, 0x91, 0x00]));
      expect(() => validateWindowsRuntimeJobAssembly(assembly)).toThrow(
        "integrity check failed",
      );
      writeFileSync(path, Buffer.alloc(1024 * 1024 + 1));
      expect(() => validateWindowsRuntimeJobAssembly(assembly)).toThrow(
        "missing or invalid",
      );
      writeFileSync(path, bytes);

      const portableTarget = join(directory, "portable-target");
      mkdirSync(portableTarget);
      const portableRoot = join(portableTarget, "runtime");
      mkdirSync(portableRoot);
      writeFileSync(join(portableRoot, "windows-runtime-job.exe"), bytes);
      const portableLink = join(directory, "portable-link");
      symlinkSync(
        portableTarget,
        portableLink,
        process.platform === "win32" ? "junction" : "dir",
      );
      const portableAssembly = {
        path: join(portableLink, "runtime", "windows-runtime-job.exe"),
        root: join(portableLink, "runtime"),
        sha256: assembly.sha256,
      };
      expect(validateWindowsRuntimeJobAssembly(portableAssembly)).toEqual({
        path: resolve(portableAssembly.path),
        root: resolve(portableAssembly.root),
        sha256: assembly.sha256,
      });

      const linkedRoot = join(directory, "linked-runtime");
      symlinkSync(root, linkedRoot, process.platform === "win32" ? "junction" : "dir");
      expect(() => validateWindowsRuntimeJobAssembly({
        path: join(linkedRoot, "windows-runtime-job.exe"),
        root: linkedRoot,
        sha256: assembly.sha256,
      })).toThrow("path is not direct");

      rmSync(path);
      symlinkSync(
        join(portableRoot, "windows-runtime-job.exe"),
        path,
        "file",
      );
      expect(() => validateWindowsRuntimeJobAssembly(assembly)).toThrow(
        "path is not direct",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not arm containment until the native helper reports READY", async () => {
    let helper: ChildProcessWithoutNullStreams | null = null;
    const containment = await armWindowsRuntimeJob(
      runtimeGenerationId,
      4_242,
      {
        platform: "win32",
        assembly: stubAssembly,
        runtimeCreationTimeBits,
        timeoutMs: 1_000,
        spawnProcess: () => {
          helper = nodeChild(
            "setTimeout(() => console.log('READY'), 20); setInterval(() => undefined, 1000)",
          );
          return helper;
        },
      },
    );

    expect(containment).toEqual({
      kind: "windows-job-v1",
      name: windowsRuntimeJobName(runtimeGenerationId),
    });
    expect(helper).not.toBeNull();
    helper!.kill("SIGKILL");
    await closeChild(helper!);
  });

  it("launches only the exact verified native executable and bounded arguments", async () => {
    let executable = "";
    let arguments_: readonly string[] = [];
    let helper: ChildProcessWithoutNullStreams | null = null;
    await armWindowsRuntimeJob(runtimeGenerationId, 4_242, {
      platform: "win32",
      assembly: stubAssembly,
      runtimeCreationTimeBits,
      timeoutMs: 1_000,
      spawnProcess: (candidate, candidateArguments) => {
        executable = candidate;
        arguments_ = candidateArguments;
        helper = nodeChild(
          "process.stdout.write('READY\\n'); setInterval(() => undefined, 1000)",
        );
        return helper;
      },
    });

    expect(executable).toBe(resolve("/trusted/windows-runtime-job.exe"));
    expect(arguments_).toEqual([
      "guard",
      windowsRuntimeJobName(runtimeGenerationId),
      "4242",
      runtimeCreationTimeBits,
      stubAssembly.sha256,
    ]);

    const nativeSource = readFileSync(
      resolve(process.cwd(), "native/runtime-process-guardian/windows.cs"),
      "utf8",
    );
    expect(nativeSource).toContain("CultureInfo.InvariantCulture");
    expect(nativeSource).not.toContain("OpenProcess(");
    expect(nativeSource).toContain("VerifyExecutableIntegrity(");
    expect(nativeSource).toContain("Process.GetProcessById(");
    expect(nativeSource).toContain("GetProcessTimes(");
    expect(nativeSource).toContain("read-process-identity");
    expect(nativeSource).toContain("process-identity-mismatch");
    expect(nativeSource.indexOf("CreationIdentityStatus("))
      .toBeLessThan(nativeSource.indexOf("IntPtr job = CreateJobObject("));

    helper!.kill("SIGKILL");
    await closeChild(helper!);
  });

  it("gives the direct native executable one bounded startup window", async () => {
    let helper: ChildProcessWithoutNullStreams | null = null;
    const containment = await armWindowsRuntimeJob(
      runtimeGenerationId,
      4_242,
      {
        platform: "win32",
        assembly: stubAssembly,
        runtimeCreationTimeBits,
        timeoutMs: 500,
        spawnProcess: () => {
          helper = nodeChild(
            "setTimeout(() => {"
            + "process.stderr.write('INERTIA_JOB_STAGE stage=native-guard-start\\n');"
            + "process.stdout.write('READY\\n');"
            + "}, 350);"
            + "setInterval(() => undefined, 1000)",
          );
          return helper;
        },
      },
    );

    expect(containment).toEqual({
      kind: "windows-job-v1",
      name: windowsRuntimeJobName(runtimeGenerationId),
    });
    helper!.kill("SIGKILL");
    await closeChild(helper!);
  });

  it("reports the last bounded helper startup stage on timeout", async () => {
    await expect(armWindowsRuntimeJob(runtimeGenerationId, 4_242, {
      platform: "win32",
      assembly: stubAssembly,
      runtimeCreationTimeBits,
      timeoutMs: 100,
      spawnProcess: () => protocolChild(
        "INERTIA_JOB_STAGE stage=native-guard-start\n",
      ),
    })).rejects.toThrow(
      "The native helper did not report readiness within 100ms after Guard started. "
      + "INERTIA_JOB_STAGE stage=native-guard-start",
    );
  });

  it("keeps native arming fail closed after the startup window", async () => {
    await expect(armWindowsRuntimeJob(runtimeGenerationId, 4_242, {
      platform: "win32",
      assembly: stubAssembly,
      runtimeCreationTimeBits,
      timeoutMs: 100,
      spawnProcess: () => protocolChild(
        "INERTIA_JOB_STAGE stage=native-guard-start\n",
      ),
    })).rejects.toThrow(
      "The native helper did not report readiness within 100ms after Guard started.",
    );
  });

  it("fails closed when the native helper exits before readiness", async () => {
    await expect(armWindowsRuntimeJob(runtimeGenerationId, 4_242, {
      platform: "win32",
      assembly: stubAssembly,
      runtimeCreationTimeBits,
      timeoutMs: 1_000,
      spawnProcess: () => nodeChild("process.exit(17)"),
    })).rejects.toThrow(
      "The Windows runtime Job Object could not be armed. "
      + "The native helper exited with code 17.",
    );
  });

  it("reports bounded native stage diagnostics with the helper exit code", async () => {
    const failure = await armWindowsRuntimeJob(runtimeGenerationId, 4_242, {
      platform: "win32",
      assembly: stubAssembly,
      runtimeCreationTimeBits,
      timeoutMs: 1_000,
      spawnProcess: () => nodeChild(
        "process.stderr.write('INERTIA_JOB_ERROR stage=assign-process win32=5\\n');"
        + "process.stderr.write('x'.repeat(10_000));"
        + "process.exit(13)",
      ),
    }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "The Windows runtime Job Object could not be armed. "
      + "The native helper exited with code 13. "
      + "INERTIA_JOB_ERROR stage=assign-process win32=5",
    );
    expect((failure as Error).message.length).toBeLessThanOrEqual(650);
  });

  it("accepts recovery only after the exact named job helper succeeds", async () => {
    let executable = "";
    let arguments_: readonly string[] = [];
    await expect(recoverWindowsRuntimeJob({
      kind: "windows-job-v1",
      name: windowsRuntimeJobName(runtimeGenerationId),
    }, Date.now() + 1_000, {
      platform: "win32",
      assembly: stubAssembly,
      spawnProcess: (candidate, candidateArguments) => {
        executable = candidate;
        arguments_ = candidateArguments;
        return nodeChild("process.exit(0)");
      },
    })).resolves.toBe(true);
    expect(executable).toBe(resolve("/trusted/windows-runtime-job.exe"));
    expect(arguments_).toEqual([
      "recover",
      windowsRuntimeJobName(runtimeGenerationId),
      stubAssembly.sha256,
    ]);

    await expect(recoverWindowsRuntimeJob({
      kind: "windows-job-v1",
      name: windowsRuntimeJobName(runtimeGenerationId),
    }, Date.now() + 1_000, {
      platform: "win32",
      assembly: stubAssembly,
      spawnProcess: () => nodeChild("process.exit(21)"),
    })).resolves.toBe(false);

    await expect(recoverWindowsRuntimeJob({
      kind: "windows-job-v1",
      name: windowsRuntimeJobName(runtimeGenerationId),
    }, Date.now() + 1_000, {
      platform: "win32",
      assembly: stubAssembly,
      // Native exit 22 means OpenJobObject failed for a reason other than
      // ERROR_FILE_NOT_FOUND and must never be projected as an absent job.
      spawnProcess: () => nodeChild("process.exit(22)"),
    })).resolves.toBe(false);
  });

  it.runIf(process.platform === "win32")(
    "reports a real native Windows helper failure through bounded UTF-8 stderr",
    async () => {
      const generation = "30000000-0000-4000-8000-000000000004:1";
      const failure = await armWindowsRuntimeJob(generation, 4_294_967_294, {
        assembly: realWindowsRuntimeJobAssembly(),
        runtimeCreationTimeBits,
      })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(
        "The native helper exited with code 12.",
      );
      expect((failure as Error).message).toContain(
        "INERTIA_JOB_ERROR stage=capture-process-handle",
      );
      expect((failure as Error).message).not.toContain(
        "INERTIA_JOB_STAGE stage=native-guard-start",
      );
    },
    95_000,
  );

  it.runIf(process.platform === "win32")(
    "arms and cleans up a real Job Object around a disposable child",
    async () => {
      const generation = "30000000-0000-4000-8000-000000000003:1";
      const child = nodeChild("setInterval(() => undefined, 1_000)");
      if (!child.pid) throw new Error("The disposable child did not start.");

      const creationIdentity = await windowsProcessCreationIdentity(child.pid);
      const assembly = realWindowsRuntimeJobAssembly();
      const containment = await armWindowsRuntimeJob(generation, child.pid, {
        assembly,
        runtimeCreationTimeBits: creationIdentity,
      });
      if (!containment) throw new Error("Windows Job Object containment was unavailable.");
      expect(containment).toEqual({
        kind: "windows-job-v1",
        name: windowsRuntimeJobName(generation),
      });

      const cleanup = recoverWindowsRuntimeJob(
        containment,
        Date.now() + 5_000,
        { assembly },
      );
      child.kill("SIGKILL");
      await closeChild(child);
      await expect(cleanup).resolves.toBe(true);
    },
    95_000,
  );

  it.runIf(process.platform === "win32")(
    "recovers an active named Job Object through a fresh module after restart",
    async () => {
      const generation = "30000000-0000-4000-8000-000000000005:1";
      const child = nodeChild("setInterval(() => undefined, 1_000)");
      if (!child.pid) throw new Error("The disposable child did not start.");
      const assembly = realWindowsRuntimeJobAssembly();
      const creationIdentity = await windowsProcessCreationIdentity(child.pid);
      const containment = await armWindowsRuntimeJob(generation, child.pid, {
        assembly,
        runtimeCreationTimeBits: creationIdentity,
      });
      if (!containment) throw new Error("Windows Job Object containment was unavailable.");

      vi.resetModules();
      const restarted = await import("../../src/main/windows-runtime-job");
      expect(restarted.recoverWindowsRuntimeJob).not.toBe(recoverWindowsRuntimeJob);
      await expect(restarted.recoverWindowsRuntimeJob(
        containment,
        Date.now() + 10_000,
        { assembly },
      )).resolves.toBe(true);
      await closeChild(child);
    },
    95_000,
  );
});
