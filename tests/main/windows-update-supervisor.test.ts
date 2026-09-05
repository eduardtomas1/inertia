// @inertia-test-suite portable

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { appUpdateArtifactIdentity } from
  "../../src/main/app-update-bootstrap";
import {
  AppUpdateHandoffJournal,
  appUpdateHandoffOwner,
  appUpdateHandoffTokenDigest,
} from "../../src/main/app-update-handoff";
import {
  launchWindowsUpdateSupervisor,
  serializeWindowsUpdateSupervisorRequest,
  WindowsUpdateSupervisorCleanupError,
} from "../../src/main/windows-update-supervisor";
import {
  launchWindowsUpdateSupervisorThroughExecutableLock,
  WindowsUpdateSupervisorBrokerError,
} from "../../src/main/windows-runtime-job";
import {
  createWindowsUpdateTerminalReceipt,
  parseWindowsUpdateTerminalReceipt,
  parseWindowsUpdateOperationClaim,
  serializeWindowsUpdateTerminalReceipt,
  windowsUpdateSupervisorExecutableName,
  windowsUpdateOperationClaimAuthenticationTag,
  windowsUpdateTerminalAuthenticationTag,
  windowsUpdateTerminalReceiptName,
  windowsUpdateTerminalReceiptTemporaryName,
} from "../../src/main/windows-update-terminal-receipt";

const roots: string[] = [];
const operationId = "11111111-1111-4111-8111-111111111111";
const token = "A".repeat(43);

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "inertia-win-supervisor-")));
  roots.push(root);
  const dataDirectory = join(root, "data");
  const installDirectory = join(root, "install");
  const assetRoot = join(root, "runtime");
  await Promise.all([
    mkdir(dataDirectory, { mode: 0o700 }),
    mkdir(installDirectory, { mode: 0o700 }),
    mkdir(assetRoot, { mode: 0o700 }),
  ]);
  await Promise.all([
    chmod(dataDirectory, 0o700),
    chmod(installDirectory, 0o700),
    chmod(assetRoot, 0o700),
  ]);
  const installerPath = join(root, "Inertia.Setup.exe");
  const oldExecutablePath = join(installDirectory, "Inertia.exe");
  const assemblyPath = join(assetRoot, "windows-runtime-job.exe");
  const assemblyBytes = Buffer.from("integrity pinned supervisor");
  await Promise.all([
    writeFile(installerPath, "signed installer", { mode: 0o700 }),
    writeFile(oldExecutablePath, "old executable", { mode: 0o700 }),
    writeFile(assemblyPath, assemblyBytes, { mode: 0o700 }),
  ]);
  const [installerIdentity, oldExecutableIdentity] = await Promise.all([
    appUpdateArtifactIdentity(installerPath),
    appUpdateArtifactIdentity(oldExecutablePath),
  ]);
  const now = Date.now();
  const journal = new AppUpdateHandoffJournal(dataDirectory);
  const prepared = journal.prepare({
    operationId,
    platform: "win32",
    channel: "stable",
    oldVersion: "1.2.3",
    newVersion: "1.3.0",
    oldRuntimeGenerationId:
      "22222222-2222-4222-8222-222222222222:7",
    systemBootId: "win32:deadbeef",
    candidateArtifactDigest: installerIdentity.artifactDigest,
    candidateExecutableIdentityDigest: "b".repeat(64),
    profileIdentityDigest: "c".repeat(64),
    dataIdentityDigest: "d".repeat(64),
    handoffTokenDigest: appUpdateHandoffTokenDigest(token)!,
    createdAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + 60_000).toISOString(),
  })!;
  const snapshot = journal.transition(
    appUpdateHandoffOwner(prepared),
    "old-generation-cleanup-confirmed",
  )!;
  return {
    assembly: {
      path: assemblyPath,
      root: assetRoot,
      sha256: createHash("sha256").update(assemblyBytes).digest("hex"),
    },
    dataDirectory,
    installerIdentity,
    installerPath,
    oldExecutableIdentity,
    oldExecutablePath,
    snapshot,
  };
}

