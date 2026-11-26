import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AntigravityCliReleaseAsset } from "../../src/server/provider/antigravity-cli-release";
import { providerEnvironment } from "../../src/server/environment";
import {
  installManagedAntigravityRelease,
  managedAntigravityDirectory,
  resolveManagedAntigravityExecutable,
  runManagedAntigravityUpdate,
} from "../../src/server/provider/antigravity-managed-install";
import { detectProvider } from "../../src/server/provider/discovery";
import { ProviderMaintenanceController } from "../../src/server/provider/maintenance-controller";
import { providerInstallationIdentity } from "../../src/server/provider/installation-lease";
import { ProviderLatestVersionCache } from "../../src/server/provider/maintenance-latest";
import type { ProviderMaintenanceOperation } from "../../src/shared/provider-maintenance";
import { providerMaintenanceJournalTestDouble } from "../support/provider-maintenance-journal";

const TEST_SCRATCH_BASE = join(homedir(), ".cache", "inertia-test-antigravity-managed");
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function createTempDataDir(): Promise<string> {
  await mkdir(TEST_SCRATCH_BASE, { recursive: true });
  const dir = await mkdtemp(join(TEST_SCRATCH_BASE, "run-"));
  roots.push(dir);
  return dir;
}

function sha512Hex(data: Buffer): string {
  return createHash("sha512").update(data).digest("hex");
}

interface TarEntrySpec {
  name: string;
  content?: Buffer;
  typeflag?: "0" | "2";
  linkname?: string;
  mode?: number;
}

