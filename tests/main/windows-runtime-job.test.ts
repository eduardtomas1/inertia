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
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, win32 } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  armWindowsRuntimeJob,
  disposeWindowsRuntimeJobExecutableLock,
  prepareWindowsRuntimeJobExecutableLock,
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
let stubDirectory = "";
let stubAssembly: {
  readonly path: string;
  readonly root: string;
  readonly sha256: string;
};
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

interface BrokerChildOptions {
  readonly lockDelayMs?: number;
  readonly guardStatus?: "READY" | `EXIT:${number}` | "TIMEOUT";
  readonly guardStdout?: string;
  readonly guardStderr?: string;
  readonly recoverStatus?: `EXIT:${number}` | "TIMEOUT";
  readonly recoverStdout?: string;
  readonly recoverStderr?: string;
  readonly responseDelayMs?: number;
  readonly commandLogPath?: string;
  readonly malformedResult?: string;
  readonly shutdownDelayMs?: number;
  readonly retainedHelperExitUnconfirmable?: boolean;
}

function verifiedExecutableBrokerChild(
  options: BrokerChildOptions = {},
): ChildProcessWithoutNullStreams {
  const configuration = Buffer.from(JSON.stringify(options), "utf8").toString("base64");
  return nodeChild(`
const fs = require("node:fs");
const readline = require("node:readline");
const options = JSON.parse(Buffer.from("${configuration}", "base64").toString("utf8"));
const encode = (value) => Buffer.from((value ?? "").slice(0, 2048), "utf8").toString("base64");
const respond = (line) => {
  if (options.commandLogPath) fs.appendFileSync(options.commandLogPath, line + "\\n");
  if (line === "SHUTDOWN") {
    if (options.retainedHelperExitUnconfirmable) return;
    setTimeout(() => {
      process.stdout.write("BYE\\n", () => process.exit(0));
    }, options.shutdownDelayMs ?? 0);
    return;
  }
  const parts = line.split(" ");
  const id = parts[1];
  if (options.malformedResult) {
    process.stdout.write(options.malformedResult + "\\n");
    return;
  }
  const guard = parts[0] === "GUARD";
  const status = guard ? (options.guardStatus ?? "READY") : (options.recoverStatus ?? "EXIT:0");
  const stdout = guard ? (options.guardStdout ?? (status === "READY" ? "READY" : "")) : (options.recoverStdout ?? "");
  const stderr = guard ? (options.guardStderr ?? "") : (options.recoverStderr ?? "");
  const result = "RESULT " + id + " " + status + " " + encode(stdout) + " " + encode(stderr) + "\\n";
  setTimeout(() => process.stdout.write(result), options.responseDelayMs ?? 0);
};
setTimeout(() => {
  process.stdout.write("LOCKED\\n");
  readline.createInterface({ input: process.stdin }).on("line", respond);
}, options.lockDelayMs ?? 0);
`);
}

