import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  agentSecretRoot,
  clearAgentSecretRoot,
  ensureAgentSecretRoot,
  ensureAgentSecretRootAsync,
  newAgentSecretFileToken,
  readRetainedAgentSecretValues,
  removeAgentSecretDirectory,
  retainedAgentSecretTokens,
  writeAgentSecretFile,
  type AgentSecretExecFileAsync,
  type AgentSecretExecFileSync,
  type WindowsDaclCache,
} from "../../src/server/runtime/agent-secrets/secret-files";

const SECRET = "fake-token-kQ7xZ9pL2mN4";
const WIN32_TEST_ENV: NodeJS.ProcessEnv = {
  SystemRoot: "C:\\Windows",
  TEMP: "C:\\Temp",
  TMP: "C:\\Temp",
  USERPROFILE: "C:\\Users\\ana",
  LOCALAPPDATA: "C:\\Users\\ana\\AppData\\Local",
  UNTRUSTED_SECRET_VAR: "do-not-forward",
};
const directories: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("secret-files symlink refusal and ancestor handling", () => {
  it.runIf(process.platform !== "win32")("refuses when the root directory itself is a symlink", async () => {
    const base = createTempDir("inertia-secret-files-root-link-");
    const target = join(base, "outside");
    const dataDirectory = join(base, "data");
    mkdirSync(target, { recursive: true });
    mkdirSync(dataDirectory, { recursive: true });
    const root = agentSecretRoot(dataDirectory);
    symlinkSync(target, root);

    expect(() => ensureAgentSecretRoot(root)).toThrow("real directory");
    await expect(writeAgentSecretFile(root, newAgentSecretFileToken(), "secret", SECRET)).rejects.toThrow("real directory");
    expect(() => removeAgentSecretDirectory(root, newAgentSecretFileToken())).toThrow("real directory");
    expect(retainedAgentSecretTokens(root)).toEqual([]);
  });

  it.runIf(process.platform !== "win32")(
    "refuses when dataDirectory (parent of root) is a symlink without creating inside the symlink target",
    async () => {
      const base = createTempDir("inertia-secret-files-parent-link-");
      const outside = join(base, "outside");
      mkdirSync(outside, { recursive: true });
      const linkedDataDir = join(base, "data-link");
      symlinkSync(outside, linkedDataDir);
      const root = agentSecretRoot(linkedDataDir);

      expect(() => ensureAgentSecretRoot(root)).toThrow("real directory");
      expect(existsSync(join(outside, "agent-secrets"))).toBe(false);

      // Even if agent-secrets already exists inside outside, operations must refuse it.
      mkdirSync(join(outside, "agent-secrets"), { recursive: true });
      const token = newAgentSecretFileToken();
      await expect(writeAgentSecretFile(root, token, "secret", SECRET)).rejects.toThrow("real directory");
      expect(() => removeAgentSecretDirectory(root, token)).toThrow("real directory");
      expect(retainedAgentSecretTokens(root)).toEqual([]);
      expect(readRetainedAgentSecretValues(root, token)).toEqual([]);
    },
  );

  it.runIf(process.platform !== "win32")(
    "allows a real dataDirectory and root underneath a symlinked OS ancestor (like macOS /var -> /private/var)",
    async () => {
      const base = createTempDir("inertia-secret-files-os-ancestor-");
      const realVar = join(base, "private-var");
      mkdirSync(realVar, { recursive: true });
      const symlinkedVar = join(base, "var");
      symlinkSync(realVar, symlinkedVar);

      // Simulate tmpdir() under /var/... where dataDirectory itself is a real directory.
      const dataDirectory = join(symlinkedVar, "inertia-data");
      mkdirSync(dataDirectory, { recursive: true });
      const root = agentSecretRoot(dataDirectory);
      const token = newAgentSecretFileToken();

      const filePath = await writeAgentSecretFile(root, token, "secret", SECRET);
      expect(readFileSync(filePath, "utf8")).toBe(SECRET);
      expect(retainedAgentSecretTokens(root)).toEqual([token]);
      expect(readRetainedAgentSecretValues(root, token)).toEqual([SECRET]);

      removeAgentSecretDirectory(root, token);
      expect(retainedAgentSecretTokens(root)).toEqual([]);
    },
  );
});

