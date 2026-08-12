import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  collectRuntimeStatus,
  runtimeEnvironmentKind,
} from "../../src/server/runtime-status";
import { parseRuntimeStatusCliArguments } from "../../src/server/runtime-status-cli";
import type {
  ProviderDetection,
  ProviderDetectionOptions,
  ProviderId,
} from "../../src/server/provider/contracts";

describe("headless runtime status", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(async (root) =>
      await rm(root, { force: true, recursive: true })));
  });

  async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "inertia-runtime-status-"));
    roots.push(root);
    return root;
  }

  it("classifies remote environments from marker presence without returning values", () => {
    expect(runtimeEnvironmentKind({ SSH_CONNECTION: "secret-ish connection metadata" })).toBe("ssh");
    expect(runtimeEnvironmentKind({ CODESPACES: "true", SSH_TTY: "/dev/pts/1" })).toBe("codespaces");
    expect(runtimeEnvironmentKind({ WSL_DISTRO_NAME: "Ubuntu" })).toBe("wsl");
    expect(runtimeEnvironmentKind({ SSH_CONNECTION: "", CODESPACES: "false" })).toBe("local");
  });

  it("reports non-Git source control as detected but explicitly unsupported", async () => {
    const root = await temporaryRoot();
    const project = join(root, "project", "nested");
    await mkdir(join(root, "project", ".hg"), { recursive: true });
    await mkdir(project, { recursive: true });
    const detectProvider = vi.fn(async (
      providerId: ProviderId,
      _options?: ProviderDetectionOptions,
    ): Promise<ProviderDetection> => ({
      provider: { id: providerId, name: providerId, command: providerId },
      available: false,
      installState: "not-installed",
      authState: "unknown",
      canRun: false,
      cleanupConfirmed: true,
      statusMessage: "CLI not found",
    }));

    const report = await collectRuntimeStatus({
      cwd: project,
      environment: { SSH_CONNECTION: "connection metadata that must not escape" },
    }, {
      detectProvider,
      now: () => new Date("2026-08-09T12:00:00.000Z"),
    });

    expect(report.checkedAt).toBe("2026-08-09T12:00:00.000Z");
    expect(report.environment).toMatchObject({
      kind: "ssh",
      remote: true,
      workspaceReadable: true,
      inspectionReady: true,
    });
    expect(report.sourceControl).toEqual([{
      kind: "mercurial",
      scope: "ancestor",
      inspectionReady: false,
      inspectionSupport: "unsupported",
      mutationReadiness: "unsupported",
      mutationSupport: "unsupported",
    }]);
    expect(JSON.stringify(report)).not.toContain("connection metadata");
    expect(detectProvider).toHaveBeenCalledTimes(4);
    expect(detectProvider.mock.calls.every(([, options]) =>
      options?.probeAuthentication === false)).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "does not trust symlinked source-control markers",
    async () => {
      const root = await temporaryRoot();
      const metadata = join(root, "metadata");
      const project = join(root, "project");
      await mkdir(metadata);
      await mkdir(project);
      await symlink(metadata, join(project, ".hg"));

      const report = await collectRuntimeStatus({ cwd: project }, {
        detectProvider: async (providerId) => ({
          provider: { id: providerId, name: providerId, command: providerId },
          available: false,
          installState: "not-installed",
          authState: "unknown",
          canRun: false,
          cleanupConfirmed: true,
        }),
      });

      expect(report.sourceControl).toEqual([]);
    },
  );

  it("distinguishes detected source-control support from write readiness", async () => {
    const root = await temporaryRoot();
    await Promise.all([
      mkdir(join(root, ".git")),
      mkdir(join(root, ".jj")),
      mkdir(join(root, ".svn")),
      writeFile(join(root, "_FOSSIL_"), "metadata"),
    ]);

    const report = await collectRuntimeStatus({ cwd: root }, {
      detectProvider: async (providerId) => ({
        provider: { id: providerId, name: providerId, command: providerId },
        available: false,
        installState: "not-installed",
        authState: "unknown",
        canRun: false,
        cleanupConfirmed: true,
      }),
    });

    expect(report.sourceControl.map(({ kind }) => kind)).toEqual([
      "git",
      "jujutsu",
      "subversion",
      "fossil",
    ]);
    expect(report.sourceControl[0]).toMatchObject({
      mutationSupport: "supported",
      mutationReadiness: "not-checked",
    });
    expect(report.sourceControl.slice(1).every((item) =>
      item.mutationSupport === "unsupported"
      && item.mutationReadiness === "unsupported")).toBe(true);
  });

  it("keeps provider executables and authentication out of the report", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "file.txt"), "safe");
    const report = await collectRuntimeStatus({ cwd: root }, {
      detectProvider: async (providerId) => ({
        provider: { id: providerId, name: `Provider ${providerId}`, command: providerId },
        available: true,
        executable: join(root, "private", providerId),
        version: "1.2.3",
        installState: "installed",
        authState: "authenticated",
        canRun: true,
        cleanupConfirmed: true,
        statusMessage: "Installed; authentication was not checked",
      }),
    });

    expect(report.providers).toHaveLength(4);
    expect(report.providers[0]).toMatchObject({
      id: "codex",
      authState: "unknown",
      canRun: false,
      version: "1.2.3",
    });
    expect(JSON.stringify(report)).not.toContain(join(root, "private"));
    expect(JSON.stringify(report)).not.toContain("authenticated");
  });

  it("accepts only the bounded status CLI surface", () => {
    expect(parseRuntimeStatusCliArguments(["--cwd", "/tmp/project", "--pretty"])).toEqual({
      cwd: "/tmp/project",
      pretty: true,
      help: false,
    });
    expect(parseRuntimeStatusCliArguments(["--help"])).toMatchObject({ help: true });
    expect(() => parseRuntimeStatusCliArguments(["--cwd"])).toThrow("--cwd requires a bounded path");
    expect(() => parseRuntimeStatusCliArguments(["--token=secret"])).toThrow("Unknown status option.");
  });
});
