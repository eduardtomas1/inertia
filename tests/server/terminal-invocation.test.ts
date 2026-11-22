import { afterEach, describe, expect, it, vi } from "vitest";

import { userShell } from "../../src/server/terminal-invocation";

afterEach(() => { vi.unstubAllEnvs(); });

describe("Windows user shell selection", () => {
  it("keeps a configured ComSpec", () => {
    vi.stubEnv("ComSpec", "C:\\Windows\\System32\\cmd.exe");
    vi.stubEnv("SystemRoot", "C:\\Windows");
    expect(userShell("win32")).toEqual({ executable: "C:\\Windows\\System32\\cmd.exe", args: [] });
  });

  it("falls back to System32 PowerShell by absolute path", () => {
    vi.stubEnv("ComSpec", undefined);
    vi.stubEnv("SystemRoot", "C:\\Windows");
    expect(userShell("win32")).toEqual({
      executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: [],
    });
  });

  it.each(["cmd.exe", ".\\cmd.exe", "tools\\cmd.exe", "C:cmd.exe"])(
    "replaces the relative ComSpec %s with System32 cmd.exe",
    (comSpec) => {
      vi.stubEnv("ComSpec", comSpec);
      vi.stubEnv("SystemRoot", "C:\\Windows");
      expect(userShell("win32")).toEqual({ executable: "C:\\Windows\\System32\\cmd.exe", args: [] });
    },
  );

  it("falls back to the PowerShell basename for a relative ComSpec without a fully qualified SystemRoot", () => {
    vi.stubEnv("ComSpec", "cmd.exe");
    vi.stubEnv("SystemRoot", "Windows");
    expect(userShell("win32").executable).toBe("powershell.exe");
  });

  it.each([undefined, "Windows"])("keeps the basename fallback without a fully qualified SystemRoot (%s)", (systemRoot) => {
    vi.stubEnv("ComSpec", undefined);
    vi.stubEnv("SystemRoot", systemRoot);
    expect(userShell("win32").executable).toBe("powershell.exe");
  });
});