describe("secret-files Windows transient rename retries", () => {
  it("retries EPERM, EBUSY, and EACCES rename errors on win32 and writes the secret file", async () => {
    const base = createTempDir("inertia-secret-files-win32-retry-");
    const root = agentSecretRoot(base);
    const token = newAgentSecretFileToken();
    const sleeps: number[] = [];
    const errors = ["EPERM", "EBUSY", "EACCES"];
    let calls = 0;

    const filePath = await writeAgentSecretFile(root, token, "api-key", SECRET, {
      platform: "win32",
      env: WIN32_TEST_ENV,
      execFile: vi.fn(() => '"HOST\\ana","S-1-5-21-1-2-3-1001"\r\n'),
      windowsDaclCache: { hardenedRoots: new Map() },
      sleep: async (ms) => { sleeps.push(ms); },
      renameFile: async (from, to) => {
        calls += 1;
        if (calls <= errors.length) throw errno(errors[calls - 1]!);
        await rename(from, to);
      },
    });

    expect(calls).toBe(4);
    expect(sleeps).toEqual([25, 50, 75]);
    expect(readFileSync(filePath, "utf8")).toBe(SECRET);
  });

  it("cleans up the partial directory after exhausting 5 win32 retries and skips retries on non-retryable or POSIX errors", async () => {
    const base = createTempDir("inertia-secret-files-win32-fail-");
    const root = agentSecretRoot(base);
    const token = newAgentSecretFileToken();
    const sleeps: number[] = [];
    let attempts = 0;

    await expect(writeAgentSecretFile(root, token, "api-key", SECRET, {
      platform: "win32",
      env: WIN32_TEST_ENV,
      execFile: vi.fn(() => '"HOST\\ana","S-1-5-21-1-2-3-1001"\r\n'),
      windowsDaclCache: { hardenedRoots: new Map() },
      sleep: async (ms) => { sleeps.push(ms); },
      renameFile: async () => {
        attempts += 1;
        throw errno("EPERM");
      },
    })).rejects.toMatchObject({ code: "EPERM" });
    expect(attempts).toBe(5);
    expect(sleeps).toEqual([25, 50, 75, 100]);
    expect(existsSync(join(root, token))).toBe(false);

    let linuxAttempts = 0;
    await expect(writeAgentSecretFile(root, token, "api-key", SECRET, {
      platform: "linux",
      sleep: async () => undefined,
      renameFile: async () => {
        linuxAttempts += 1;
        throw errno("EBUSY");
      },
    })).rejects.toMatchObject({ code: "EBUSY" });
    expect(linuxAttempts).toBe(1);
    expect(existsSync(join(root, token))).toBe(false);
  });
});

