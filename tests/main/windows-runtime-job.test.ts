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
  if (child.exitCode !== null || child.signalCode !== null) return;
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

  it("fails closed when the native helper exits before readiness", async () => {
    await expect(armWindowsRuntimeJob(runtimeGenerationId, 4_242, {
      platform: "win32",
      timeoutMs: 1_000,
      spawnProcess: () => nodeChild("process.exit(17)"),
    })).rejects.toThrow("Job Object could not be armed");
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
});