/** Build a deterministic POSIX USTAR tar.gz buffer without shelling out. */
function buildTarGz(entries: readonly TarEntrySpec[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const content = entry.content ?? Buffer.alloc(0);
    const header = Buffer.alloc(512, 0);
    header.write(entry.name, 0, 100, "utf8");
    header.write(`${(entry.mode ?? 0o755).toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${content.byteLength.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header.write(entry.typeflag ?? "0", 156, 1, "ascii");
    if (entry.linkname) {
      header.write(entry.linkname, 157, 100, "utf8");
    }
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) checksum += header[index]!;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header);
    if (content.byteLength > 0) {
      blocks.push(content);
      const remainder = content.byteLength % 512;
      if (remainder !== 0) {
        blocks.push(Buffer.alloc(512 - remainder, 0));
      }
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}

function linuxAsset(version: string, archive: Buffer): AntigravityCliReleaseAsset {
  return {
    version,
    url: `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}-101/linux-x64/cli_linux_x64.tar.gz`,
    sha512: sha512Hex(archive),
    executableName: "antigravity",
    format: "tar.gz",
  };
}

function windowsAsset(version: string, binary: Buffer): AntigravityCliReleaseAsset {
  return {
    version,
    url: `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}-101/windows-x64/cli_windows_x64.exe`,
    sha512: sha512Hex(binary),
    executableName: "agy.exe",
    format: "executable",
  };
}

function mockDownloadFetch(payload: Buffer): typeof fetch {
  return vi.fn(async () => new Response(new Uint8Array(payload), {
    status: 200,
    headers: { "content-length": String(payload.byteLength) },
  })) as typeof fetch;
}

describe("antigravity-managed-install", () => {
  it("computes the per-platform managed Antigravity directory layout", () => {
    expect(managedAntigravityDirectory("/data/inertia", "linux", "x64")).toBe(
      join("/data/inertia", "tools", "antigravity", "linux-x64"),
    );
    expect(managedAntigravityDirectory("/data/inertia", "darwin", "arm64")).toBe(
      join("/data/inertia", "tools", "antigravity", "darwin-arm64"),
    );
  });

  it.skipIf(process.platform === "win32")(
    "downloads, SHA-512 verifies, extracts tar.gz, validates, and atomically activates on POSIX",
    async () => {
      const dataDirectory = await createTempDataDir();
      const script = Buffer.from([
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "agy 1.5.18"; exit 0; fi',
        'if [ "$1" = "acp" ] && [ "$2" = "--help" ]; then echo "Run the Agent Client Protocol (ACP) server"; exit 0; fi',
        "exit 1",
        "",
      ].join("\n"));
      const archive = buildTarGz([{ name: "antigravity", content: script }]);
      const asset = linuxAsset("1.5.18", archive);

      const installed = await installManagedAntigravityRelease({
        dataDirectory,
        asset,
        fetch: mockDownloadFetch(archive),
        platform: "linux",
        arch: "x64",
      });

      expect(installed.version).toBe("1.5.18");
      expect(installed.releaseId).toBe(asset.sha512.slice(0, 64));
      expect(installed.executablePath).toBe(
        join(
          managedAntigravityDirectory(dataDirectory, "linux", "x64"),
          "versions",
          asset.sha512.slice(0, 64),
          "antigravity",
        ),
      );
      await expect(
        resolveManagedAntigravityExecutable(dataDirectory, "linux", "x64"),
      ).resolves.toEqual(installed);
    },
  );

  it("installs and resolves a Windows executable pack atomically", async () => {
    const dataDirectory = await createTempDataDir();
    const binary = Buffer.from("MZ-fake-windows-agy-binary-1.5.18");
    const asset = windowsAsset("1.5.18", binary);
    const validateExecutable = vi.fn(async () => undefined);

    const installed = await installManagedAntigravityRelease({
      dataDirectory,
      asset,
      fetch: mockDownloadFetch(binary),
      platform: "win32",
      arch: "x64",
      validateExecutable,
    });

    expect(validateExecutable).toHaveBeenCalledTimes(1);
    expect(installed.version).toBe("1.5.18");
    expect(installed.executablePath.endsWith(join("versions", asset.sha512.slice(0, 64), "agy.exe"))).toBe(true);
    await expect(
      resolveManagedAntigravityExecutable(dataDirectory, "win32", "x64"),
    ).resolves.toEqual(installed);
  });

  it("rejects SHA-512 checksum mismatches before extracting or activating", async () => {
    const dataDirectory = await createTempDataDir();
    const archive = buildTarGz([{ name: "antigravity", content: Buffer.from("#!/bin/sh\n") }]);
    const asset: AntigravityCliReleaseAsset = {
      ...linuxAsset("1.5.18", archive),
      sha512: "f".repeat(128),
    };

    await expect(installManagedAntigravityRelease({
      dataDirectory,
      asset,
      fetch: mockDownloadFetch(archive),
      platform: "linux",
      arch: "x64",
    })).rejects.toThrow("SHA-512 checksum");

    await expect(
      resolveManagedAntigravityExecutable(dataDirectory, "linux", "x64"),
    ).resolves.toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "rejects tar archives with path traversal, symlinks, or multiple entries",
    async () => {
      const dataDirectory = await createTempDataDir();
      const maliciousArchives = [
        buildTarGz([{ name: "../antigravity", content: Buffer.from("evil") }]),
        buildTarGz([{ name: "antigravity", typeflag: "2", linkname: "/etc/passwd" }]),
        buildTarGz([
          { name: "antigravity", content: Buffer.from("#!/bin/sh\n") },
          { name: "extra", content: Buffer.from("surprise") },
        ]),
      ];

      for (const archive of maliciousArchives) {
        const asset = linuxAsset("1.5.18", archive);
        await expect(installManagedAntigravityRelease({
          dataDirectory,
          asset,
          fetch: mockDownloadFetch(archive),
          platform: "linux",
          arch: "x64",
          validateExecutable: async () => undefined,
        })).rejects.toThrow("exactly one regular executable");
      }

      await expect(
        resolveManagedAntigravityExecutable(dataDirectory, "linux", "x64"),
      ).resolves.toBeNull();
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects symlink escapes, size mismatches, missing execute bits, and corrupted records on resolve",
    async () => {
      const dataDirectory = await createTempDataDir();
      const script = Buffer.from("#!/bin/sh\necho 1.5.18\n");
      const archive = buildTarGz([{ name: "antigravity", content: script }]);
      const asset = linuxAsset("1.5.18", archive);

      const installed = await installManagedAntigravityRelease({
        dataDirectory,
        asset,
        fetch: mockDownloadFetch(archive),
        platform: "linux",
        arch: "x64",
        validateExecutable: async () => undefined,
      });

      // 1. Missing execute permission
      await chmod(installed.executablePath, 0o644);
      await expect(
        resolveManagedAntigravityExecutable(dataDirectory, "linux", "x64"),
      ).resolves.toBeNull();
      await chmod(installed.executablePath, 0o755);
      await expect(
        resolveManagedAntigravityExecutable(dataDirectory, "linux", "x64"),
      ).resolves.toEqual(installed);

      // 2. Exact byte-size mismatch
      const original = await readFile(installed.executablePath);
      await writeFile(installed.executablePath, Buffer.concat([original, Buffer.from("# tampered\n")]));
      await chmod(installed.executablePath, 0o755);
      await expect(
        resolveManagedAntigravityExecutable(dataDirectory, "linux", "x64"),
      ).resolves.toBeNull();
      await writeFile(installed.executablePath, original);
      await chmod(installed.executablePath, 0o755);

      // 3. Executable replaced with symlink escaping managedDir
      const outsideBinary = join(dataDirectory, "outside-binary");
      await writeFile(outsideBinary, original, { mode: 0o755 });
      await rm(installed.executablePath);
      await symlink(outsideBinary, installed.executablePath);
      await expect(
        resolveManagedAntigravityExecutable(dataDirectory, "linux", "x64"),
      ).resolves.toBeNull();

      // 4. Symlinked managed root rejected by installer too
      const symlinkedDataDir = await createTempDataDir();
      const realTarget = join(symlinkedDataDir, "outside");
      await mkdir(realTarget, { recursive: true });
      await mkdir(join(symlinkedDataDir, "tools", "antigravity"), { recursive: true });
      await symlink(realTarget, managedAntigravityDirectory(symlinkedDataDir, "linux", "x64"));
      await expect(installManagedAntigravityRelease({
        dataDirectory: symlinkedDataDir,
        asset,
        fetch: mockDownloadFetch(archive),
        platform: "linux",
        arch: "x64",
        validateExecutable: async () => undefined,
      })).rejects.toThrow("symbolic link");
    },
  );

  it.skipIf(process.platform === "win32")(
    "discovers a verified managed Antigravity runtime through detectProvider(dataDirectory)",
    async () => {
      const dataDirectory = await createTempDataDir();
      const script = Buffer.from([
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "antigravity 99.0.0"; exit 0; fi',
        'if [ "$1" = "acp" ] && [ "$2" = "--help" ]; then echo "Run the Agent Client Protocol server"; exit 0; fi',
        "exit 1",
        "",
      ].join("\n"));
      const archive = buildTarGz([{ name: "antigravity", content: script }]);
      const targetDir = process.platform === "darwin" ? "darwin" : "linux";
      const targetArch = process.arch === "arm64" ? "arm64" : "x64";
      const asset: AntigravityCliReleaseAsset = {
        version: "99.0.0",
        url: `https://storage.googleapis.com/antigravity-public/antigravity-cli/99.0.0-101/${targetDir}-${targetArch}/cli_${targetDir}_${targetArch}.tar.gz`,
        sha512: sha512Hex(archive),
        executableName: "antigravity",
        format: "tar.gz",
      };

      const installed = await installManagedAntigravityRelease({
        dataDirectory,
        asset,
        fetch: mockDownloadFetch(archive),
        platform: process.platform,
        arch: process.arch,
      });

      const originalPath = process.env.PATH;
      process.env.PATH = "";
      try {
        const detection = await detectProvider("antigravity", {
          dataDirectory,
          probeAuthentication: false,
          refreshEnvironment: true,
        });
        expect(detection).toMatchObject({
          available: true,
          installState: "installed",
          executable: installed.executablePath,
          version: "99.0.0",
          protocolVerified: true,
          cleanupConfirmed: true,
        });
      } finally {
        process.env.PATH = originalPath;
        await providerEnvironment(true);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "aborts stalled release downloads at the bounded deadline and cancels the response body",
    async () => {
      const dataDirectory = await createTempDataDir();
      const archive = buildTarGz([{ name: "antigravity", content: Buffer.from("#!/bin/sh\n") }]);
      const asset = linuxAsset("1.5.18", archive);
      let cancelled = false;
      const stalledStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0x1f, 0x8b]));
        },
        cancel() {
          cancelled = true;
        },
      });
      const stalledFetch = vi.fn(async () => new Response(stalledStream, { status: 200 }));

      await expect(installManagedAntigravityRelease({
        dataDirectory,
        asset,
        fetch: stalledFetch as unknown as typeof fetch,
        platform: "linux",
        arch: "x64",
        downloadTimeoutMs: 50,
        validateExecutable: async () => undefined,
      })).rejects.toThrow(/timed out/iu);
      expect(cancelled).toBe(true);
      await expect(
        resolveManagedAntigravityExecutable(dataDirectory, "linux", "x64"),
      ).resolves.toBeNull();
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects symlinked ancestor directories (tools and tools/antigravity) for both install and discovery",
    async () => {
      const outside = await createTempDataDir();
      const archive = buildTarGz([{ name: "antigravity", content: Buffer.from("#!/bin/sh\necho 1.5.18\n") }]);
      const asset = linuxAsset("1.5.18", archive);
      await installManagedAntigravityRelease({
        dataDirectory: outside,
        asset,
        fetch: mockDownloadFetch(archive),
        platform: "linux",
        arch: "x64",
        validateExecutable: async () => undefined,
      });

      // 1. Symlink at <dataDirectory>/tools -> outside/tools
      const symlinkedToolsRoot = await createTempDataDir();
      await symlink(join(outside, "tools"), join(symlinkedToolsRoot, "tools"));
      await expect(
        resolveManagedAntigravityExecutable(symlinkedToolsRoot, "linux", "x64"),
      ).resolves.toBeNull();
      await expect(installManagedAntigravityRelease({
        dataDirectory: symlinkedToolsRoot,
        asset,
        fetch: mockDownloadFetch(archive),
        platform: "linux",
        arch: "x64",
        validateExecutable: async () => undefined,
      })).rejects.toThrow("symbolic link");

      // 2. Symlink at <dataDirectory>/tools/antigravity -> outside/tools/antigravity
      const symlinkedAgyRoot = await createTempDataDir();
      await mkdir(join(symlinkedAgyRoot, "tools"), { recursive: true });
      await symlink(
        join(outside, "tools", "antigravity"),
        join(symlinkedAgyRoot, "tools", "antigravity"),
      );
      await expect(
        resolveManagedAntigravityExecutable(symlinkedAgyRoot, "linux", "x64"),
      ).resolves.toBeNull();
      await expect(installManagedAntigravityRelease({
        dataDirectory: symlinkedAgyRoot,
        asset,
        fetch: mockDownloadFetch(archive),
        platform: "linux",
        arch: "x64",
        validateExecutable: async () => undefined,
      })).rejects.toThrow("symbolic link");
    },
  );

  it.skipIf(process.platform === "win32")(
    "updates a managed Antigravity runtime through ProviderMaintenanceController under its installation lease",
    async () => {
      const dataDirectory = await createTempDataDir();
      const targetDir = process.platform === "darwin" ? "darwin" : "linux";
      const targetArch = process.arch === "arm64" ? "arm64" : "x64";
      const makeRelease = (version: string) => {
        const script = Buffer.from([
          "#!/bin/sh",
          `if [ "$1" = "--version" ]; then echo "antigravity ${version}"; exit 0; fi`,
          'if [ "$1" = "acp" ] && [ "$2" = "--help" ]; then echo "Run the Agent Client Protocol server"; exit 0; fi',
          "exit 1",
          "",
        ].join("\n"));
        const archive = buildTarGz([{ name: "antigravity", content: script }]);
        const asset: AntigravityCliReleaseAsset = {
          version,
          url: `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}-101/${targetDir}-${targetArch}/cli_${targetDir}_${targetArch}.tar.gz`,
          sha512: sha512Hex(archive),
          executableName: "antigravity",
          format: "tar.gz",
        };
        return { archive, asset };
      };

      const v1 = makeRelease("1.5.17");
      const v2 = makeRelease("1.5.18");
      const installedV1 = await installManagedAntigravityRelease({
        dataDirectory,
        asset: v1.asset,
        fetch: mockDownloadFetch(v1.archive),
        platform: process.platform,
        arch: process.arch,
      });

      const stubFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/manifests/")) {
          return new Response(
            JSON.stringify({ version: v2.asset.version, url: v2.asset.url, sha512: v2.asset.sha512 }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url === v2.asset.url) {
          return new Response(new Uint8Array(v2.archive), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", stubFetch);
      try {
        let currentExecutable = installedV1.executablePath;
        let currentVersion = installedV1.version;
        const operations: ProviderMaintenanceOperation[] = [];
        const controller = new ProviderMaintenanceController({
          dataDirectory,
          maintenanceJournal: providerMaintenanceJournalTestDouble(),
          latestVersions: new ProviderLatestVersionCache({
            fetch: stubFetch as unknown as typeof fetch,
          }),
          target: () => ({
            providerId: "antigravity",
            executable: currentExecutable,
            installedVersion: currentVersion,
            installed: true,
          }),
          installationIdentity: (target) => providerInstallationIdentity({
            providerId: "antigravity",
            executable: target.executable,
            replacementBoundaryIdentity: "agy",
            installationRootIdentity: null,
            packageIdentity: null,
            version: target.installedVersion,
            environmentIdentity: "test",
          }),
          refreshTarget: async () => {
            const resolved = await resolveManagedAntigravityExecutable(
              dataDirectory,
              process.platform,
              process.arch,
            );
            if (resolved) {
              currentExecutable = resolved.executablePath;
              currentVersion = resolved.version;
            }
            return {
              providerId: "antigravity",
              executable: currentExecutable,
              installedVersion: currentVersion,
              installed: Boolean(resolved),
            };
          },
          onOperation: (operation) => operations.push(operation),
        });

        const [advisory] = await controller.refresh(["antigravity"]);
        expect(advisory).toMatchObject({
          installMethod: "provider-managed",
          updateAvailability: "available",
          latestVersion: "1.5.18",
          versionStatus: "update-available",
        });

        const started = await controller.startUpdate("antigravity");
        const deadline = Date.now() + 10_000;
        let terminal: ProviderMaintenanceOperation | undefined;
        while (Date.now() < deadline) {
          terminal = operations.find(
            (op) => op.id === started.id && !["queued", "running"].includes(op.status),
          );
          if (terminal) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }

        expect(terminal).toMatchObject({
          status: "succeeded",
          beforeVersion: "1.5.17",
          afterVersion: "1.5.18",
        });
        expect(controller.hasBlockingAuthority("antigravity")).toBe(false);
        const active = await resolveManagedAntigravityExecutable(
          dataDirectory,
          process.platform,
          process.arch,
        );
        expect(active?.version).toBe("1.5.18");

        const cancelled = new AbortController();
        cancelled.abort();
        await expect(runManagedAntigravityUpdate({
          dataDirectory,
          expectedExecutable: active!.executablePath,
          signal: cancelled.signal,
        })).resolves.toMatchObject({ status: "cancelled", cleanupConfirmed: true });

        // S1: Reject mismatched expectedExecutable from another data directory or POSIX backslash spoofing
        await expect(runManagedAntigravityUpdate({
          dataDirectory,
          expectedExecutable: join(dataDirectory, "other", "antigravity"),
          signal: new AbortController().signal,
        })).resolves.toMatchObject({
          status: "failed",
          cleanupConfirmed: true,
          message: expect.stringContaining("does not match the active managed runtime"),
        });
        await expect(runManagedAntigravityUpdate({
          dataDirectory,
          expectedExecutable: active!.executablePath.replaceAll("/", "\\"),
          signal: new AbortController().signal,
        })).resolves.toMatchObject({
          status: "failed",
          cleanupConfirmed: true,
          message: expect.stringContaining("does not match the active managed runtime"),
        });

        // S8: Controller preserves queued target (1.5.19) when refreshed manifest rolls back to 1.5.18
        const rollbackOps: ProviderMaintenanceOperation[] = [];
        let manifestCalls = 0;
        const rollbackControllerFetch = vi.fn(async () => {
          manifestCalls += 1;
          const version = manifestCalls === 1 ? "1.5.19" : v2.asset.version;
          const url = manifestCalls === 1
            ? `https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.19-101/${targetDir}-${targetArch}/cli_${targetDir}_${targetArch}.tar.gz`
            : v2.asset.url;
          return new Response(
            JSON.stringify({ version, url, sha512: v2.asset.sha512 }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        });
        vi.stubGlobal("fetch", rollbackControllerFetch);
        const rollbackController = new ProviderMaintenanceController({
          dataDirectory,
          maintenanceJournal: providerMaintenanceJournalTestDouble(),
          latestVersions: new ProviderLatestVersionCache({
            fetch: rollbackControllerFetch as unknown as typeof fetch,
            successTtlMs: 0,
          }),
          target: () => ({
            providerId: "antigravity",
            executable: active!.executablePath,
            installedVersion: "1.5.17",
            installed: true,
          }),
          installationIdentity: (target) => providerInstallationIdentity({
            providerId: "antigravity",
            executable: target.executable,
            replacementBoundaryIdentity: "agy",
            installationRootIdentity: null,
            packageIdentity: null,
            version: target.installedVersion,
            environmentIdentity: "test",
          }),
          refreshTarget: async () => ({
            providerId: "antigravity",
            executable: active!.executablePath,
            installedVersion: "1.5.17",
            installed: true,
          }),
          onOperation: (operation) => rollbackOps.push(operation),
        });
        await rollbackController.refresh(["antigravity"]);
        await new Promise((resolve) => setTimeout(resolve, 10));
        const rollbackStarted = await rollbackController.startUpdate("antigravity");
        const rollbackDeadline = Date.now() + 10_000;
        let rollbackTerminal: ProviderMaintenanceOperation | undefined;
        while (Date.now() < rollbackDeadline) {
          rollbackTerminal = rollbackOps.find(
            (op) => op.id === rollbackStarted.id && !["queued", "running"].includes(op.status),
          );
          if (rollbackTerminal) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(rollbackTerminal).toMatchObject({
          status: "failed",
          message: expect.stringContaining("older than approved release 1.5.19"),
        });
        expect(rollbackController.hasBlockingAuthority("antigravity")).toBe(false);
        vi.stubGlobal("fetch", stubFetch);

        // S8: Reject manifest rollback/downgrade and below-floor assets
        const rollbackFetch = vi.fn(async () => new Response(
          JSON.stringify({ version: v1.asset.version, url: v1.asset.url, sha512: v1.asset.sha512 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ));
        await expect(runManagedAntigravityUpdate({
          dataDirectory,
          expectedExecutable: active!.executablePath,
          beforeVersion: "1.5.18",
          minimumVersion: "1.5.18",
          signal: new AbortController().signal,
          fetch: rollbackFetch as unknown as typeof fetch,
        })).resolves.toMatchObject({
          status: "failed",
          cleanupConfirmed: true,
          message: expect.stringContaining("Refused to downgrade"),
        });

        const belowFloor = makeRelease("1.5.16");
        await expect(installManagedAntigravityRelease({
          dataDirectory,
          asset: belowFloor.asset,
          fetch: mockDownloadFetch(belowFloor.archive),
          platform: process.platform,
          arch: process.arch,
          validateExecutable: async () => undefined,
        })).rejects.toThrow(/below the required ACP floor/iu);

        // S7: Propagate unconfirmed process-tree termination as cleanupConfirmed: false
        const stallingScript = Buffer.from("#!/bin/sh\nsleep 30\n");
        const stallingArchive = buildTarGz([{ name: "antigravity", content: stallingScript }]);
        const stallingAsset: AntigravityCliReleaseAsset = {
          version: "1.5.19",
          url: `https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.19-101/${targetDir}-${targetArch}/cli_${targetDir}_${targetArch}.tar.gz`,
          sha512: sha512Hex(stallingArchive),
          executableName: "antigravity",
          format: "tar.gz",
        };
        const abortForCleanup = new AbortController();
        const unconfirmedFetch = vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("/manifests/")) {
            return new Response(
              JSON.stringify({ version: stallingAsset.version, url: stallingAsset.url, sha512: stallingAsset.sha512 }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          setTimeout(() => abortForCleanup.abort(), 150);
          return new Response(new Uint8Array(stallingArchive), { status: 200 });
        });
        const unconfirmedResult = await runManagedAntigravityUpdate({
          dataDirectory,
          expectedExecutable: active!.executablePath,
          beforeVersion: "1.5.18",
          minimumVersion: "1.5.19",
          signal: abortForCleanup.signal,
          fetch: unconfirmedFetch as unknown as typeof fetch,
          terminateProcessTree: async (child) => {
            child.kill("SIGKILL");
            return false;
          },
        });
        expect(unconfirmedResult).toMatchObject({
          status: "failed",
          cleanupConfirmed: false,
        });
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
});