describe("secret-files Windows DACL hardening", () => {
  it("applies a protected user-only DirectorySecurity DACL directly from memory without temp files and caches hardened roots", () => {
    const base = createTempDir("inertia-secret-files-win32-dacl-");
    const firstRoot = agentSecretRoot(join(base, "first"));
    const secondRoot = agentSecretRoot(join(base, "second"));
    const cache: WindowsDaclCache = { hardenedRoots: new Map() };
    const execFile = vi.fn<AgentSecretExecFileSync>(() => "");

    ensureAgentSecretRoot(firstRoot, { platform: "win32", env: WIN32_TEST_ENV, execFile, windowsDaclCache: cache });
    expect(execFile).toHaveBeenCalledTimes(1);
    const [file, args, opts] = execFile.mock.calls[0]!;
    expect(file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(args.slice(0, 8)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-InputFormat",
      "None",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
    ]);
    const decodedScript = Buffer.from(args[8]!, "base64").toString("utf16le");
    expect(decodedScript).toContain("$PSModuleAutoLoadingPreference = 'None'");
    expect(decodedScript).toContain("[System.Security.AccessControl.DirectorySecurity]::new()");
    expect(decodedScript).toContain("[System.Security.AccessControl.FileSystemAccessRule]::new(");
    expect(decodedScript).toContain("SetAccessRuleProtection($true, $false)");
    expect(decodedScript).toContain("WindowsIdentity]::GetCurrent().User");
    expect(decodedScript).toContain("SetAccessControl($target, $acl)");
    expect(opts).toMatchObject({
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 25_000,
    });
    expect(opts.env?.INERTIA_AGENT_SECRET_ROOT).toBe(resolve(firstRoot));
    expect(opts.env?.SystemRoot).toBe("C:\\Windows");
    expect(opts.env?.PSModulePath).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules");
    expect(opts.env?.USERPROFILE).toBe("C:\\Users\\ana");
    expect(opts.env?.UNTRUSTED_SECRET_VAR).toBeUndefined();
    expect(readdirSync(dirname(firstRoot))).toEqual(["agent-secrets"]);

    // Calling again on the same existing root does not re-run PowerShell.
    ensureAgentSecretRoot(firstRoot, { platform: "win32", env: WIN32_TEST_ENV, execFile, windowsDaclCache: cache });
    expect(execFile).toHaveBeenCalledTimes(1);

    // A second root applies the DACL with its own env target path.
    ensureAgentSecretRoot(secondRoot, { platform: "win32", env: WIN32_TEST_ENV, execFile, windowsDaclCache: cache });
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile.mock.calls[1]![2].env?.INERTIA_AGENT_SECRET_ROOT).toBe(resolve(secondRoot));

    // Deleting and recreating firstRoot re-hardens its DACL.
    rmSync(firstRoot, { recursive: true, force: true });
    ensureAgentSecretRoot(firstRoot, { platform: "win32", env: WIN32_TEST_ENV, execFile, windowsDaclCache: cache });
    expect(execFile).toHaveBeenCalledTimes(3);
    expect(execFile.mock.calls[2]![2].env?.INERTIA_AGENT_SECRET_ROOT).toBe(resolve(firstRoot));
  });

  it("fails closed without invoking PowerShell when SystemRoot and WINDIR are missing or invalid (S28)", async () => {
    const base = createTempDir("inertia-secret-files-win32-missing-root-");
    const root = agentSecretRoot(base);
    const cache: WindowsDaclCache = { hardenedRoots: new Map() };
    const execFile = vi.fn<AgentSecretExecFileSync>(() => "");
    const execFileAsync = vi.fn<AgentSecretExecFileAsync>(async () => "");

    expect(() => ensureAgentSecretRoot(root, {
      platform: "win32",
      env: {},
      execFile,
      windowsDaclCache: cache,
    })).toThrow("Windows permissions");
    await expect(ensureAgentSecretRootAsync(root, {
      platform: "win32",
      env: { SystemRoot: "relative\\Windows" },
      execFileAsync,
      windowsDaclCache: cache,
    })).rejects.toThrow("Windows permissions");
    await expect(ensureAgentSecretRootAsync(root, {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows\\..\\Temp" },
      execFileAsync,
      windowsDaclCache: cache,
    })).rejects.toThrow("Windows permissions");
    expect(execFile).not.toHaveBeenCalled();
    expect(execFileAsync).not.toHaveBeenCalled();
  });

  it("defers PowerShell DACL hardening when hardenWindowsDacl is false and still hardens before writing a secret file", async () => {
    const base = createTempDir("inertia-secret-files-win32-deferred-");
    const root = agentSecretRoot(base);
    const cache: WindowsDaclCache = { hardenedRoots: new Map() };
    const execFile = vi.fn<AgentSecretExecFileSync>(() => "");

    ensureAgentSecretRoot(root, {
      platform: "win32",
      env: WIN32_TEST_ENV,
      execFile,
      windowsDaclCache: cache,
      hardenWindowsDacl: false,
    });
    expect(existsSync(root)).toBe(true);
    expect(execFile).not.toHaveBeenCalled();
    expect(cache.hardenedRoots.has(resolve(root))).toBe(false);

    const token = newAgentSecretFileToken();
    const filePath = await writeAgentSecretFile(
      root,
      token,
      "api-key",
      SECRET,
      {
        platform: "win32",
        env: WIN32_TEST_ENV,
        execFile,
        windowsDaclCache: cache,
        // Even if a runtime caller injects hardenWindowsDacl: false, writes must still harden.
        hardenWindowsDacl: false,
      } as unknown as Parameters<typeof writeAgentSecretFile>[4],
    );
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(cache.hardenedRoots.has(resolve(root))).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe(SECRET);
  });

  it("invalidates cached DACL identity when a root is removed, recreated, and fails hardening, or replaced externally", async () => {
    const base = createTempDir("inertia-secret-files-win32-cache-invalidation-");
    const root = agentSecretRoot(base);
    const cache: WindowsDaclCache = { hardenedRoots: new Map() };
    let shouldFail = false;
    const execFile = vi.fn<AgentSecretExecFileSync>(() => {
      if (shouldFail) throw new Error("SetAccessControl failed");
      return "";
    });

    // Initial hardening succeeds and caches the directory identity.
    ensureAgentSecretRoot(root, { platform: "win32", env: WIN32_TEST_ENV, execFile, windowsDaclCache: cache });
    expect(execFile).toHaveBeenCalledTimes(1);
    const initialIdentity = cache.hardenedRoots.get(resolve(root));
    expect(typeof initialIdentity).toBe("string");

    // Remove the cached root, recreate via ensureAgentSecretRoot while hardening fails.
    rmSync(root, { recursive: true, force: true });
    shouldFail = true;
    expect(() => ensureAgentSecretRoot(root, { platform: "win32", env: WIN32_TEST_ENV, execFile, windowsDaclCache: cache }))
      .toThrow("Windows permissions");
    expect(cache.hardenedRoots.has(resolve(root))).toBe(false);

    // Subsequent write sees the recreated existing directory, must NOT skip hardening, and fails closed.
    const failedToken = newAgentSecretFileToken();
    await expect(writeAgentSecretFile(root, failedToken, "api-key", SECRET, {
      platform: "win32",
      env: WIN32_TEST_ENV,
      execFile,
      windowsDaclCache: cache,
    })).rejects.toThrow("Windows permissions");
    expect(existsSync(join(root, failedToken))).toBe(false);
    expect(execFile).toHaveBeenCalledTimes(3);

    // Once hardening succeeds again, the write succeeds and caches the new directory identity.
    shouldFail = false;
    const token = newAgentSecretFileToken();
    const filePath = await writeAgentSecretFile(root, token, "api-key", SECRET, {
      platform: "win32",
      env: WIN32_TEST_ENV,
      execFile,
      windowsDaclCache: cache,
    });
    expect(readFileSync(filePath, "utf8")).toBe(SECRET);
    expect(execFile).toHaveBeenCalledTimes(4);

    // If the directory is replaced externally while the cache holds the old identity,
    // the next call detects the identity mismatch and re-hardens even though root exists.
    const replacedIdentity = cache.hardenedRoots.get(resolve(root));
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true, mode: 0o700 });
    // Force a distinct cached identity to guarantee deterministic detection even on fast filesystems.
    cache.hardenedRoots.set(resolve(root), `${replacedIdentity}:stale`);
    ensureAgentSecretRoot(root, { platform: "win32", env: WIN32_TEST_ENV, execFile, windowsDaclCache: cache });
    expect(execFile).toHaveBeenCalledTimes(5);
  });

  it("hardens Windows DACLs asynchronously via ensureAgentSecretRootAsync and caches directory identity", async () => {
    const base = createTempDir("inertia-secret-files-win32-async-");
    const root = agentSecretRoot(base);
    const cache: WindowsDaclCache = { hardenedRoots: new Map() };
    const execFileAsync = vi.fn<AgentSecretExecFileAsync>(async () => "");

    await ensureAgentSecretRootAsync(root, {
      platform: "win32",
      env: WIN32_TEST_ENV,
      execFileAsync,
      windowsDaclCache: cache,
    });
    expect(execFileAsync).toHaveBeenCalledTimes(1);
    expect(cache.hardenedRoots.has(resolve(root))).toBe(true);

    // Subsequent async call on the same directory identity hits the cache.
    await ensureAgentSecretRootAsync(root, {
      platform: "win32",
      env: WIN32_TEST_ENV,
      execFileAsync,
      windowsDaclCache: cache,
    });
    expect(execFileAsync).toHaveBeenCalledTimes(1);

    // Concurrent async calls for the same uncached root coalesce into one PowerShell invocation.
    const secondRoot = agentSecretRoot(join(base, "coalesce"));
    const gate: { release?: () => void } = {};
    const coalescedExec = vi.fn<AgentSecretExecFileAsync>(() => new Promise<string>((resolvePromise) => {
      gate.release = () => resolvePromise("");
    }));
    const firstCall = ensureAgentSecretRootAsync(secondRoot, {
      platform: "win32",
      env: WIN32_TEST_ENV,
      execFileAsync: coalescedExec,
      windowsDaclCache: cache,
    });
    const secondCall = ensureAgentSecretRootAsync(secondRoot, {
      platform: "win32",
      env: WIN32_TEST_ENV,
      execFileAsync: coalescedExec,
      windowsDaclCache: cache,
    });
    expect(coalescedExec).toHaveBeenCalledTimes(1);
    gate.release?.();
    await Promise.all([firstCall, secondCall]);
    expect(coalescedExec).toHaveBeenCalledTimes(1);
    expect(cache.hardenedRoots.has(resolve(secondRoot))).toBe(true);
  });

  it("never invokes PowerShell on POSIX platforms and refuses win32 writes when DACL hardening fails", async () => {
    const base = createTempDir("inertia-secret-files-posix-");
    const execFile = vi.fn<AgentSecretExecFileSync>(() => {
      throw new Error("SetAccessControl failed");
    });

    for (const platform of ["linux", "darwin"] as const) {
      const root = agentSecretRoot(join(base, platform));
      ensureAgentSecretRoot(root, { platform, execFile, windowsDaclCache: { hardenedRoots: new Map() } });
      expect(existsSync(root)).toBe(true);
    }
    expect(execFile).not.toHaveBeenCalled();

    const winRoot = agentSecretRoot(join(base, "win-dacl-fail"));
    const token = newAgentSecretFileToken();
    const cache: WindowsDaclCache = { hardenedRoots: new Map() };
    await expect(writeAgentSecretFile(winRoot, token, "api-key", SECRET, {
      platform: "win32",
      env: WIN32_TEST_ENV,
      execFile,
      windowsDaclCache: cache,
    })).rejects.toThrow("Windows permissions");
    expect(existsSync(join(winRoot, token))).toBe(false);
    expect(cache.hardenedRoots.has(resolve(winRoot))).toBe(false);
  });

  it("clears non-retained entries while preserving kept tokens", async () => {
    const base = createTempDir("inertia-secret-files-clear-");
    const root = agentSecretRoot(base);
    const kept = newAgentSecretFileToken();
    const removed = newAgentSecretFileToken();
    await writeAgentSecretFile(root, kept, "kept-secret", SECRET);
    await writeAgentSecretFile(root, removed, "removed-secret", SECRET);

    clearAgentSecretRoot(root, new Set([kept]));
    expect(retainedAgentSecretTokens(root)).toEqual([kept]);
    expect(readRetainedAgentSecretValues(root, kept)).toEqual([SECRET]);
  });
});
