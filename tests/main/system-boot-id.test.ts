import type { SpawnSyncReturns } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import {
  readSystemBootId,
  type SystemBootIdDependencies,
} from "../../src/main/system-boot-id";

function spawnResult(
  stdout: string,
  status = 0,
): SpawnSyncReturns<string> {
  return {
    pid: 42,
    output: [null, stdout, ""],
    stdout,
    stderr: "",
    status,
    signal: null,
    error: undefined,
  };
}

function dependencies(
  overrides: Partial<SystemBootIdDependencies> = {},
): SystemBootIdDependencies {
  return {
    readFile: vi.fn(() => "11111111-1111-4111-8111-111111111111\n"),
    spawn: vi.fn(() => spawnResult("")),
    environment: {},
    ...overrides,
  };
}

describe("system boot identity", () => {
  it("reads and canonicalizes the Linux kernel boot identity", () => {
    const readFile = vi.fn(() =>
      "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA\n");
    const bootId = readSystemBootId("linux", dependencies({ readFile }));

    expect(bootId).toBe("linux:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(readFile).toHaveBeenCalledWith(
      "/proc/sys/kernel/random/boot_id",
      "utf8",
    );
  });

  it("fails closed when the Linux identity cannot be read", () => {
    const readFile = vi.fn(() => {
      throw new Error("denied");
    });
    expect(readSystemBootId("linux", dependencies({ readFile }))).toBeNull();
  });

  it("uses the fixed Darwin boot-session query with bounded process options", () => {
    const spawn = vi.fn(() => spawnResult(
      "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA\n",
    ));

    expect(readSystemBootId("darwin", dependencies({ spawn }))).toBe(
      "darwin:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(spawn).toHaveBeenCalledWith(
      "/usr/sbin/sysctl",
      ["-n", "kern.bootsessionuuid"],
      expect.objectContaining({
        encoding: "utf8",
        shell: false,
        timeout: 1_000,
        maxBuffer: 4_096,
      }),
    );
  });

  it("rejects malformed or failed Darwin probes", () => {
    const malformed = vi.fn(() => spawnResult("not-a-uuid"));
    const failed = vi.fn(() => spawnResult("", 1));

    expect(readSystemBootId("darwin", dependencies({ spawn: malformed })))
      .toBeNull();
    expect(readSystemBootId("darwin", dependencies({ spawn: failed })))
      .toBeNull();
  });

  it("reads one canonical Windows BootId with no inherited secrets", () => {
    const spawn = vi.fn(() => spawnResult(
      "    BootId    REG_DWORD    0x2A\r\n",
    ));
    const environment = {
      SystemRoot: "C:\\Windows",
      SECRET_TOKEN: "must-not-be-inherited",
    };

    expect(readSystemBootId(
      "win32",
      dependencies({ spawn, environment }),
    )).toBe("win32:0000002a");
    expect(spawn).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\reg.exe",
      [
        "QUERY",
        "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters",
        "/v",
        "BootId",
        "/reg:64",
      ],
      expect.objectContaining({
        shell: false,
        windowsHide: true,
        timeout: 1_000,
        maxBuffer: 4_096,
        env: {
          SystemRoot: "C:\\Windows",
          SYSTEMROOT: "C:\\Windows",
          WINDIR: "C:\\Windows",
        },
      }),
    );
  });

  it("rejects ambiguous, malformed, failed, and untrusted Windows probes", () => {
    const ambiguous = vi.fn(() => spawnResult(
      "BootId REG_DWORD 0x1\nBootId REG_DWORD 0x2\n",
    ));
    const malformed = vi.fn(() => spawnResult("BootId REG_SZ 2"));
    const failed = vi.fn(() => spawnResult("", 1));

    expect(readSystemBootId("win32", dependencies({
      spawn: ambiguous,
      environment: { SystemRoot: "C:\\Windows" },
    }))).toBeNull();
    expect(readSystemBootId("win32", dependencies({
      spawn: malformed,
      environment: { SystemRoot: "C:\\Windows" },
    }))).toBeNull();
    expect(readSystemBootId("win32", dependencies({
      spawn: failed,
      environment: { SystemRoot: "C:\\Windows" },
    }))).toBeNull();
    expect(readSystemBootId("win32", dependencies({
      spawn: ambiguous,
      environment: { SystemRoot: "relative" },
    }))).toBeNull();
  });
});