function launcher(
  implementation: typeof launchWindowsUpdateSupervisorThroughExecutableLock =
    async () => undefined,
) {
  const launchThroughExecutableLock = vi.fn(implementation);
  return { calls: launchThroughExecutableLock.mock.calls, launchThroughExecutableLock };
}

function decodedRequestFields(request: string): Map<string, string> {
  return new Map(request.trimEnd().split("\n").slice(1).map((line) => {
    const separator = line.indexOf("=");
    return [
      line.slice(0, separator),
      Buffer.from(line.slice(separator + 1), "base64").toString("utf8"),
    ] as const;
  }));
}

async function waitForLeaf(
  path: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // A Windows rename notification can arrive before the exclusive writer
  // releases its handle, and closing that handle need not emit another event.
  while (!existsSync(path) && Date.now() < deadline) await delay(10);
  if (!existsSync(path)) throw new Error(`Timed out waiting for ${path}.`);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) =>
    await rm(root, { force: true, recursive: true })));
});

describe("Windows update supervisor launcher", () => {
  it("stages exact helper bytes outside the install tree and admits only READY", async () => {
    const value = await fixture();
    let request = "";
    const launched = launcher(async (options) => {
      request = options.request;
    });

    const admission = await launchWindowsUpdateSupervisor({
      ...value,
      handoffToken: token,
      newExecutableDigest: "e".repeat(64),
      parentProcessId: 4_242,
      launchThroughExecutableLock: launched.launchThroughExecutableLock,
    });

    expect(admission.helperDigest).toBe(value.assembly.sha256);
    expect(resolve(admission.helperPath)).toBe(resolve(
      value.dataDirectory,
      windowsUpdateSupervisorExecutableName(operationId),
    ));
    await expect(readFile(admission.helperPath)).resolves.toEqual(
      await readFile(value.assembly.path),
    );
    expect(launched.calls[0]?.[0]).toMatchObject({
      assembly: value.assembly,
      helperDigest: value.assembly.sha256,
      helperPath: admission.helperPath,
    });
    expect(request).not.toContain(token);
    expect(request).not.toContain(value.installerPath);
    expect(request).not.toContain(value.oldExecutablePath);
    expect(request).toContain("handoffToken=");
  });

  it("serializes secrets and paths only as bounded stdin fields", async () => {
    const value = await fixture();
    const request = serializeWindowsUpdateSupervisorRequest({
      operationId,
      handoffChecksum: value.snapshot.checksum,
      launchId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      parentProcessId: 4_242,
      installerPath: value.installerPath,
      installerDigest: value.installerIdentity.artifactDigest,
      oldExecutablePath: value.oldExecutablePath,
      oldExecutableDigest: value.oldExecutableIdentity.artifactDigest,
      newExecutablePath: value.oldExecutablePath,
      newExecutableDigest: "e".repeat(64),
      receiptPath: join(value.dataDirectory, "receipt.json"),
      receiptTemporaryPath: join(value.dataDirectory, "receipt.tmp"),
      supervisorDigest: value.assembly.sha256,
      handoffToken: token,
      deadlineAt: value.snapshot.deadlineAt,
    });
    expect(Buffer.byteLength(request)).toBeLessThan(64 * 1_024);
    expect(request.split("\n")).toHaveLength(17);
    expect(request).not.toContain(token);
    expect(request).not.toContain(value.installerPath);
    expect(Buffer.from(
      request.split("\n").find((line) => line.startsWith("handoffToken="))!
        .split("=")[1]!,
      "base64",
    ).toString("utf8")).toBe(token);
  });

  it("pins canonical launch paths before a parent namespace is retargeted", async () => {
    const value = await fixture();
    const aliasParent = join(
      value.oldExecutablePath,
      "..",
      "..",
      "namespace",
    );
    const substitute = join(value.oldExecutablePath, "..", "..", "substitute");
    await mkdir(substitute, { mode: 0o700 });
    symlinkSync(
      join(value.oldExecutablePath, "..", ".."),
      aliasParent,
      process.platform === "win32" ? "junction" : "dir",
    );
    let request = "";
    const launched = launcher(async (options) => {
      request = options.request;
      rmSync(aliasParent);
      symlinkSync(
        substitute,
        aliasParent,
        process.platform === "win32" ? "junction" : "dir",
      );
    });

    const admission = await launchWindowsUpdateSupervisor({
      ...value,
      dataDirectory: join(aliasParent, "data"),
      installerPath: join(aliasParent, "Inertia.Setup.exe"),
      oldExecutablePath: join(aliasParent, "install", "Inertia.exe"),
      handoffToken: token,
      newExecutableDigest: "e".repeat(64),
      launchThroughExecutableLock: launched.launchThroughExecutableLock,
    });
    const fields = new Map<string, string>(
      request.trimEnd().split("\n").slice(1).map((line) => {
        const separator = line.indexOf("=");
        return [
          line.slice(0, separator),
          Buffer.from(line.slice(separator + 1), "base64").toString("utf8"),
        ] as const;
      }),
    );

    expect(fields.get("installerPath")).toBe(resolve(value.installerPath));
    expect(fields.get("oldExecutablePath")).toBe(resolve(
      value.oldExecutablePath,
    ));
    expect(fields.get("receiptPath")).toBe(resolve(
      value.dataDirectory,
      windowsUpdateTerminalReceiptName(operationId),
    ));
    expect(admission.helperPath).toBe(resolve(
      value.dataDirectory,
      windowsUpdateSupervisorExecutableName(operationId),
    ));
    expect([...fields.values()].some((field) => field.includes(aliasParent)))
      .toBe(false);
  });

  it.runIf(process.platform === "win32")(
    "publishes bounded quarantine without killing a still-running installer",
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "inertia-native-win-update-")));
      const helperDirectory = join(root, "helper");
      const installerDirectory = join(root, "installer");
      await Promise.all([
        mkdir(helperDirectory, { mode: 0o700 }),
        mkdir(installerDirectory, { mode: 0o700 }),
      ]);
      const nativeOperationId = "99999999-9999-4999-8999-999999999999";
      const helperPath = join(helperDirectory, windowsUpdateSupervisorExecutableName(nativeOperationId));
      const generatedHelperPath = resolve(
        "resources/generated/runtime-process-guardian/windows-runtime-job.exe",
      );
      const installerPath = join(installerDirectory, "delayed-installer.cmd");
      const installerDonePath = join(installerDirectory, "installer.done");
      const receiptPath = join(
        helperDirectory,
        windowsUpdateTerminalReceiptName(nativeOperationId),
      );
      const receiptTemporaryPath = join(
        helperDirectory,
        windowsUpdateTerminalReceiptTemporaryName(nativeOperationId),
      );
      let parent: ReturnType<typeof spawn> | undefined;
      try {
        await copyFile(generatedHelperPath, helperPath);
        await writeFile(
          installerPath,
          [
            "@echo off",
            "ping.exe -n 12 127.0.0.1 > nul",
            `echo done>"${installerDonePath}"`,
            "",
          ].join("\r\n"),
        );
        const [helperBytes, installerBytes, parentBytes] = await Promise.all([
          readFile(helperPath),
          readFile(installerPath),
          readFile(process.execPath),
        ]);
        const helperDigest = createHash("sha256")
          .update(helperBytes)
          .digest("hex");
        const installerDigest = createHash("sha256")
          .update(installerBytes)
          .digest("hex");
        const parentDigest = createHash("sha256")
          .update(parentBytes)
          .digest("hex");
        const deadlineAt = new Date(Date.now() + 6_000).toISOString();
        parent = spawn(
          process.execPath,
          ["-e", "process.stdin.resume()"],
          { stdio: ["pipe", "ignore", "ignore"], windowsHide: true },
        );
        await new Promise<void>((resolveSpawn, rejectSpawn) => {
          parent!.once("spawn", resolveSpawn);
          parent!.once("error", rejectSpawn);
        });
        const requestOptions = {
          operationId: nativeOperationId,
          handoffChecksum: "a".repeat(64),
          parentProcessId: parent.pid!,
          installerPath,
          installerDigest,
          oldExecutablePath: process.execPath,
          oldExecutableDigest: parentDigest,
          newExecutablePath: process.execPath,
          newExecutableDigest: "f".repeat(64),
          receiptPath,
          receiptTemporaryPath,
          supervisorDigest: helperDigest,
          handoffToken: token,
          deadlineAt,
        } as const;
        const requestTemplate = serializeWindowsUpdateSupervisorRequest({
          ...requestOptions,
          launchId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        });
        await launchWindowsUpdateSupervisorThroughExecutableLock({
          assembly: {
            path: generatedHelperPath,
            root: resolve(generatedHelperPath, ".."),
            sha256: helperDigest,
          },
          helperPath,
          helperDigest,
          request: requestTemplate,
          timeoutMs: 5_000,
        });
        const duplicateRequest = serializeWindowsUpdateSupervisorRequest({
          ...requestOptions,
          launchId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        });
        await expect(launchWindowsUpdateSupervisorThroughExecutableLock({
          assembly: {
            path: generatedHelperPath,
            root: resolve(generatedHelperPath, ".."),
            sha256: helperDigest,
          },
          helperPath,
          helperDigest,
          request: duplicateRequest,
          timeoutMs: 5_000,
        })).rejects.toMatchObject({ cleanupConfirmed: true });
        expect(existsSync(installerDonePath)).toBe(false);
        parent.stdin!.end();
        await new Promise<void>((resolveExit) => {
          parent!.once("close", () => resolveExit());
        });

        try {
          await waitForLeaf(receiptPath, 10_000);
        } catch (error) {
          const temporary = await readFile(receiptTemporaryPath).catch(() => null);
          const terminal = temporary && parseWindowsUpdateTerminalReceipt(temporary);
          const claim = temporary && parseWindowsUpdateOperationClaim(temporary);
          throw new Error(
            `${error instanceof Error ? error.message : String(error)} `
              + `receiptExists=${existsSync(receiptPath)}, `
              + `temporary=${terminal?.outcome ?? (claim ? "claim" : "missing-or-invalid")}, `
              + `installerDone=${existsSync(installerDonePath)}.`,
            { cause: error },
          );
        }
        expect(existsSync(installerDonePath)).toBe(false);
        const receipt = parseWindowsUpdateTerminalReceipt(
          await readFile(receiptPath),
        );
        expect(receipt).toMatchObject({
          executableDigest: null,
          installerDigest,
          installerExitCode: null,
          operationId: nativeOperationId,
          outcome: "quarantined",
          supervisorDigest: helperDigest,
        });
        const { authenticationTag, ...payload } = receipt!;
        expect(windowsUpdateTerminalAuthenticationTag(payload, token)).toBe(
          authenticationTag,
        );
        expect(Date.parse(receipt!.completedAt)).toBeGreaterThanOrEqual(
          Date.parse(deadlineAt),
        );
        await waitForLeaf(installerDonePath, 15_000);
      } finally {
        if (parent && parent.exitCode === null && parent.signalCode === null) {
          parent.kill();
        }
        await rm(root, {
          force: true,
          maxRetries: 20,
          recursive: true,
          retryDelay: 50,
        });
      }
    },
    30_000,
  );

  it("retires only after the verified broker proves pre-admission child exit", async () => {
    const value = await fixture();
    const launched = launcher(async () => {
      throw new WindowsUpdateSupervisorBrokerError(
        "invalid READY from verified child",
        true,
      );
    });

    await expect(launchWindowsUpdateSupervisor({
      ...value,
      handoffToken: token,
      newExecutableDigest: "e".repeat(64),
      readyTimeoutMs: 20,
      launchThroughExecutableLock: launched.launchThroughExecutableLock,
    })).rejects.toThrow("invalid READY from verified child");
    await expect(readFile(join(
      value.dataDirectory,
      windowsUpdateSupervisorExecutableName(operationId),
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retires staged helper authority after a pre-launch broker failure", async () => {
    const value = await fixture();
    const launched = launcher(async () => {
      throw new WindowsUpdateSupervisorBrokerError(
        "broker rejected before launch",
        true,
      );
    });

    await expect(launchWindowsUpdateSupervisor({
      ...value,
      handoffToken: token,
      newExecutableDigest: "e".repeat(64),
      launchThroughExecutableLock: launched.launchThroughExecutableLock,
    })).rejects.toThrow("broker rejected before launch");
    await expect(readFile(join(
      value.dataDirectory,
      windowsUpdateSupervisorExecutableName(operationId),
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats an unclassified broker failure as retained native authority", async () => {
    const value = await fixture();
    const launched = launcher(async () => {
      throw new Error("unclassified broker failure");
    });

    await expect(launchWindowsUpdateSupervisor({
      ...value,
      handoffToken: token,
      newExecutableDigest: "e".repeat(64),
      launchThroughExecutableLock: launched.launchThroughExecutableLock,
    })).rejects.toBeInstanceOf(WindowsUpdateSupervisorCleanupError);
    await expect(readFile(join(
      value.dataDirectory,
      windowsUpdateSupervisorExecutableName(operationId),
    ))).resolves.toBeTruthy();
  });

  it("retires an exact authenticated claim only after broker-proved exit", async () => {
    const value = await fixture();
    const launched = launcher(async (options) => {
      const fields = decodedRequestFields(options.request);
      const claim = {
        schemaVersion: 1 as const,
        operationId,
        handoffChecksum: value.snapshot.checksum,
        launchId: fields.get("launchId")!,
        supervisorDigest: value.assembly.sha256,
        deadlineAt: value.snapshot.deadlineAt,
      };
      await writeFile(
        join(
          value.dataDirectory,
          windowsUpdateTerminalReceiptTemporaryName(operationId),
        ),
        JSON.stringify({
          ...claim,
          authenticationTag: windowsUpdateOperationClaimAuthenticationTag(
            claim,
            token,
          ),
        }),
        { mode: 0o600 },
      );
      throw new WindowsUpdateSupervisorBrokerError("rejected", true);
    });

    await expect(launchWindowsUpdateSupervisor({
      ...value,
      handoffToken: token,
      newExecutableDigest: "e".repeat(64),
      launchThroughExecutableLock: launched.launchThroughExecutableLock,
    })).rejects.toThrow("rejected");
    await expect(readFile(join(
      value.dataDirectory,
      windowsUpdateTerminalReceiptTemporaryName(operationId),
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a fast terminal receipt when the broker samples an exited helper", async () => {
    const value = await fixture();
    const terminal = createWindowsUpdateTerminalReceipt({
      schemaVersion: 1,
      operationId,
      handoffChecksum: value.snapshot.checksum,
      outcome: "success",
      installerExitCode: 0,
      installerDigest: value.installerIdentity.artifactDigest,
      supervisorDigest: value.assembly.sha256,
      executableDigest: "e".repeat(64),
      parentCreationTimeBits: "123456789",
      completedAt: value.snapshot.transitionedAt,
    }, token);
    const launched = launcher(async () => {
      // Model READY, terminal publication, and helper exit all completing
      // before the outer broker result is sampled.
      await writeFile(
        join(
          value.dataDirectory,
          windowsUpdateTerminalReceiptName(operationId),
        ),
        serializeWindowsUpdateTerminalReceipt(terminal),
        { mode: 0o600 },
      );
      throw new WindowsUpdateSupervisorBrokerError(
        "READY helper reached terminal before broker sampling",
        true,
      );
    });

    await expect(launchWindowsUpdateSupervisor({
      ...value,
      handoffToken: token,
      newExecutableDigest: "e".repeat(64),
      launchThroughExecutableLock: launched.launchThroughExecutableLock,
    })).rejects.toBeInstanceOf(WindowsUpdateSupervisorCleanupError);
    await expect(readFile(join(
      value.dataDirectory,
      windowsUpdateTerminalReceiptName(operationId),
    ))).resolves.toEqual(serializeWindowsUpdateTerminalReceipt(terminal));
    await expect(readFile(join(
      value.dataDirectory,
      windowsUpdateSupervisorExecutableName(operationId),
    ))).resolves.toBeTruthy();
  });

  it("never retires a competing launch's authenticated operation claim", async () => {
    const value = await fixture();
    const competingLaunchId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const competingClaim = {
      schemaVersion: 1 as const,
      operationId,
      handoffChecksum: value.snapshot.checksum,
      launchId: competingLaunchId,
      supervisorDigest: value.assembly.sha256,
      deadlineAt: value.snapshot.deadlineAt,
    };
    const launched = launcher(async () => {
      await writeFile(
        join(
          value.dataDirectory,
          windowsUpdateTerminalReceiptTemporaryName(operationId),
        ),
        JSON.stringify({
          ...competingClaim,
          authenticationTag: windowsUpdateOperationClaimAuthenticationTag(
            competingClaim,
            token,
          ),
        }),
        { mode: 0o600 },
      );
      throw new WindowsUpdateSupervisorBrokerError("duplicate rejected", true);
    });

    await expect(launchWindowsUpdateSupervisor({
      ...value,
      handoffToken: token,
      newExecutableDigest: "e".repeat(64),
      launchThroughExecutableLock: launched.launchThroughExecutableLock,
    })).rejects.toBeInstanceOf(WindowsUpdateSupervisorCleanupError);
    const retained = parseWindowsUpdateOperationClaim(await readFile(join(
      value.dataDirectory,
      windowsUpdateTerminalReceiptTemporaryName(operationId),
    )));
    expect(retained?.launchId).toBe(competingLaunchId);
    await expect(readFile(join(
      value.dataDirectory,
      windowsUpdateSupervisorExecutableName(operationId),
    ))).resolves.toBeTruthy();
  });

  it("retains native authority when rejected-helper exit cannot be proved", async () => {
    const value = await fixture();
    const launched = launcher(async () => {
      throw new WindowsUpdateSupervisorBrokerError(
        "verified child exit was not observed",
        false,
      );
    });

    await expect(launchWindowsUpdateSupervisor({
      ...value,
      handoffToken: token,
      newExecutableDigest: "e".repeat(64),
      readyTimeoutMs: 20,
      launchThroughExecutableLock: launched.launchThroughExecutableLock,
    })).rejects.toBeInstanceOf(WindowsUpdateSupervisorCleanupError);
  });

  it("refuses a substituted staged helper on replay", async () => {
    const value = await fixture();
    const firstLaunch = launcher();
    await launchWindowsUpdateSupervisor({
      ...value,
      handoffToken: token,
      newExecutableDigest: "e".repeat(64),
      launchThroughExecutableLock: firstLaunch.launchThroughExecutableLock,
    });
    await writeFile(
      join(
        value.dataDirectory,
        windowsUpdateSupervisorExecutableName(operationId),
      ),
      "substituted helper",
      { mode: 0o700 },
    );
    const secondLaunch = launcher();

    await expect(launchWindowsUpdateSupervisor({
      ...value,
      handoffToken: token,
      newExecutableDigest: "e".repeat(64),
      launchThroughExecutableLock: secondLaunch.launchThroughExecutableLock,
    })).rejects.toThrow("staged Windows update supervisor is invalid");
    expect(secondLaunch.calls).toEqual([]);
  });
});
