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
} from "../../src/main/windows-runtime-job";

const runtimeGenerationId = "20000000-0000-4000-8000-000000000002:1";
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

afterEach(async () => {
  const closing = [...children].map(async (child) => {
    child.kill("SIGKILL");
    await closeChild(child);
  });
  await Promise.all(closing);
});

describe("Windows runtime Job Object containment", () => {
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

  it("gives cold Add-Type startup a bounded stage-aware window", async () => {
    let helper: ChildProcessWithoutNullStreams | null = null;
    const containment = await armWindowsRuntimeJob(
      runtimeGenerationId,
      4_242,
      {
        platform: "win32",
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
      const failure = await armWindowsRuntimeJob(generation, 4_294_967_294)
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(
        "The native helper exited with code 12.",
      );
      expect((failure as Error).message).toContain(
        "INERTIA_JOB_STAGE stage=native-guard-start",
      );
      expect((failure as Error).message).toContain(
        "INERTIA_JOB_ERROR stage=open-process win32=87",
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

      const containment = await armWindowsRuntimeJob(generation, child.pid);
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
