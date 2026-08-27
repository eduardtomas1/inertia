import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  armWindowsRuntimeJob,
  recoverWindowsRuntimeJob,
  windowsRuntimeJobName,
  windowsRuntimePowerShellLaunch,
  windowsRuntimeProcessCreationIdentity,
  waitForWindowsRuntimeProcessCreationIdentity,
} from "../../src/main/windows-runtime-job";

const runtimeGenerationId = "20000000-0000-4000-8000-000000000002:1";
const runtimeCreationTimeMs = 1_700_000_000_123.456;
const runtimeCreationTimeBits = "4789786004267972428";
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

async function closeChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!children.has(child)) return;
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
}

async function windowsProcessCreationIdentity(pid: number): Promise<string> {
  const trusted = windowsRuntimePowerShellLaunch(process.env);
  if (!trusted) throw new Error("Trusted Windows PowerShell is unavailable.");
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
  const child = spawn(trusted.executable, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ], {
    env: trusted.environment,
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

  it("uses a fixed trusted PowerShell and never inherits user secrets", () => {
    expect(windowsRuntimePowerShellLaunch({
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Users\\Test\\AppData\\Local\\Temp",
      PATH: "C:\\attacker",
      SECRET_TOKEN: "must-not-be-inherited",
    })).toEqual({
      executable:
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      environment: {
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        PATH: "C:\\Windows\\System32",
        SystemRoot: "C:\\Windows",
        SYSTEMROOT: "C:\\Windows",
        WINDIR: "C:\\Windows",
        TEMP: "C:\\Users\\Test\\AppData\\Local\\Temp",
        TMP: "C:\\Users\\Test\\AppData\\Local\\Temp",
      },
    });
    expect(windowsRuntimePowerShellLaunch({ SystemRoot: "relative" }))
      .toBeNull();
  });

  it("does not arm containment until the native helper reports READY", async () => {
    let helper: ChildProcessWithoutNullStreams | null = null;
    const containment = await armWindowsRuntimeJob(
      runtimeGenerationId,
      4_242,
      {
        platform: "win32",
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

  it("pins the exact runtime handle before cold Add-Type compilation", async () => {
    let script = "";
    let helper: ChildProcessWithoutNullStreams | null = null;
    await armWindowsRuntimeJob(runtimeGenerationId, 4_242, {
      platform: "win32",
      runtimeCreationTimeBits,
      timeoutMs: 1_000,
      spawnProcess: (candidate) => {
        script = candidate;
        helper = nodeChild(
          "process.stdout.write('READY\\n'); setInterval(() => undefined, 1000)",
        );
        return helper;
      },
    });

    const captureIndex = script.indexOf(
      "$runtimeProcess = [Diagnostics.Process]::GetProcessById(4242)",
    );
    const handleIndex = script.indexOf(
      "$runtimeHandle = $runtimeProcess.Handle",
    );
    const compileIndex = script.indexOf("Add-Type -TypeDefinition");
    expect(captureIndex).toBeGreaterThan(-1);
    expect(handleIndex).toBeGreaterThan(captureIndex);
    expect(compileIndex).toBeGreaterThan(handleIndex);
    expect(script).toContain(
      `'${windowsRuntimeJobName(runtimeGenerationId)}',`,
    );
    expect(script).toContain(`'${runtimeCreationTimeBits}'`);
    expect(script).toContain("CultureInfo.InvariantCulture");
    expect(script).not.toContain("OpenProcess(");
    expect(script).toContain("GetProcessTimes(");
    expect(script).toContain("read-process-identity");
    expect(script).toContain("process-identity-mismatch");
    expect(script.indexOf("CreationIdentityStatus(", compileIndex))
      .toBeLessThan(script.indexOf("IntPtr job = CreateJobObject(", compileIndex));
    expect(script).toContain("$runtimeProcess.Dispose()");

    helper!.kill("SIGKILL");
    await closeChild(helper!);
  });

  it("gives cold Add-Type startup a bounded stage-aware window", async () => {
    let helper: ChildProcessWithoutNullStreams | null = null;
    const containment = await armWindowsRuntimeJob(
      runtimeGenerationId,
      4_242,
      {
        platform: "win32",
        runtimeCreationTimeBits,
        timeoutMs: 500,
        spawnProcess: () => {
          helper = nodeChild(
            "process.stderr.write('INERTIA_JOB_STAGE stage=powershell-start\\n');"
            + "setTimeout(() => process.stderr.write("
            + "'INERTIA_JOB_STAGE stage=add-type-complete\\n'), 350);"
            + "setTimeout(() => {"
            + "process.stderr.write('INERTIA_JOB_STAGE stage=native-guard-start\\n');"
            + "process.stdout.write('READY\\n');"
            + "}, 700);"
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
      runtimeCreationTimeBits,
      timeoutMs: 100,
      spawnProcess: () => nodeChild(
        "process.stderr.write('INERTIA_JOB_STAGE stage=powershell-start\\n');"
        + "setInterval(() => undefined, 1000)",
      ),
    })).rejects.toThrow(
      "The PowerShell helper did not complete Add-Type within 100ms. "
      + "INERTIA_JOB_STAGE stage=powershell-start",
    );
  });

  it("keeps native arming fail closed after the startup window", async () => {
    await expect(armWindowsRuntimeJob(runtimeGenerationId, 4_242, {
      platform: "win32",
      runtimeCreationTimeBits,
      timeoutMs: 100,
      spawnProcess: () => nodeChild(
        "process.stderr.write("
        + "'INERTIA_JOB_STAGE stage=powershell-start\\n"
        + "INERTIA_JOB_STAGE stage=add-type-complete\\n"
        + "INERTIA_JOB_STAGE stage=native-guard-start\\n');"
        + "setInterval(() => undefined, 1000)",
      ),
    })).rejects.toThrow(
      "The native helper did not report readiness within 100ms after Guard started.",
    );
  });

  it("fails closed when the native helper exits before readiness", async () => {
    await expect(armWindowsRuntimeJob(runtimeGenerationId, 4_242, {
      platform: "win32",
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
    await expect(recoverWindowsRuntimeJob({
      kind: "windows-job-v1",
      name: windowsRuntimeJobName(runtimeGenerationId),
    }, Date.now() + 1_000, {
      platform: "win32",
      spawnProcess: () => nodeChild("process.exit(0)"),
    })).resolves.toBe(true);

    await expect(recoverWindowsRuntimeJob({
      kind: "windows-job-v1",
      name: windowsRuntimeJobName(runtimeGenerationId),
    }, Date.now() + 1_000, {
      platform: "win32",
      spawnProcess: () => nodeChild("process.exit(21)"),
    })).resolves.toBe(false);

    await expect(recoverWindowsRuntimeJob({
      kind: "windows-job-v1",
      name: windowsRuntimeJobName(runtimeGenerationId),
    }, Date.now() + 1_000, {
      platform: "win32",
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
        "INERTIA_JOB_STAGE stage=powershell-start",
      );
      expect((failure as Error).message).toContain(
        "INERTIA_JOB_ERROR stage=capture-process-handle",
      );
      expect((failure as Error).message).not.toContain(
        "INERTIA_JOB_STAGE stage=add-type-complete",
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
      const containment = await armWindowsRuntimeJob(generation, child.pid, {
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
      );
      child.kill("SIGKILL");
      await closeChild(child);
      await expect(cleanup).resolves.toBe(true);
    },
    95_000,
  );
});