function spawnVerifiedExecutableLock(): ChildProcessWithoutNullStreams {
  return verifiedExecutableBrokerChild();
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

function windowsProcessCreationIdentityScript(pid: number): string {
  return `$process = [Diagnostics.Process]::GetProcessById(${pid})
try {
  $startTimeUtc = $process.StartTime.ToUniversalTime()
  $creationTicks = [Decimal]($startTimeUtc.Ticks)
  $unixMicroseconds = [Decimal]::Floor(
    [Decimal]::Divide(
      [Decimal]::Subtract($creationTicks, [Decimal]621355968000000000),
      [Decimal]10
    )
  )
  $creationTimeMs = [double]$unixMicroseconds / 1000.0
  [Console]::Out.Write([BitConverter]::DoubleToInt64Bits($creationTimeMs))
} finally {
  $process.Dispose()
}`;
}

async function windowsProcessCreationIdentity(pid: number): Promise<string> {
  const trustedEnvironment = windowsRuntimeJobEnvironment(process.env);
  const systemRoot = trustedEnvironment?.SystemRoot;
  if (!trustedEnvironment || !systemRoot) {
    throw new Error("Trusted Windows runtime environment is unavailable.");
  }
  const script = windowsProcessCreationIdentityScript(pid);
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

beforeEach(async () => {
  stubDirectory = mkdtempSync(join(process.cwd(), ".windows-job-stub-"));
  const root = join(stubDirectory, "runtime");
  mkdirSync(root);
  const path = join(root, "windows-runtime-job.exe");
  const bytes = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
  writeFileSync(path, bytes);
  stubAssembly = {
    path,
    root,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  await prepareWindowsRuntimeJobExecutableLock(stubAssembly, {
    spawnLockBroker: spawnVerifiedExecutableLock,
  });
});

afterEach(async () => {
  await disposeWindowsRuntimeJobExecutableLock();
  const closing = [...children].map(async (child) => {
    child.kill("SIGKILL");
    await closeChild(child);
  });
  await Promise.all(closing);
  rmSync(stubDirectory, { recursive: true, force: true });
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

  it("keeps the real Windows identity oracle exact and PowerShell 5.1 compatible", () => {
    const adversarialTickDelta = 176_000_000_000_000_010n;
    const roundedThroughDouble = BigInt(Math.floor(
      Number(adversarialTickDelta) / 10,
    ));
    expect(roundedThroughDouble).not.toBe(adversarialTickDelta / 10n);
    expect(adversarialTickDelta / 10n).toBe(17_600_000_000_000_001n);

    const script = windowsProcessCreationIdentityScript(4_242);
    expect(script).toContain(
      "$startTimeUtc = $process.StartTime.ToUniversalTime()",
    );
    expect(script).toContain("$creationTicks = [Decimal]($startTimeUtc.Ticks)");
    expect(script).toContain("[Decimal]::Divide(");
    expect(script).toContain("[Decimal]::Subtract(");
    expect(script).not.toContain("ToUniversalTime().Ticks");
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
        path: resolve(portableRoot, "windows-runtime-job.exe"),
        root: resolve(portableRoot),
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

  it("accepts containment only after the verified broker reports readiness", async () => {
    await expect(armWindowsRuntimeJob(runtimeGenerationId, 4_242, {
      platform: "win32",
      assembly: stubAssembly,
      runtimeCreationTimeBits,
      timeoutMs: 1_000,
    })).resolves.toEqual({
      kind: "windows-job-v1",
      name: windowsRuntimeJobName(runtimeGenerationId),
    });
  });

  it("routes exact bounded guard and recovery commands through one broker", async () => {
    await disposeWindowsRuntimeJobExecutableLock();
    const commandLogPath = join(stubDirectory, "broker-commands.txt");
    let brokerSpawns = 0;
    await prepareWindowsRuntimeJobExecutableLock(stubAssembly, {
      spawnLockBroker: () => {
        brokerSpawns += 1;
        return verifiedExecutableBrokerChild({ commandLogPath });
      },
    });
    const jobName = windowsRuntimeJobName(runtimeGenerationId);
    await expect(armWindowsRuntimeJob(runtimeGenerationId, 4_242, {
      platform: "win32",
      assembly: stubAssembly,
      runtimeCreationTimeBits,
      timeoutMs: 1_000,
    })).resolves.toEqual({ kind: "windows-job-v1", name: jobName });
    await expect(recoverWindowsRuntimeJob(
      { kind: "windows-job-v1", name: jobName },
      Date.now() + 1_000,
      { platform: "win32", assembly: stubAssembly },
    )).resolves.toBe(true);
    const [guard, recover] = readFileSync(commandLogPath, "utf8").trim().split("\n");
    const guardParts = guard!.split(" ");
    const recoverParts = recover!.split(" ");
    expect(guardParts[0]).toBe("GUARD");
    expect(Buffer.from(guardParts[2]!, "base64").toString("utf8")).toBe(jobName);
    expect(guardParts.slice(3, 5)).toEqual(["4242", runtimeCreationTimeBits]);
    expect(recoverParts[0]).toBe("RECOVER");
    expect(Buffer.from(recoverParts[2]!, "base64").toString("utf8")).toBe(jobName);
    expect(brokerSpawns).toBe(1);

    const nativeSource = readFileSync(
      resolve(process.cwd(), "native/runtime-process-guardian/windows.cs"),
      "utf8",
    );
    expect(nativeSource).toContain("CultureInfo.InvariantCulture");
    expect(nativeSource).not.toContain("OpenProcess(");
    expect(nativeSource).toContain("OpenVerifiedExecutable(");
    expect(nativeSource).toContain(
      "using (var executable = OpenVerifiedExecutable(",
    );
    expect(nativeSource).toContain("Process.GetProcessById(");
    expect(nativeSource).toContain("public static int BeginGuard(");
    expect(nativeSource).toContain("string processIdValue");
    expect(nativeSource).toContain("processId > Int32.MaxValue");
    expect(nativeSource).toContain("public static int ShutdownAll(");
    expect(nativeSource).toContain("private sealed class GuardLease");
    expect(nativeSource).toContain("GetProcessTimes(");
    expect(nativeSource).toContain("read-process-identity");
    expect(nativeSource).toContain("process-identity-mismatch");
    expect(nativeSource).toContain("while (Console.In.Read() != -1)");
    expect(nativeSource.indexOf("CreationIdentityStatus("))
      .toBeLessThan(nativeSource.indexOf("IntPtr job = CreateJobObject("));

    const launchSource = readFileSync(
      resolve(process.cwd(), "src/main/windows-runtime-job.ts"),
      "utf8",
    );
    const normalizedLaunchSource = launchSource.replaceAll("\r\n", "\n");
    expect(launchSource).toContain("[IO.FileShare]::Read");
    expect(normalizedLaunchSource).toContain(
      "$actual = [BitConverter]::ToString(\n      $sha256.ComputeHash($assemblyBytes)",
    );
    expect(launchSource).toContain(
      "$assemblyBytes = [byte[]]::new([Int32]$stream.Length)",
    );
    expect(launchSource).not.toContain("New-Object byte[]");
    expect(launchSource).toContain(
      "$loadedAssembly = [Reflection.Assembly]::Load($assemblyBytes)",
    );
    expect(launchSource).toContain(
      "$jobType = $loadedAssembly.GetType('InertiaRuntimeJob', $true, $false)",
    );
    expect(launchSource).toContain("$beginGuardMethod.Invoke($null, $guardArguments)");
    expect(launchSource).toContain("$recoverMethod.Invoke(");
    expect(launchSource).toContain("Write-Frame '${EXECUTABLE_LOCK_BYE_MARKER}'");
    expect(launchSource).toContain("throw 'guardian-exit-unconfirmed'");
    expect(launchSource.indexOf(
      "$shutdownCode = [Int32]$shutdownMethod.Invoke(",
    )).toBeLessThan(launchSource.indexOf(
      "Write-Frame '${EXECUTABLE_LOCK_BYE_MARKER}'",
    ));
    expect(launchSource).toContain("INERTIA_JOB_ERROR stage=verified-file-lock");
    expect(launchSource).toContain(
      "MAX_BROKER_BOOTSTRAP_SCRIPT_BYTES = 64 * 1024",
    );
    expect(launchSource).toContain(
      "$utf8 = [Text.UTF8Encoding]::new($false, $true)",
    );
    expect(launchSource).toContain(
      "[Convert]::ToBase64String($bytes) -cne $line",
    );
    expect(launchSource).toContain(
      "encodedPowerShell(windowsRuntimeJobBootstrapScript())",
    );
    expect(launchSource).toContain(
      "const bootstrapLine = encodedWindowsRuntimeJobLockScript(assembly)",
    );
    expect(launchSource).toContain("child.stdin.write(`${bootstrapLine}\\n`)");
    expect(launchSource).not.toContain(
      "encodedPowerShell(windowsRuntimeJobLockScript(assembly))",
    );
    expect(launchSource).not.toContain("function Start-Helper");
    expect(launchSource).not.toContain("Diagnostics.ProcessStartInfo");
    expect(launchSource).not.toContain("[InertiaRuntimeJob]::");
    expect(launchSource).not.toContain("spawnWindowsRuntimeJobExecutable");
    expect(launchSource.indexOf("[IO.File]::Open("))
      .toBeLessThan(launchSource.indexOf("$sha256.ComputeHash($assemblyBytes)"));
    expect(launchSource.indexOf(
      "const bootstrapLine = encodedWindowsRuntimeJobLockScript(assembly)",
    )).toBeLessThan(launchSource.indexOf("const child = spawn("));
    expect(launchSource.indexOf("$sha256.ComputeHash($assemblyBytes)"))
      .toBeLessThan(launchSource.indexOf("$loadedAssembly = [Reflection.Assembly]::Load($assemblyBytes)"));
    expect(launchSource.indexOf("$loadedAssembly = [Reflection.Assembly]::Load($assemblyBytes)"))
      .toBeLessThan(launchSource.indexOf("$stdout.Write($locked"));
    expect(launchSource.indexOf("$loadedAssembly = [Reflection.Assembly]::Load($assemblyBytes)"))
      .toBeLessThan(launchSource.indexOf("$beginGuardMethod.Invoke("));
    expect(launchSource.indexOf("$shutdownMethod.Invoke("))
      .toBeLessThan(launchSource.indexOf("if ($null -ne $stream) { $stream.Dispose() }"));
  });

  it("requires bootstrap readiness before any native operation can launch", async () => {
    await disposeWindowsRuntimeJobExecutableLock();
    const preparation = prepareWindowsRuntimeJobExecutableLock(stubAssembly, {
      timeoutMs: 1_000,
      spawnLockBroker: () => verifiedExecutableBrokerChild({ lockDelayMs: 50 }),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(armWindowsRuntimeJob(runtimeGenerationId, 4_242, {
      platform: "win32",
      assembly: stubAssembly,
      runtimeCreationTimeBits,
      timeoutMs: 1_000,
    })).rejects.toThrow("verified Windows runtime executable lock is unavailable");
    await expect(preparation).resolves.toBeUndefined();
  });

  it("fails closed when the broker cannot lock and verify the executable", async () => {
    await disposeWindowsRuntimeJobExecutableLock();
    await expect(prepareWindowsRuntimeJobExecutableLock(stubAssembly, {
      timeoutMs: 1_000,
      spawnLockBroker: () => nodeChild(
        "process.stderr.write('INERTIA_JOB_ERROR stage=verified-file-lock\\n');"
        + "process.exit(25)",
      ),
    })).rejects.toThrow(
      "The Windows runtime Job Object executable could not be locked and verified. "
      + "INERTIA_JOB_ERROR stage=verified-file-lock",
    );
    await expect(armWindowsRuntimeJob(runtimeGenerationId, 4_242, {
      platform: "win32",
      assembly: stubAssembly,
      runtimeCreationTimeBits,
    })).rejects.toThrow("verified Windows runtime executable lock is unavailable");
  });

  it("releases the prepared broker during normal privileged disposal", async () => {
    await disposeWindowsRuntimeJobExecutableLock();
    const broker = verifiedExecutableBrokerChild({ shutdownDelayMs: 30 });
    await prepareWindowsRuntimeJobExecutableLock(stubAssembly, {
      spawnLockBroker: () => broker,
    });
    const disposal = disposeWindowsRuntimeJobExecutableLock();
    expect(broker.exitCode).toBeNull();
    await disposal;
    await closeChild(broker);
    expect(broker.exitCode).toBe(0);
  });

  it("allows the broker's complete bounded guardian shutdown before forcing close", async () => {
    await disposeWindowsRuntimeJobExecutableLock();
    const broker = verifiedExecutableBrokerChild({ shutdownDelayMs: 3_100 });
    await prepareWindowsRuntimeJobExecutableLock(stubAssembly, {
      spawnLockBroker: () => broker,
    });
    await expect(disposeWindowsRuntimeJobExecutableLock()).resolves.toBeUndefined();
    await closeChild(broker);
    expect(broker.exitCode).toBe(0);
  });

  it("fails update and quit cleanup closed when retained guardian exit is unconfirmed", async () => {
    await disposeWindowsRuntimeJobExecutableLock();
    const broker = verifiedExecutableBrokerChild({
      retainedHelperExitUnconfirmable: true,
    });
    await prepareWindowsRuntimeJobExecutableLock(stubAssembly, {
      spawnLockBroker: () => broker,
    });
    await expect(disposeWindowsRuntimeJobExecutableLock()).rejects.toThrow(
      "broker did not acknowledge shutdown",
    );
    await closeChild(broker);
    expect(broker.exitCode).toBe(0);
  });

  it("fails closed after the prepared broker is lost", async () => {
    await disposeWindowsRuntimeJobExecutableLock();
    const broker = nodeChild(
      "process.stdout.write('LOCKED\\n'); setTimeout(() => process.exit(0), 20);"
      + "process.stdin.resume()",
    );
    await prepareWindowsRuntimeJobExecutableLock(stubAssembly, {
      spawnLockBroker: () => broker,
    });
    await closeChild(broker);
    await expect(armWindowsRuntimeJob(runtimeGenerationId, 4_242, {
      platform: "win32",
      assembly: stubAssembly,
      runtimeCreationTimeBits,
    })).rejects.toThrow("verified Windows runtime executable lock is unavailable");
  });

  it("gives the broker-owned native executable one bounded startup window", async () => {
    await disposeWindowsRuntimeJobExecutableLock();
    await prepareWindowsRuntimeJobExecutableLock(stubAssembly, {
      spawnLockBroker: () => verifiedExecutableBrokerChild({ responseDelayMs: 350 }),
    });
    const containment = await armWindowsRuntimeJob(
      runtimeGenerationId,
      4_242,
      {
        platform: "win32",
        assembly: stubAssembly,
        runtimeCreationTimeBits,
        timeoutMs: 500,
      },
    );

    expect(containment).toEqual({
      kind: "windows-job-v1",
      name: windowsRuntimeJobName(runtimeGenerationId),
    });
  });

  it("reports the last bounded helper startup stage on timeout", async () => {
    await disposeWindowsRuntimeJobExecutableLock();
    await prepareWindowsRuntimeJobExecutableLock(stubAssembly, {
      spawnLockBroker: () => verifiedExecutableBrokerChild({
        guardStatus: "TIMEOUT",
        guardStderr: "INERTIA_JOB_STAGE stage=native-guard-start\n",
      }),
    });
    await expect(armWindowsRuntimeJob(runtimeGenerationId, 4_242, {
      platform: "win32",
      assembly: stubAssembly,
      runtimeCreationTimeBits,
      timeoutMs: 100,
    })).rejects.toThrow(
      "The native helper did not report readiness within 100ms after Guard started. "
      + "INERTIA_JOB_STAGE stage=native-guard-start",
    );
  });

  it("fails closed when the native helper exits before readiness", async () => {
    await disposeWindowsRuntimeJobExecutableLock();
    await prepareWindowsRuntimeJobExecutableLock(stubAssembly, {
      spawnLockBroker: () => verifiedExecutableBrokerChild({ guardStatus: "EXIT:17" }),
    });
    await expect(armWindowsRuntimeJob(runtimeGenerationId, 4_242, {
      platform: "win32",
      assembly: stubAssembly,
      runtimeCreationTimeBits,
      timeoutMs: 1_000,
    })).rejects.toThrow(
      "The Windows runtime Job Object could not be armed. "
      + "The native helper exited with code 17.",
    );
  });

  it("reports bounded native stage diagnostics with the helper exit code", async () => {
    await disposeWindowsRuntimeJobExecutableLock();
    await prepareWindowsRuntimeJobExecutableLock(stubAssembly, {
      spawnLockBroker: () => verifiedExecutableBrokerChild({
        guardStatus: "EXIT:13",
        guardStderr: "INERTIA_JOB_ERROR stage=assign-process win32=5\n" + "x".repeat(10_000),
      }),
    });
    const failure = await armWindowsRuntimeJob(runtimeGenerationId, 4_242, {
      platform: "win32",
      assembly: stubAssembly,
      runtimeCreationTimeBits,
      timeoutMs: 1_000,
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
    await expect(recoverWindowsRuntimeJob({
      kind: "windows-job-v1",
      name: windowsRuntimeJobName(runtimeGenerationId),
    }, Date.now() + 1_000, {
      platform: "win32",
      assembly: stubAssembly,
    })).resolves.toBe(true);

    await disposeWindowsRuntimeJobExecutableLock();
    await prepareWindowsRuntimeJobExecutableLock(stubAssembly, {
      spawnLockBroker: () => verifiedExecutableBrokerChild({ recoverStatus: "EXIT:21" }),
    });
    await expect(recoverWindowsRuntimeJob({
      kind: "windows-job-v1",
      name: windowsRuntimeJobName(runtimeGenerationId),
    }, Date.now() + 1_000, {
      platform: "win32",
      assembly: stubAssembly,
    })).resolves.toBe(false);

    await disposeWindowsRuntimeJobExecutableLock();
    await prepareWindowsRuntimeJobExecutableLock(stubAssembly, {
      spawnLockBroker: () => verifiedExecutableBrokerChild({ recoverStatus: "EXIT:22" }),
    });
    await expect(recoverWindowsRuntimeJob({
      kind: "windows-job-v1",
      name: windowsRuntimeJobName(runtimeGenerationId),
    }, Date.now() + 1_000, {
      platform: "win32",
      assembly: stubAssembly,
      // Native exit 22 means OpenJobObject failed for a reason other than
      // ERROR_FILE_NOT_FOUND and must never be projected as an absent job.
    })).resolves.toBe(false);
  });

  it("reuses one prepared broker across multiple native launches", async () => {
    await disposeWindowsRuntimeJobExecutableLock();
    let brokerSpawns = 0;
    await prepareWindowsRuntimeJobExecutableLock(stubAssembly, {
      spawnLockBroker: () => {
        brokerSpawns += 1;
        return verifiedExecutableBrokerChild();
      },
    });
    await expect(armWindowsRuntimeJob(
      "20000000-0000-4000-8000-000000000003:1",
      4_242,
      {
        platform: "win32",
        assembly: stubAssembly,
        runtimeCreationTimeBits,
      },
    )).resolves.toMatchObject({ kind: "windows-job-v1" });
    await expect(recoverWindowsRuntimeJob({
      kind: "windows-job-v1",
      name: windowsRuntimeJobName(
        "20000000-0000-4000-8000-000000000004:1",
      ),
    }, Date.now() + 1_000, {
      platform: "win32",
      assembly: stubAssembly,
    })).resolves.toBe(true);
    expect(brokerSpawns).toBe(1);
  });

  it("fails closed on malformed broker output", async () => {
    await disposeWindowsRuntimeJobExecutableLock();
    await prepareWindowsRuntimeJobExecutableLock(stubAssembly, {
      spawnLockBroker: () => verifiedExecutableBrokerChild({
        malformedResult: "RESULT 1 READY only-one-field",
      }),
    });
    await expect(armWindowsRuntimeJob(runtimeGenerationId, 4_242, {
      platform: "win32",
      assembly: stubAssembly,
      runtimeCreationTimeBits,
      timeoutMs: 1_000,
    })).rejects.toThrow("broker returned an invalid result");
  });

  it("rejects fake readiness when the broker dies after launching", async () => {
    await disposeWindowsRuntimeJobExecutableLock();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let live = true;
    const broker = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill(signal?: NodeJS.Signals | number) {
        if (signal === 0) return live;
        live = false;
        return true;
      },
    }) as unknown as ChildProcessWithoutNullStreams;
    stdin.on("data", (chunk: Buffer) => {
      const line = chunk.toString("utf8").trim();
      if (!line.startsWith("GUARD ")) return;
      const requestId = line.split(" ")[1];
      stdout.write(
        `RESULT ${requestId} READY ${Buffer.from("READY").toString("base64")} \n`,
      );
      live = false;
      Object.assign(broker, { exitCode: 0 });
      broker.emit("exit", 0, null);
      broker.emit("close", 0, null);
    });
    const preparation = prepareWindowsRuntimeJobExecutableLock(stubAssembly, {
      spawnLockBroker: () => broker,
    });
    queueMicrotask(() => stdout.write("LOCKED\n"));
    await preparation;
    await expect(armWindowsRuntimeJob(runtimeGenerationId, 4_242, {
      platform: "win32",
      assembly: stubAssembly,
      runtimeCreationTimeBits,
      timeoutMs: 1_000,
    })).rejects.toThrow("executable lock was lost");
  });

  it("invalidates the whole broker authority after an operation deadline", async () => {
    await disposeWindowsRuntimeJobExecutableLock();
    const broker = verifiedExecutableBrokerChild({
      malformedResult: "RESULT 999 READY UkVBRFk= ",
    });
    const closed = new Promise<void>((resolve) => broker.once("close", () => resolve()));
    await prepareWindowsRuntimeJobExecutableLock(stubAssembly, {
      spawnLockBroker: () => broker,
    });
    await expect(armWindowsRuntimeJob(runtimeGenerationId, 4_242, {
      platform: "win32",
      assembly: stubAssembly,
      runtimeCreationTimeBits,
      timeoutMs: 80,
    })).rejects.toThrow("broker operation deadline elapsed");
    await closed;
    await expect(armWindowsRuntimeJob(runtimeGenerationId, 4_242, {
      platform: "win32",
      assembly: stubAssembly,
      runtimeCreationTimeBits,
    })).rejects.toThrow("executable lock is unavailable");
  });

  it.runIf(process.platform === "win32")(
    "denies executable writes and replacement throughout native launch",
    async () => {
      const directory = mkdtempSync(join(process.cwd(), ".windows-job-lock-"));
      const root = join(directory, "runtime");
      mkdirSync(root);
      const path = join(root, "windows-runtime-job.exe");
      const originalBytes = readFileSync(realWindowsRuntimeJobAssembly().path);
      writeFileSync(path, originalBytes);
      const assembly = {
        path,
        root,
        sha256: createHash("sha256").update(originalBytes).digest("hex"),
      };
      await disposeWindowsRuntimeJobExecutableLock();
      await prepareWindowsRuntimeJobExecutableLock(assembly);
      const generation = "30000000-0000-4000-8000-000000000006:1";
      const runtime = nodeChild("setInterval(() => undefined, 1_000)");
      if (!runtime.pid) throw new Error("The disposable child did not start.");
      const creationIdentity = await windowsProcessCreationIdentity(runtime.pid);
      let replacementError: unknown;
      let renameError: unknown;
      try {
        const containment = await armWindowsRuntimeJob(generation, runtime.pid, {
          assembly,
          runtimeCreationTimeBits: creationIdentity,
        });
        try {
          writeFileSync(path, Buffer.from("MZuntrusted replacement"));
        } catch (error) {
          replacementError = error;
        }
        try {
          renameSync(path, `${path}.replaced`);
        } catch (error) {
          renameError = error;
        }
        expect(replacementError).toBeInstanceOf(Error);
        expect(renameError).toBeInstanceOf(Error);
        expect(readFileSync(path)).toEqual(originalBytes);
        runtime.kill("SIGKILL");
        await closeChild(runtime);
        await expect(recoverWindowsRuntimeJob(
          containment!,
          Date.now() + 5_000,
          { assembly },
        )).resolves.toBe(true);
      } finally {
        runtime.kill("SIGKILL");
        await closeChild(runtime);
        await disposeWindowsRuntimeJobExecutableLock();
        rmSync(directory, { recursive: true, force: true });
      }
    },
    95_000,
  );

  it.runIf(process.platform === "win32")(
    "reports a real native Windows helper failure through bounded UTF-8 stderr",
    async () => {
      const generation = "30000000-0000-4000-8000-000000000004:1";
      const assembly = realWindowsRuntimeJobAssembly();
      await disposeWindowsRuntimeJobExecutableLock();
      await prepareWindowsRuntimeJobExecutableLock(assembly);
      const failure = await armWindowsRuntimeJob(generation, 4_294_967_294, {
        assembly,
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
      await disposeWindowsRuntimeJobExecutableLock();
      await prepareWindowsRuntimeJobExecutableLock(assembly);
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
      await disposeWindowsRuntimeJobExecutableLock();
      await prepareWindowsRuntimeJobExecutableLock(assembly);
      const creationIdentity = await windowsProcessCreationIdentity(child.pid);
      const containment = await armWindowsRuntimeJob(generation, child.pid, {
        assembly,
        runtimeCreationTimeBits: creationIdentity,
      });
      if (!containment) throw new Error("Windows Job Object containment was unavailable.");

      vi.resetModules();
      const restarted = await import("../../src/main/windows-runtime-job");
      expect(restarted.recoverWindowsRuntimeJob).not.toBe(recoverWindowsRuntimeJob);
      await restarted.prepareWindowsRuntimeJobExecutableLock(assembly);
      await expect(restarted.recoverWindowsRuntimeJob(
        containment,
        Date.now() + 2_000,
        { assembly },
      )).resolves.toBe(true);
      await restarted.disposeWindowsRuntimeJobExecutableLock();
      await closeChild(child);
    },
    95_000,
  );
});
