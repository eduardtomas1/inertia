import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { win32 } from "node:path";

import type { WindowsRuntimeJobContainment } from "../node/runtime-owned-processes.js";
import { validRuntimeGenerationId } from "../node/runtime-process-protocol.js";

const HELPER_STARTUP_TIMEOUT_MS = 60_000;
const NATIVE_READY_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 8_192;

type WindowsRuntimeJobStage =
  | "powershell-start"
  | "add-type-complete"
  | "native-guard-start";

interface ActiveWindowsRuntimeJob {
  readonly child: ChildProcessWithoutNullStreams;
  readonly completion: Promise<boolean>;
}

const activeJobs = new Map<string, ActiveWindowsRuntimeJob>();

function environmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  return Object.entries(environment).find(([key, value]) =>
    key.toLowerCase() === name.toLowerCase() && typeof value === "string")?.[1];
}

export function windowsRuntimePowerShellLaunch(
  environment: NodeJS.ProcessEnv,
): { executable: string; environment: NodeJS.ProcessEnv } | null {
  const root = environmentValue(environment, "SystemRoot")?.trim();
  const temporary = (
    environmentValue(environment, "TEMP")
    ?? environmentValue(environment, "TMP")
  )?.trim();
  if (
    !root
    || !win32.isAbsolute(root)
    || !/^[a-z]:\\/iu.test(root)
    || !temporary
    || !win32.isAbsolute(temporary)
    || !/^[a-z]:\\/iu.test(temporary)
  ) return null;
  const normalizedTemporary = win32.normalize(temporary);
  return {
    executable: win32.join(
      root,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    environment: {
      ComSpec: win32.join(root, "System32", "cmd.exe"),
      PATH: win32.join(root, "System32"),
      SystemRoot: root,
      SYSTEMROOT: root,
      WINDIR: root,
      TEMP: normalizedTemporary,
      TMP: normalizedTemporary,
    },
  };
}

export function windowsRuntimeJobName(
  runtimeGenerationId: string,
): string {
  if (!validRuntimeGenerationId(runtimeGenerationId)) {
    throw new Error("The runtime generation identity is invalid.");
  }
  const digest = createHash("sha256")
    .update(runtimeGenerationId)
    .digest("hex");
  // Fast user switching and RDP create distinct session namespaces. The
  // global Job Object remains addressable when Inertia restarts in another
  // session; its default ACL still limits access to the creating identity.
  return `Global\\InertiaRuntime-${digest}`;
}

const nativeJobSource = String.raw`
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class InertiaRuntimeJob {
  [StructLayout(LayoutKind.Sequential)]
  private struct IO_COUNTERS {
    public UInt64 ReadOperationCount;
    public UInt64 WriteOperationCount;
    public UInt64 OtherOperationCount;
    public UInt64 ReadTransferCount;
    public UInt64 WriteTransferCount;
    public UInt64 OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public Int64 PerProcessUserTimeLimit;
    public Int64 PerJobUserTimeLimit;
    public UInt32 LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public UInt32 ActiveProcessLimit;
    public UIntPtr Affinity;
    public UInt32 PriorityClass;
    public UInt32 SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public Int64 TotalUserTime;
    public Int64 TotalKernelTime;
    public Int64 ThisPeriodTotalUserTime;
    public Int64 ThisPeriodTotalKernelTime;
    public UInt32 TotalPageFaultCount;
    public UInt32 TotalProcesses;
    public UInt32 ActiveProcesses;
    public UInt32 TotalTerminatedProcesses;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr OpenJobObject(UInt32 access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, UInt32 length);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, UInt32 length, IntPtr returnedLength);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateJobObject(IntPtr job, UInt32 exitCode);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern UInt32 WaitForSingleObject(IntPtr handle, UInt32 milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);

  private const UInt32 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  private const UInt32 JOB_OBJECT_QUERY = 0x0004;
  private const UInt32 JOB_OBJECT_TERMINATE = 0x0008;
  private const UInt32 INFINITE = 0xffffffff;
  private const Int32 ERROR_FILE_NOT_FOUND = 2;
  private const int JobObjectBasicAccountingInformation = 1;
  private const int JobObjectExtendedLimitInformation = 9;

  private static void WriteProtocolLine(Stream stream, string value) {
    byte[] bytes = Encoding.UTF8.GetBytes(value + "\n");
    stream.Write(bytes, 0, bytes.Length);
    stream.Flush();
  }

  private static int Failure(string stage, int exitCode, int win32Error) {
    WriteProtocolLine(
      Console.OpenStandardError(),
      "INERTIA_JOB_ERROR stage=" + stage + " win32=" + win32Error
    );
    return exitCode;
  }

  private static void Stage(string stage) {
    WriteProtocolLine(
      Console.OpenStandardError(),
      "INERTIA_JOB_STAGE stage=" + stage
    );
  }

  private static bool ArmKillOnClose(IntPtr job, out int win32Error) {
    var information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    int length = Marshal.SizeOf(information);
    IntPtr pointer = Marshal.AllocHGlobal(length);
    try {
      Marshal.StructureToPtr(information, pointer, false);
      bool armed = SetInformationJobObject(
        job,
        JobObjectExtendedLimitInformation,
        pointer,
        (UInt32)length
      );
      win32Error = armed ? 0 : Marshal.GetLastWin32Error();
      return armed;
    } finally {
      Marshal.FreeHGlobal(pointer);
    }
  }

  private static UInt32 ActiveProcesses(IntPtr job) {
    int length = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
    IntPtr pointer = Marshal.AllocHGlobal(length);
    try {
      if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, pointer, (UInt32)length, IntPtr.Zero)) {
        return UInt32.MaxValue;
      }
      return ((JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(
        pointer,
        typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)
      )).ActiveProcesses;
    } finally {
      Marshal.FreeHGlobal(pointer);
    }
  }

  public static int Guard(string name, IntPtr process) {
    Stage("native-guard-start");
    IntPtr job = CreateJobObject(IntPtr.Zero, name);
    int createError = Marshal.GetLastWin32Error();
    if (job == IntPtr.Zero) return Failure("create-job", 10, createError);
    if (createError == 183) {
      CloseHandle(job);
      return Failure("create-job-existing", 17, createError);
    }
    try {
      int armError;
      if (!ArmKillOnClose(job, out armError)) {
        return Failure("set-kill-on-close", 11, armError);
      }
      if (!AssignProcessToJobObject(job, process)) {
        return Failure("assign-process", 13, Marshal.GetLastWin32Error());
      }
      // PowerShell 5.1's redirected Console.Out encoding is host-dependent.
      // Write the private readiness protocol to the native stream so Node
      // always receives the bounded UTF-8 marker it parses on every build.
      WriteProtocolLine(Console.OpenStandardOutput(), "READY");
      UInt32 waitResult = WaitForSingleObject(process, INFINITE);
      if (waitResult != 0) {
        int waitError = waitResult == UInt32.MaxValue
          ? Marshal.GetLastWin32Error()
          : 0;
        return Failure("wait-process", 14, waitError);
      }
      if (!TerminateJobObject(job, 137)) {
        return Failure("terminate-job", 15, Marshal.GetLastWin32Error());
      }
      for (int index = 0; index < 200 && ActiveProcesses(job) != 0; index += 1) {
        System.Threading.Thread.Sleep(10);
      }
      return ActiveProcesses(job) == 0 ? 0 : 16;
    } finally {
      CloseHandle(job);
    }
  }

  public static int Recover(string name) {
    IntPtr job = OpenJobObject(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, false, name);
    if (job == IntPtr.Zero) {
      if (Marshal.GetLastWin32Error() != ERROR_FILE_NOT_FOUND) return 22;
      WriteProtocolLine(Console.OpenStandardOutput(), "ABSENT");
      return 0;
    }
    try {
      if (!TerminateJobObject(job, 137)) return 20;
      for (int index = 0; index < 200 && ActiveProcesses(job) != 0; index += 1) {
        System.Threading.Thread.Sleep(10);
      }
      return ActiveProcesses(job) == 0 ? 0 : 21;
    } finally {
      CloseHandle(job);
    }
  }
}
`;

function encodedPowerShell(body: string): string {
  return Buffer.from(body, "utf16le").toString("base64");
}

function commandScript(
  command: string,
  beforeCompilation = "",
): string {
  return `$ErrorActionPreference = 'Stop'
function Write-InertiaJobProtocol([string]$Value) {
  $stream = [Console]::OpenStandardError()
  $bytes = [Text.Encoding]::UTF8.GetBytes($Value + [Environment]::NewLine)
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Flush()
}
Write-InertiaJobProtocol 'INERTIA_JOB_STAGE stage=powershell-start'
${beforeCompilation}
Add-Type -TypeDefinition @'
${nativeJobSource}
'@
Write-InertiaJobProtocol 'INERTIA_JOB_STAGE stage=add-type-complete'
${command}
exit $LASTEXITCODE`;
}

function appendBounded(current: string, chunk: Buffer): string {
  if (current.length >= MAX_OUTPUT_BYTES) return current;
  return (current + chunk.toString("utf8")).slice(0, MAX_OUTPUT_BYTES);
}

function latestHelperStage(output: string): WindowsRuntimeJobStage | null {
  const matches = output.matchAll(
    /INERTIA_JOB_STAGE stage=(powershell-start|add-type-complete|native-guard-start)/gu,
  );
  let latest: WindowsRuntimeJobStage | null = null;
  for (const match of matches) latest = match[1] as WindowsRuntimeJobStage;
  return latest;
}

function spawnPowerShell(
  script: string,
  environment: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  const trusted = windowsRuntimePowerShellLaunch(environment);
  if (!trusted) throw new Error("The trusted Windows PowerShell runtime is unavailable.");
  return spawn(
    trusted.executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodedPowerShell(script),
    ],
    {
      env: trusted.environment,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

export async function armWindowsRuntimeJob(
  runtimeGenerationId: string,
  runtimePid: number,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly environment?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
    readonly spawnProcess?: typeof spawnPowerShell;
  } = {},
): Promise<WindowsRuntimeJobContainment | null> {
  if ((options.platform ?? process.platform) !== "win32") return null;
  if (!Number.isSafeInteger(runtimePid) || runtimePid <= 1) {
    throw new Error("The Windows runtime process identity is invalid.");
  }
  const name = windowsRuntimeJobName(runtimeGenerationId);
  if (activeJobs.has(name)) {
    throw new Error("The Windows runtime Job Object is already active.");
  }
  const child = (options.spawnProcess ?? spawnPowerShell)(
    commandScript(
      `$result = try {
  [InertiaRuntimeJob]::Guard('${name}', $runtimeHandle)
} finally {
  $runtimeProcess.Dispose()
}
exit $result`,
      `$runtimeProcess = $null
try {
  $runtimeProcess = [Diagnostics.Process]::GetProcessById(${runtimePid})
  # Reading Handle eagerly opens and retains the exact process object before
  # cold Add-Type compilation. A later reuse of the numeric PID cannot retarget
  # AssignProcessToJobObject or WaitForSingleObject.
  $runtimeHandle = $runtimeProcess.Handle
} catch {
  if ($null -ne $runtimeProcess) { $runtimeProcess.Dispose() }
  Write-InertiaJobProtocol 'INERTIA_JOB_ERROR stage=capture-process-handle'
  exit 12
}`,
    ),
    options.environment ?? process.env,
  );
  let stdout = "";
  let stderr = "";
  let ready = false;
  let settleCompletion!: (confirmed: boolean) => void;
  const completion = new Promise<boolean>((resolve) => {
    settleCompletion = resolve;
  });
  activeJobs.set(name, { child, completion });
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = appendBounded(stderr, chunk);
  });
  child.once("exit", (code) => {
    activeJobs.delete(name);
    settleCompletion(code === 0);
  });
  child.once("error", () => settleCompletion(false));

  const startupTimeoutMs = Math.max(1, Math.min(
    options.timeoutMs ?? HELPER_STARTUP_TIMEOUT_MS,
    HELPER_STARTUP_TIMEOUT_MS,
  ));
  const nativeReadyTimeoutMs = Math.min(
    startupTimeoutMs,
    NATIVE_READY_TIMEOUT_MS,
  );
  let deadlineAt = Date.now() + startupTimeoutMs;
  let lastStage: WindowsRuntimeJobStage | null = null;
  let postCompileDeadlineStarted = false;
  let nativeDeadlineStarted = false;
  while (true) {
    if (stdout.split(/\r?\n/u).includes("READY")) {
      ready = true;
      break;
    }
    if (child.exitCode !== null || child.signalCode !== null) break;
    const observedStage = latestHelperStage(stderr);
    if (observedStage !== null) lastStage = observedStage;
    if (lastStage === "add-type-complete" && !postCompileDeadlineStarted) {
      postCompileDeadlineStarted = true;
      deadlineAt = Date.now() + nativeReadyTimeoutMs;
    }
    if (lastStage === "native-guard-start" && !nativeDeadlineStarted) {
      nativeDeadlineStarted = true;
      deadlineAt = Date.now() + nativeReadyTimeoutMs;
    }
    if (Date.now() >= deadlineAt) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  if (!ready) {
    child.kill();
    activeJobs.delete(name);
    const detail = stderr.trim().replace(/\s+/gu, " ").slice(0, 500);
    const outcome = child.exitCode !== null
      ? `The native helper exited with code ${child.exitCode}.`
      : child.signalCode
        ? `The native helper exited from signal ${child.signalCode}.`
        : lastStage === "native-guard-start"
          ? `The native helper did not report readiness within ${nativeReadyTimeoutMs}ms after Guard started.`
          : lastStage === "add-type-complete"
            ? `The native helper did not enter Guard within ${nativeReadyTimeoutMs}ms after Add-Type completed.`
            : lastStage === "powershell-start"
              ? `The PowerShell helper did not complete Add-Type within ${startupTimeoutMs}ms.`
              : `The PowerShell helper did not start within ${startupTimeoutMs}ms.`;
    throw new Error([
      "The Windows runtime Job Object could not be armed.",
      outcome,
      detail,
    ].filter(Boolean).join(" "));
  }
  return { kind: "windows-job-v1", name };
}

export async function recoverWindowsRuntimeJob(
  containment: WindowsRuntimeJobContainment,
  deadlineAt: number,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly environment?: NodeJS.ProcessEnv;
    readonly spawnProcess?: typeof spawnPowerShell;
  } = {},
): Promise<boolean> {
  if ((options.platform ?? process.platform) !== "win32") return false;
  if (Date.now() >= deadlineAt) return false;
  const active = activeJobs.get(containment.name);
  if (active) {
    const remainingMs = Math.max(1, Math.trunc(deadlineAt - Date.now()));
    return await Promise.race([
      active.completion,
      new Promise<false>((resolve) => setTimeout(resolve, remainingMs, false)),
    ]);
  }
  const child = (options.spawnProcess ?? spawnPowerShell)(
    commandScript(
      `$result = [InertiaRuntimeJob]::Recover('${containment.name}'); exit $result`,
    ),
    options.environment ?? process.env,
  );
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (confirmed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(confirmed);
    };
    const timer = setTimeout(() => {
      child.kill();
      settle(false);
    }, Math.max(1, Math.trunc(deadlineAt - Date.now())));
    child.once("error", () => settle(false));
    child.once("exit", (code) => settle(code === 0));
  });
}
