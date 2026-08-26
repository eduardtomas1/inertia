import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import { readFileSync } from "node:fs";
import { uptime } from "node:os";
import { win32 } from "node:path";

import { validSystemBootId } from "../node/runtime-process-protocol.js";

export interface SystemBootIdDependencies {
  readonly readFile: (path: string, encoding: "utf8") => string;
  readonly spawn: (
    executable: string,
    args: string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ) => SpawnSyncReturns<string>;
  readonly environment: NodeJS.ProcessEnv;
  readonly now: () => number;
  readonly uptimeSeconds: () => number;
}

const defaultDependencies: SystemBootIdDependencies = {
  readFile: (path, encoding) => readFileSync(path, encoding),
  spawn: (executable, args, options) => spawnSync(executable, args, options),
  environment: process.env,
  now: Date.now,
  uptimeSeconds: uptime,
};

function environmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const entry = Object.entries(environment).find(([key, value]) =>
    key.toLowerCase() === name.toLowerCase() && typeof value === "string");
  return entry?.[1];
}

function boundedCommand(
  dependencies: SystemBootIdDependencies,
  executable: string,
  args: string[],
  environment?: NodeJS.ProcessEnv,
  timeoutMs = 1_000,
): string | null {
  const result = dependencies.spawn(executable, args, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 4_096,
    ...(environment ? { env: environment } : {}),
  });
  return result.status === 0 && !result.error ? result.stdout.trim() : null;
}

export function readSystemBootId(
  platform: NodeJS.Platform = process.platform,
  dependencies: SystemBootIdDependencies = defaultDependencies,
): string | null {
  let candidate: string | null = null;
  try {
    if (platform === "linux") {
      candidate = `linux:${dependencies.readFile(
        "/proc/sys/kernel/random/boot_id",
        "utf8",
      ).trim()}`;
    } else if (platform === "darwin") {
      const value = boundedCommand(dependencies, "/usr/sbin/sysctl", [
        "-n",
        "kern.bootsessionuuid",
      ], { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
      candidate = value ? `darwin:${value}` : null;
    } else if (platform === "win32") {
      const windowsRoot = environmentValue(
        dependencies.environment,
        "SystemRoot",
      );
      if (
        !windowsRoot
        || !win32.isAbsolute(windowsRoot)
        || !/^[a-z]:\\/iu.test(windowsRoot)
      ) return null;
      const value = boundedCommand(
        dependencies,
        win32.join(
          windowsRoot,
          "System32",
          "reg.exe",
        ),
        [
          "QUERY",
          "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters",
          "/v",
          "BootId",
          "/reg:64",
        ],
        {
          SystemRoot: windowsRoot,
          SYSTEMROOT: windowsRoot,
          WINDIR: windowsRoot,
        },
      );
      const matches = [
        ...(value ?? "").matchAll(
          /(?:^|\s)BootId\s+REG_DWORD\s+0x([0-9a-f]{1,8})(?=\s|$)/giu,
        ),
      ];
      const bootId = matches.length === 1 ? matches[0]?.[1] : undefined;
      candidate = bootId
        ? `win32:${bootId.toLowerCase().padStart(8, "0")}`
        : null;
    }
  } catch {
    return null;
  }
  const normalized = candidate && !candidate.startsWith("win32:")
    ? candidate.toLowerCase()
    : candidate;
  return validSystemBootId(normalized) ? normalized : null;
}

const WINDOWS_EPOCH_TICKS = 621_355_968_000_000_000n;
const BOOT_CLOCK_CORROBORATION_MS = 5_000;

export function readSystemBootStartedAtMs(
  platform: NodeJS.Platform = process.platform,
  dependencies: SystemBootIdDependencies = defaultDependencies,
): number | null {
  let milliseconds: number | null = null;
  try {
    if (platform === "linux") {
      const line = dependencies.readFile("/proc/stat", "utf8")
        .split(/\r?\n/u)
        .find((candidate) => candidate.startsWith("btime "));
      const seconds = line?.match(/^btime ([1-9][0-9]{0,15})$/u)?.[1];
      if (seconds) milliseconds = Number(seconds) * 1_000;
    } else if (platform === "darwin") {
      const value = boundedCommand(
        dependencies,
        "/usr/sbin/sysctl",
        ["-n", "kern.boottime"],
        { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      );
      const matches = [...(value ?? "").matchAll(
        /(?:^|[,{]\s*)sec\s*=\s*([1-9][0-9]{0,15})(?=\s*[,}])/gu,
      )];
      if (matches.length === 1) milliseconds = Number(matches[0]?.[1]) * 1_000;
    } else if (platform === "win32") {
      const windowsRoot = environmentValue(
        dependencies.environment,
        "SystemRoot",
      );
      if (
        !windowsRoot
        || !win32.isAbsolute(windowsRoot)
        || !/^[a-z]:\\/iu.test(windowsRoot)
      ) return null;
      const executable = win32.join(
        windowsRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const value = boundedCommand(
        dependencies,
        executable,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference = 'Stop'; $boot = (Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks; [Console]::Out.Write($boot)",
        ],
        {
          ComSpec: win32.join(windowsRoot, "System32", "cmd.exe"),
          PATH: win32.join(windowsRoot, "System32"),
          SystemRoot: windowsRoot,
          SYSTEMROOT: windowsRoot,
          WINDIR: windowsRoot,
        },
        5_000,
      );
      if (/^[1-9][0-9]{10,20}$/u.test(value ?? "")) {
        milliseconds = Number((BigInt(value!) - WINDOWS_EPOCH_TICKS) / 10_000n);
      }
    }
  } catch {
    return null;
  }
  if (
    typeof milliseconds !== "number"
    || !Number.isSafeInteger(milliseconds)
    || milliseconds < 0
  ) {
    return null;
  }
  const now = dependencies.now();
  const uptimeSeconds = dependencies.uptimeSeconds();
  if (
    !Number.isSafeInteger(now)
    || !Number.isFinite(uptimeSeconds)
    || uptimeSeconds < 0
  ) return null;
  const monotonicEstimate = now - Math.round(uptimeSeconds * 1_000);
  return Number.isSafeInteger(monotonicEstimate)
    && Math.abs(milliseconds - monotonicEstimate)
      <= BOOT_CLOCK_CORROBORATION_MS
    ? milliseconds
    : null;
}
