// @inertia-test-suite portable

import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  appUpdateArtifactIdentity,
  appUpdateDirectoryIdentityDigest,
  parseWindowsInstallerCandidateExecutableDigest,
  runRestrictedAppUpdateCandidate,
  runRestrictedWindowsAppUpdateCandidate,
  windowsAppUpdateCandidateBootstrapRequest,
  windowsAppUpdateExecutableLineageDigest,
  windowsAppUpdateInstallerIdentity,
} from "../../src/main/app-update-bootstrap";
import {
  AppUpdateHandoffJournal,
  appUpdateHandoffOwner,
  appUpdateHandoffTokenDigest,
} from "../../src/main/app-update-handoff";
import { AppUpdateHandoffTokenVault } from
  "../../src/main/app-update-handoff-token-vault";
import {
  createWindowsUpdateTerminalReceipt,
  serializeWindowsUpdateTerminalReceipt,
  windowsUpdateTerminalReceiptName,
} from "../../src/main/windows-update-terminal-receipt";
import { prepareAppImageUpdate } from "../../src/main/appimage-installed-identity";
import {
  holdAppImageCandidate,
  validateExecutingAppImageCandidate,
} from "../../src/main/appimage-executing-identity";
import {
  linuxAppUpdateCandidateClaimOwnerIsLive,
  recoverLinuxAppUpdateCandidateClaim,
  retireLinuxAppUpdateCandidateClaimAfterAdmission,
  startLinuxAppUpdateCandidate,
} from "../../src/main/linux-app-update-candidate-process";
import {
  LinuxAppUpdateCandidateClaimJournal,
} from "../../src/main/linux-app-update-candidate-claim";
import { executableProcessExists } from "../helpers/executable-process";
import { exactProcessGroupTerminal } from
  "../../src/node/runtime-owned-process-posix";

const roots: string[] = [];
const operationId = "11111111-1111-4111-8111-111111111111";
const launchId = "44444444-4444-4444-8444-444444444444";
const token = "A".repeat(43);

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function executable(path: string, content: string): Promise<string> {
  await writeFile(path, content, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

async function compiledCandidate(path: string, source: string): Promise<string> {
  const sourcePath = `${path}.c`;
  await writeFile(sourcePath, source, { mode: 0o600 });
  const compiler = spawnSync("/usr/bin/cc", [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    sourcePath,
    "-o",
    path,
  ], { encoding: "utf8" });
  if (compiler.status !== 0 || compiler.error) {
    throw new Error(compiler.stderr || compiler.error?.message);
  }
  await chmod(path, 0o755);
  return path;
}

function compiledGuardian(root: string, extraFlags: readonly string[] = []): string {
  const guardian = join(root, "guardian");
  const compiler = spawnSync("/usr/bin/cc", [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    ...extraFlags,
    join(process.cwd(), "native/runtime-process-guardian/linux.c"),
    "-o",
    guardian,
  ], { encoding: "utf8" });
  if (compiler.status !== 0 || compiler.error) {
    throw new Error(compiler.stderr || compiler.error?.message);
  }
  return guardian;
}

function generatedGuardianPath(): string {
  return join(
    process.cwd(),
    "resources/generated/runtime-process-guardian/runtime-process-guardian",
  );
}

async function readEventually(path: string): Promise<string> {
  const deadlineAt = Date.now() + 5_000;
  while (Date.now() < deadlineAt) {
    try { return await readFile(path, "utf8"); } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out reading ${path}.`);
}

async function linuxCandidateFixture(
  root: string,
  downloadedPath: string,
  deadlineMs = 30_000,
) {
  const profile = join(root, "profile");
  const data = join(root, "data");
  await Promise.all([
    mkdir(profile, { mode: 0o700 }),
    mkdir(data, { mode: 0o700 }),
  ]);
  const active = await executable(join(root, "Inertia.AppImage"), "old");
  const staged = await prepareAppImageUpdate({
    channel: "stable",
    activePath: active,
    downloadedPath,
    operationId,
  });
  const now = Date.now();
  const journal = new AppUpdateHandoffJournal(data);
  const prepared = journal.prepare({
    operationId,
    platform: "linux",
    channel: "stable",
    oldVersion: "1.2.3",
    newVersion: "1.3.0",
    oldRuntimeGenerationId:
      "22222222-2222-4222-8222-222222222222:7",
    systemBootId: "linux:33333333-3333-4333-8333-333333333333",
    candidateArtifactDigest: staged.artifactDigest,
    candidateExecutableIdentityDigest: staged.executableIdentityDigest,
    profileIdentityDigest: appUpdateDirectoryIdentityDigest(profile, "profile"),
    dataIdentityDigest: appUpdateDirectoryIdentityDigest(data, "data"),
    handoffTokenDigest: appUpdateHandoffTokenDigest(token)!,
    createdAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + deadlineMs).toISOString(),
  })!;
  const launched = journal.transition(
    appUpdateHandoffOwner(prepared),
    "candidate-launched",
  )!;
  return { data, journal, launched, profile, staged };
}

function acknowledgeLinuxFixture(
  fixture: Awaited<ReturnType<typeof linuxCandidateFixture>>,
) {
  return fixture.journal.acknowledgeCandidateBootstrap(
    appUpdateHandoffOwner(fixture.launched),
    {
      operationId: fixture.launched.operationId,
      platform: fixture.launched.platform,
      channel: fixture.launched.channel,
      oldVersion: fixture.launched.oldVersion,
      newVersion: fixture.launched.newVersion,
      oldRuntimeGenerationId: fixture.launched.oldRuntimeGenerationId,
      candidateArtifactDigest: fixture.launched.candidateArtifactDigest,
      candidateExecutableIdentityDigest:
        fixture.launched.candidateExecutableIdentityDigest,
      profileIdentityDigest: fixture.launched.profileIdentityDigest,
      dataIdentityDigest: fixture.launched.dataIdentityDigest,
      handoffToken: token,
    },
  )!;
}

function transferLinuxFixture(
  fixture: Awaited<ReturnType<typeof linuxCandidateFixture>>,
) {
  const acknowledged = acknowledgeLinuxFixture(fixture);
  const cleaned = fixture.journal.transition(
    appUpdateHandoffOwner(acknowledged),
    "old-generation-cleanup-confirmed",
  )!;
  return fixture.journal.transition(
    appUpdateHandoffOwner(cleaned),
    "ownership-transfer-committed",
  )!;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) =>
    await rm(root, { recursive: true, force: true })));
});

describe("app update artifact identity", () => {
  it("binds exact artifact bytes and a direct-file identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-update-artifact-"));
    roots.push(root);
    const artifact = await executable(join(root, "update.exe"), "installer");

    const identity = await appUpdateArtifactIdentity(artifact);

    expect(identity.artifactDigest).toBe(
      createHash("sha256").update("installer").digest("hex"),
    );
    expect(identity.directFileIdentityDigest).toMatch(/^[0-9a-f]{64}$/u);
    await writeFile(artifact, "replacement", { mode: 0o755 });
    await expect(appUpdateArtifactIdentity(artifact)).resolves.not.toEqual(
      identity,
    );
  });

  it("pins the NSIS digest and candidate marker in one byte-stream pass", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-update-artifact-"));
    roots.push(root);
    const candidateExecutableDigest = sha256("candidate");
    const marker = Buffer.from(
      `inertia.windows-candidate-executable-sha256.v1:${candidateExecutableDigest}`,
      "utf16le",
    );
    const bytes = Buffer.concat([
      Buffer.alloc((1024 * 1024) - 31, 0x5a),
      marker,
      Buffer.alloc(2),
      Buffer.from("signed-trailer"),
    ]);
    const installer = join(root, "update.exe");
    await writeFile(installer, bytes, { mode: 0o755 });

    await expect(windowsAppUpdateInstallerIdentity(installer)).resolves.toEqual({
      artifactDigest: createHash("sha256").update(bytes).digest("hex"),
      candidateExecutableDigest,
      directFileIdentityDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it("rejects ambiguous candidate markers inside one NSIS artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-update-artifact-"));
    roots.push(root);
    const marker = (digest: string): Buffer => Buffer.concat([
      Buffer.from(
        `inertia.windows-candidate-executable-sha256.v1:${digest}`,
        "utf16le",
      ),
      Buffer.alloc(2),
    ]);
    const installer = join(root, "update.exe");
    await writeFile(installer, Buffer.concat([
      marker("a".repeat(64)),
      marker("b".repeat(64)),
    ]), { mode: 0o755 });

    await expect(windowsAppUpdateInstallerIdentity(installer))
      .rejects.toThrow("candidate identity is invalid");
  });

  it("binds the NSIS artifact to the expected version and executable location", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-update-lineage-"));
    roots.push(root);
    const executablePath = await executable(join(root, "Inertia.exe"), "old");
    const input = {
      artifactDigest: "a".repeat(64),
      candidateExecutableDigest: sha256("new"),
      executablePath,
      version: "1.3.0",
    };

    const digest = windowsAppUpdateExecutableLineageDigest(input);

    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(windowsAppUpdateExecutableLineageDigest(input)).toBe(digest);
    expect(windowsAppUpdateExecutableLineageDigest({
      ...input,
      version: "1.3.1",
    })).not.toBe(digest);
    expect(() => windowsAppUpdateExecutableLineageDigest({
      ...input,
      artifactDigest: "A".repeat(64),
    })).toThrow("lineage is invalid");
    expect(parseWindowsInstallerCandidateExecutableDigest(
      `inertia.windows-candidate-executable-sha256.v1:${sha256("new")}`,
    )).toBe(sha256("new"));
    expect(() => parseWindowsInstallerCandidateExecutableDigest(
      `inertia.windows-candidate-executable-sha256.v1:${"A".repeat(64)}`,
    )).toThrow("candidate identity is invalid");
  });
});

describe("restricted Windows app update candidate bootstrap", () => {
  it("rejects same-path, same-size candidate executable substitution", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-update-win-lineage-"));
    roots.push(root);
    const profile = join(root, "profile");
    const data = join(root, "data");
    await Promise.all([
      mkdir(profile, { mode: 0o700 }),
      mkdir(data, { mode: 0o700 }),
    ]);
    const executablePath = await executable(
      join(root, "Inertia.exe"),
      "old-executable",
    );
    const artifactDigest = sha256("signed-installer");
    const candidateExecutableDigest = sha256("candidate-good");
    const now = Date.now();
    const journal = new AppUpdateHandoffJournal(data);
    const prepared = journal.prepare({
      operationId,
      platform: "win32",
      channel: "stable",
      oldVersion: "1.2.3",
      newVersion: "1.3.0",
      oldRuntimeGenerationId:
        "22222222-2222-4222-8222-222222222222:7",
      systemBootId: "win32:deadbeef",
      candidateArtifactDigest: artifactDigest,
      candidateExecutableIdentityDigest:
        windowsAppUpdateExecutableLineageDigest({
          artifactDigest,
          candidateExecutableDigest,
          executablePath,
          version: "1.3.0",
        }),
      profileIdentityDigest: appUpdateDirectoryIdentityDigest(profile, "profile"),
      dataIdentityDigest: appUpdateDirectoryIdentityDigest(data, "data"),
      handoffTokenDigest: appUpdateHandoffTokenDigest(token)!,
      createdAt: new Date(now).toISOString(),
      deadlineAt: new Date(now + 60_000).toISOString(),
    })!;
    const cleaned = journal.transition(
      appUpdateHandoffOwner(prepared),
      "old-generation-cleanup-confirmed",
    )!;
    journal.transition(
      appUpdateHandoffOwner(cleaned),
      "ownership-transfer-committed",
    );

    // Native NSIS replaces the old executable with the build-hook-hashed one.
    await writeFile(executablePath, "candidate-good", { mode: 0o755 });
    await expect(windowsAppUpdateCandidateBootstrapRequest({
      handoffDirectory: data,
      profileDirectory: profile,
      dataDirectory: data,
      executablePath,
      channel: "stable",
      version: "1.3.0",
    })).resolves.toMatchObject({
      snapshot: { operationId },
    });

    // Rewriting the same inode/path with equal-length bytes must not inherit
    // the signed installer's candidate authority.
    await writeFile(executablePath, "candidate-evil", { mode: 0o755 });
    await expect(windowsAppUpdateCandidateBootstrapRequest({
      handoffDirectory: data,
      profileDirectory: profile,
      dataDirectory: data,
      executablePath,
      channel: "stable",
      version: "1.3.0",
    })).rejects.toThrow("candidate lineage is invalid");
  });

  it("transfers only from an exact success receipt and supports crash resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-update-win-bootstrap-"));
    roots.push(root);
    const profile = join(root, "profile");
    const data = join(root, "data");
    await Promise.all([
      mkdir(profile, { mode: 0o700 }),
      mkdir(data, { mode: 0o700 }),
    ]);
    const executablePath = await executable(join(root, "Inertia.exe"), "new");
    const now = Date.now();
    const artifactDigest = "a".repeat(64);
    const journal = new AppUpdateHandoffJournal(data);
    const prepared = journal.prepare({
      operationId,
      platform: "win32",
      channel: "stable",
      oldVersion: "1.2.3",
      newVersion: "1.3.0",
      oldRuntimeGenerationId:
        "22222222-2222-4222-8222-222222222222:7",
      systemBootId: "win32:deadbeef",
      candidateArtifactDigest: artifactDigest,
      candidateExecutableIdentityDigest:
        windowsAppUpdateExecutableLineageDigest({
          artifactDigest,
          candidateExecutableDigest: sha256("new"),
          executablePath,
          version: "1.3.0",
        }),
      profileIdentityDigest: appUpdateDirectoryIdentityDigest(profile, "profile"),
      dataIdentityDigest: appUpdateDirectoryIdentityDigest(data, "data"),
      handoffTokenDigest: appUpdateHandoffTokenDigest(token)!,
      createdAt: new Date(now).toISOString(),
      deadlineAt: new Date(now + 24 * 60 * 60 * 1_000).toISOString(),
    })!;
    const vault = new AppUpdateHandoffTokenVault(data);
    expect(vault.publish(prepared, token)).toBe(true);
    const cleaned = journal.transition(
      appUpdateHandoffOwner(prepared),
      "old-generation-cleanup-confirmed",
    )!;

    const request = await windowsAppUpdateCandidateBootstrapRequest({
      handoffDirectory: data,
      profileDirectory: profile,
      dataDirectory: data,
      executablePath,
      channel: "stable",
      version: "1.3.0",
      now: new Date(now + 5 * 60_000),
    });
    expect(request?.snapshot.phase).toBe("old-generation-cleanup-confirmed");
    await expect(runRestrictedWindowsAppUpdateCandidate(
      request!,
      async () => undefined,
    )).rejects.toThrow("success receipt is invalid");
    expect(journal.current()).toEqual(cleaned);
    expect(vault.matches(cleaned)).toBe(true);

    const receiptPath = join(
      data,
      windowsUpdateTerminalReceiptName(operationId),
    );
    const quarantined = createWindowsUpdateTerminalReceipt({
      schemaVersion: 1,
      operationId,
      handoffChecksum: cleaned.checksum,
      outcome: "quarantined",
      installerExitCode: null,
      installerDigest: artifactDigest,
      supervisorDigest: "c".repeat(64),
      executableDigest: null,
      parentCreationTimeBits: "123456789",
      completedAt: cleaned.transitionedAt,
    }, token);
    await writeFile(
      receiptPath,
      serializeWindowsUpdateTerminalReceipt(quarantined),
      { mode: 0o600 },
    );
    await expect(runRestrictedWindowsAppUpdateCandidate(
      request!,
      async () => undefined,
    )).rejects.toThrow("remains quarantined");
    expect(journal.current()).toEqual(cleaned);
    expect(vault.matches(cleaned)).toBe(true);
    await rm(receiptPath);

    const receipt = createWindowsUpdateTerminalReceipt({
      schemaVersion: 1,
      operationId,
      handoffChecksum: cleaned.checksum,
      outcome: "success",
      installerExitCode: 0,
      installerDigest: artifactDigest,
      supervisorDigest: "c".repeat(64),
      executableDigest: sha256("new"),
      parentCreationTimeBits: "123456789",
      completedAt: cleaned.transitionedAt,
    }, token);
    await writeFile(
      receiptPath,
      serializeWindowsUpdateTerminalReceipt(receipt),
      { mode: 0o600 },
    );
    await expect(windowsAppUpdateCandidateBootstrapRequest({
      handoffDirectory: data,
      profileDirectory: profile,
      dataDirectory: data,
      executablePath,
      channel: "stable",
      version: "1.3.0",
      now: new Date(Date.parse(cleaned.deadlineAt) + 1),
    })).rejects.toThrow("candidate lineage is invalid");
    const validations: Array<readonly [string, unknown]> = [];
    const firstAdmission = await runRestrictedWindowsAppUpdateCandidate(
      request!,
      async (id, expectedOwner) => { validations.push([id, expectedOwner]); },
    );
    expect(firstAdmission.snapshot.phase).toBe("candidate-bootstrap-validated");
    expect(firstAdmission.handoffToken).toBe(token);
    expect(vault.claim(firstAdmission.snapshot)).toBeNull();

    // A crash leaves the claim and monotonic acknowledgement recoverable by
    // the next process after it wins the singleton lock.
    const resumedRequest = await windowsAppUpdateCandidateBootstrapRequest({
      handoffDirectory: data,
      profileDirectory: profile,
      dataDirectory: data,
      executablePath,
      channel: "stable",
      version: "1.3.0",
    });
    const resumed = await runRestrictedWindowsAppUpdateCandidate(
      resumedRequest!,
      async (id, expectedOwner) => { validations.push([id, expectedOwner]); },
    );
    expect(resumed.snapshot).toEqual(firstAdmission.snapshot);
    expect(validations).toEqual([
      [operationId, null],
      [operationId, null],
    ]);
    const admitted = journal.transition(
      appUpdateHandoffOwner(resumed.snapshot),
      "candidate-admitted",
    )!;
    const completed = journal.transition(
      appUpdateHandoffOwner(admitted),
      "completed",
    )!;
    expect(resumed.tokenClaim.commit()).toBe(true);
    expect(journal.retire(appUpdateHandoffOwner(completed))).toBe(true);
    expect(new AppUpdateHandoffTokenVault(data).matches(completed)).toBe(false);
  });

  it("rejects the wrong version, profile, or token without admitting a candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-update-win-bootstrap-"));
    roots.push(root);
    const profile = join(root, "profile");
    const wrongProfile = join(root, "wrong-profile");
    const data = join(root, "data");
    await Promise.all([
      mkdir(profile, { mode: 0o700 }),
      mkdir(wrongProfile, { mode: 0o700 }),
      mkdir(data, { mode: 0o700 }),
    ]);
    const executablePath = await executable(join(root, "Inertia.exe"), "new");
    const now = Date.now();
    const artifactDigest = "a".repeat(64);
    const journal = new AppUpdateHandoffJournal(data);
    const prepared = journal.prepare({
      operationId,
      platform: "win32",
      channel: "stable",
      oldVersion: "1.2.3",
      newVersion: "1.3.0",
      oldRuntimeGenerationId:
        "22222222-2222-4222-8222-222222222222:7",
      systemBootId: "win32:deadbeef",
      candidateArtifactDigest: artifactDigest,
      candidateExecutableIdentityDigest:
        windowsAppUpdateExecutableLineageDigest({
          artifactDigest,
          candidateExecutableDigest: sha256("new"),
          executablePath,
          version: "1.3.0",
        }),
      profileIdentityDigest: appUpdateDirectoryIdentityDigest(profile, "profile"),
      dataIdentityDigest: appUpdateDirectoryIdentityDigest(data, "data"),
      handoffTokenDigest: appUpdateHandoffTokenDigest(token)!,
      createdAt: new Date(now).toISOString(),
      deadlineAt: new Date(now + 30_000).toISOString(),
    })!;
    const vault = new AppUpdateHandoffTokenVault(data);
    expect(vault.publish(prepared, "B".repeat(43))).toBe(false);
    expect(vault.publish(prepared, token)).toBe(true);
    const cleaned = journal.transition(
      appUpdateHandoffOwner(prepared),
      "old-generation-cleanup-confirmed",
    )!;
    journal.transition(
      appUpdateHandoffOwner(cleaned),
      "ownership-transfer-committed",
    );

    await expect(windowsAppUpdateCandidateBootstrapRequest({
      handoffDirectory: data,
      profileDirectory: profile,
      dataDirectory: data,
      executablePath,
      channel: "stable",
      version: "1.3.1",
    })).rejects.toThrow("lineage is invalid");
    await expect(windowsAppUpdateCandidateBootstrapRequest({
      handoffDirectory: data,
      profileDirectory: wrongProfile,
      dataDirectory: data,
      executablePath,
      channel: "stable",
      version: "1.3.0",
    })).rejects.toThrow("lineage is invalid");
    expect(journal.current()?.phase).toBe("ownership-transfer-committed");

    const request = await windowsAppUpdateCandidateBootstrapRequest({
      handoffDirectory: data,
      profileDirectory: profile,
      dataDirectory: data,
      executablePath,
      channel: "stable",
      version: "1.3.0",
    });
    await expect(runRestrictedWindowsAppUpdateCandidate(
      request!,
      async () => { throw new Error("database incompatible"); },
    )).rejects.toThrow("database incompatible");
    expect(journal.current()?.phase).toBe("candidate-launched");
    expect(vault.matches(journal.current()!)).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")(
  "restricted app update candidate bootstrap",
  () => {
    it.skipIf(process.platform !== "linux")(
      "joins abort callers and proves a forked candidate descendant stopped",
      async () => {
        const root = await mkdtemp(join(
          tmpdir(),
          "inertia-update-candidate-tree-",
        ));
        roots.push(root);
        const profile = join(root, "profile");
        const data = join(root, "data");
        await Promise.all([
          mkdir(profile, { mode: 0o700 }),
          mkdir(data, { mode: 0o700 }),
        ]);
        const descendantPath = join(root, "descendant.pid");
        const active = await executable(join(root, "Inertia.AppImage"), "old");
        const downloaded = await compiledCandidate(
          join(root, "downloaded.AppImage"),
          [
            "#include <fcntl.h>",
            "#include <stdio.h>",
            "#include <sys/types.h>",
            "#include <unistd.h>",
            "int main(void) {",
            "  pid_t child = fork();",
            "  if (child < 0) return 2;",
            "  if (child == 0) { for (;;) pause(); }",
            `  int fd = open(${JSON.stringify(descendantPath)},`,
            "    O_WRONLY | O_CREAT | O_EXCL, 0600);",
            "  if (fd < 0) return 3;",
            "  char value[32];",
            "  int size = snprintf(value, sizeof(value), \"%d\", (int)child);",
            "  if (size <= 0 || write(fd, value, (size_t)size) != size) return 4;",
            "  close(fd);",
            "  for (;;) pause();",
            "}",
          ].join("\n"),
        );
        const staged = await prepareAppImageUpdate({
          channel: "stable",
          activePath: active,
          downloadedPath: downloaded,
          operationId,
        });
        const now = Date.now();
        const journal = new AppUpdateHandoffJournal(data);
        const prepared = journal.prepare({
          operationId,
          platform: "linux",
          channel: "stable",
          oldVersion: "1.2.3",
          newVersion: "1.3.0",
          oldRuntimeGenerationId:
            "22222222-2222-4222-8222-222222222222:7",
          systemBootId: "linux:33333333-3333-4333-8333-333333333333",
          candidateArtifactDigest: staged.artifactDigest,
          candidateExecutableIdentityDigest: staged.executableIdentityDigest,
          profileIdentityDigest:
            appUpdateDirectoryIdentityDigest(profile, "profile"),
          dataIdentityDigest: appUpdateDirectoryIdentityDigest(data, "data"),
          handoffTokenDigest: appUpdateHandoffTokenDigest(token)!,
          createdAt: new Date(now).toISOString(),
          deadlineAt: new Date(now + 30_000).toISOString(),
        })!;
        const launched = journal.transition(
          appUpdateHandoffOwner(prepared),
          "candidate-launched",
        )!;

        let descendantPid = 0;
        try {
          const candidate = await startLinuxAppUpdateCandidate({
            executablePath: staged.candidatePath,
            guardianPath: generatedGuardianPath(),
            environment: process.env,
            snapshot: launched,
            handoffDirectory: data,
            launchId,
          });
          descendantPid = Number(await readEventually(descendantPath));
          expect(executableProcessExists(descendantPid)).toBe(true);

          const firstAbort = candidate.abort();
          expect(candidate.abort()).toBe(firstAbort);
          await firstAbort;

          expect(executableProcessExists(descendantPid)).toBe(false);
          expect(new LinuxAppUpdateCandidateClaimJournal(data).current(launched))
            .toBeNull();
          await staged.rollback();
        } finally {
          if (descendantPid > 1 && executableProcessExists(descendantPid)) {
            try { process.kill(descendantPid, "SIGKILL"); } catch {
              // Exact candidate cleanup already removed the descendant.
            }
          }
        }
      },
      10_000,
    );

    it.skipIf(process.platform !== "linux")(
      "rejects a wrong binary and changes to a held candidate",
      async () => {
        const root = await mkdtemp(join(tmpdir(), "inertia-update-held-image-"));
        roots.push(root);
        const downloaded = await executable(
          join(root, "downloaded.AppImage"),
          "expected candidate bytes",
        );
        const fixture = await linuxCandidateFixture(root, downloaded);
        const expected = {
          artifactDigest: fixture.staged.artifactDigest,
          executableIdentityDigest: fixture.staged.executableIdentityDigest,
        };
        await expect(holdAppImageCandidate(
          fixture.staged.candidatePath,
          expected,
          new Date(Date.now() - 1).toISOString(),
        )).rejects.toThrow("verification deadline expired");
        const held = await holdAppImageCandidate(
          fixture.staged.candidatePath,
          expected,
        );
        await writeFile(
          fixture.staged.candidatePath,
          "changed after verification",
          { mode: 0o755 },
        );
        await expect(validateExecutingAppImageCandidate({
          candidatePath: fixture.staged.candidatePath,
          fileDescriptor: held.fileDescriptor,
          expected,
          deadlineAt: new Date(Date.now() + 30_000).toISOString(),
        })).rejects.toThrow(/changed|match/u);
        await held.close();

        const wrongPath = await executable(
          join(root, "wrong.AppImage"),
          "wrong candidate bytes",
        );
        await rename(wrongPath, fixture.staged.candidatePath);
        await expect(holdAppImageCandidate(
          fixture.staged.candidatePath,
          expected,
        )).rejects.toThrow("identity does not match");
      },
    );

    it.skipIf(process.platform !== "linux")(
      "executes sealed verified bytes when the candidate path swaps before launch",
      async () => {
        const root = await mkdtemp(join(tmpdir(), "inertia-update-path-swap-"));
        roots.push(root);
        const expectedMarker = join(root, "expected.marker");
        const wrongMarker = join(root, "wrong.marker");
        const markerSource = (path: string) => [
          "#include <fcntl.h>",
          "#include <unistd.h>",
          "int main(void) {",
          `  int fd = open(${JSON.stringify(path)},`,
          "    O_WRONLY | O_CREAT | O_EXCL, 0600);",
          "  if (fd < 0 || write(fd, \"1\", 1) != 1) return 2;",
          "  close(fd);",
          "  for (;;) pause();",
          "}",
        ].join("\n");
        const downloaded = await compiledCandidate(
          join(root, "downloaded.AppImage"),
          markerSource(expectedMarker),
        );
        const wrong = await compiledCandidate(
          join(root, "wrong.AppImage"),
          markerSource(wrongMarker),
        );
        const fixture = await linuxCandidateFixture(root, downloaded);
        const candidate = await startLinuxAppUpdateCandidate({
          executablePath: fixture.staged.candidatePath,
          guardianPath: generatedGuardianPath(),
          environment: process.env,
          snapshot: fixture.launched,
          handoffDirectory: fixture.data,
          launchId,
          testHooks: {
            afterCandidateHeld: async () => {
              await rename(wrong, fixture.staged.candidatePath);
            },
          },
        });
        await expect(readEventually(expectedMarker)).resolves.toBe("1");
        await expect(readFile(wrongMarker, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
        await candidate.abort();
      },
      10_000,
    );

    it.skipIf(process.platform !== "linux")(
      "admits exactly one of two simultaneous identical candidates",
      async () => {
        const root = await mkdtemp(join(tmpdir(), "inertia-update-dual-"));
        roots.push(root);
        const downloaded = await compiledCandidate(
          join(root, "downloaded.AppImage"),
          "#include <unistd.h>\nint main(void) { for (;;) pause(); }",
        );
        const fixture = await linuxCandidateFixture(root, downloaded);
        const launchIds = [
          "44444444-4444-4444-8444-444444444444",
          "55555555-5555-4555-8555-555555555555",
        ] as const;
        const results = await Promise.allSettled(launchIds.map(async (id) =>
          await startLinuxAppUpdateCandidate({
            executablePath: fixture.staged.candidatePath,
            guardianPath: generatedGuardianPath(),
            environment: process.env,
            snapshot: fixture.launched,
            handoffDirectory: fixture.data,
            launchId: id,
          })));
        const winners = results.filter((result) => result.status === "fulfilled");
        const losers = results.filter((result) => result.status === "rejected");
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);
        const winner = winners[0]!.value;
        const winnerIndex = results.findIndex((result) => result === winners[0]);
        expect(new LinuxAppUpdateCandidateClaimJournal(fixture.data)
          .current(fixture.launched)?.launchId).toBe(launchIds[winnerIndex]);
        expect(winner.alive()).toBe(true);
        await winner.abort();
        expect(new LinuxAppUpdateCandidateClaimJournal(fixture.data)
          .current(fixture.launched)).toBeNull();
      },
      15_000,
    );

    it.skipIf(process.platform !== "linux")(
      "keeps the exact claim across guardian detach until candidate admission",
      async () => {
        const root = await mkdtemp(join(tmpdir(), "inertia-update-transfer-claim-"));
        roots.push(root);
        const downloaded = await compiledCandidate(
          join(root, "downloaded.AppImage"),
          "#include <unistd.h>\nint main(void) { for (;;) pause(); }",
        );
        const fixture = await linuxCandidateFixture(root, downloaded);
        const candidate = await startLinuxAppUpdateCandidate({
          executablePath: fixture.staged.candidatePath,
          guardianPath: generatedGuardianPath(),
          environment: process.env,
          snapshot: fixture.launched,
          handoffDirectory: fixture.data,
          launchId,
        });
        const transferred = transferLinuxFixture(fixture);
        await candidate.transferContainment();
        const claimJournal = new LinuxAppUpdateCandidateClaimJournal(
          fixture.data,
        );
        expect(claimJournal.current(transferred)).toEqual(candidate.claim);
        expect(candidate.alive()).toBe(true);

        process.kill(candidate.pid, "SIGKILL");
        await expect(recoverLinuxAppUpdateCandidateClaim({
          handoffDirectory: fixture.data,
          guardianPath: generatedGuardianPath(),
          snapshot: transferred,
          dependencies: {
            readIdentity: () => null,
            terminalAuthority: () => false,
            recoverGuardian: () => false,
            processGroupTerminal: () => true,
            wait: async () => undefined,
          },
        })).resolves.toBe(false);
        expect(claimJournal.recovery(transferred)?.claim)
          .toEqual(candidate.claim);
      },
      10_000,
    );

    it("recognizes an exact live candidate claim owned by another old app", async () => {
      const root = await mkdtemp(join(tmpdir(), "inertia-update-remote-owner-"));
      roots.push(root);
      const downloaded = await executable(
        join(root, "downloaded.AppImage"),
        "candidate",
      );
      const fixture = await linuxCandidateFixture(root, downloaded);
      const guardian = {
        pid: 2_147_480_051,
        parentPid: 2_147_480_050,
        processGroupId: 2_147_480_051,
        startTimeTicks: "1051",
        guardianExecutableDevice: "41",
        guardianExecutableInode: "42",
      };
      const payload = {
        pid: 2_147_480_052,
        parentPid: guardian.pid,
        processGroupId: guardian.pid,
        startTimeTicks: "1052",
      };
      const claimJournal = new LinuxAppUpdateCandidateClaimJournal(fixture.data);
      const claim = claimJournal.claim(
        fixture.launched,
        launchId,
        guardian,
        payload,
      )!;

      expect(linuxAppUpdateCandidateClaimOwnerIsLive({
        handoffDirectory: fixture.data,
        snapshot: fixture.launched,
        dependencies: {
          readIdentity: (pid) => pid === guardian.pid
            ? guardian
            : pid === payload.pid ? payload : null,
          readGuardianExecutableIdentity: () => ({
            device: guardian.guardianExecutableDevice,
            inode: guardian.guardianExecutableInode,
          }),
        },
      })).toBe(true);
      expect(claimJournal.retire(claim)).toBe(true);
    });

    it("retires only the exact payload claim after durable candidate admission", async () => {
      const root = await mkdtemp(join(tmpdir(), "inertia-update-admitted-"));
      roots.push(root);
      const downloaded = await executable(
        join(root, "downloaded.AppImage"),
        "candidate",
      );
      const fixture = await linuxCandidateFixture(root, downloaded);
      const guardian = {
        pid: 2_147_480_061,
        parentPid: 2_147_480_060,
        processGroupId: 2_147_480_061,
        startTimeTicks: "1061",
        guardianExecutableDevice: "51",
        guardianExecutableInode: "52",
      };
      const payload = {
        pid: 2_147_480_062,
        parentPid: guardian.pid,
        processGroupId: guardian.pid,
        startTimeTicks: "1062",
      };
      const electron = {
        pid: 2_147_480_063,
        parentPid: payload.pid,
        processGroupId: guardian.pid,
        startTimeTicks: "1063",
      };
      const unrelated = {
        pid: 2_147_480_064,
        parentPid: 1,
        processGroupId: guardian.pid,
        startTimeTicks: "1064",
      };
      const claimJournal = new LinuxAppUpdateCandidateClaimJournal(fixture.data);
      const claim = claimJournal.claim(
        fixture.launched,
        launchId,
        guardian,
        payload,
      )!;
      const transferred = transferLinuxFixture(fixture);
      const admitted = fixture.journal.transition(
        appUpdateHandoffOwner(transferred),
        "candidate-admitted",
      )!;

      let electronReads = 0;
      expect(retireLinuxAppUpdateCandidateClaimAfterAdmission({
        handoffDirectory: fixture.data,
        snapshot: admitted,
        instanceChecksum: claim.checksum,
        currentPid: electron.pid,
        readIdentity: (pid) => {
          if (pid === payload.pid) return payload;
          if (pid !== electron.pid) return null;
          electronReads += 1;
          return electronReads === 1
            ? electron
            : { ...electron, startTimeTicks: "reused" };
        },
      })).toBe(false);
      expect(claimJournal.current(admitted)).toEqual(claim);
      expect(retireLinuxAppUpdateCandidateClaimAfterAdmission({
        handoffDirectory: fixture.data,
        snapshot: admitted,
        instanceChecksum: claim.checksum,
        currentPid: unrelated.pid,
        readIdentity: (pid) => pid === unrelated.pid ? unrelated : null,
      })).toBe(false);
      expect(claimJournal.current(admitted)).toEqual(claim);
      expect(retireLinuxAppUpdateCandidateClaimAfterAdmission({
        handoffDirectory: fixture.data,
        snapshot: admitted,
        instanceChecksum: claim.checksum,
        currentPid: electron.pid,
        readIdentity: (pid) => pid === payload.pid
          ? payload
          : pid === electron.pid ? electron : null,
      })).toBe(true);
      expect(claimJournal.recovery(admitted)).toBeNull();
    });

    it.each([
      "candidate-launched",
      "candidate-bootstrap-validated",
    ] as const)(
      "restart reconciles an exact terminal candidate claim from %s",
      async (phase) => {
        const root = await mkdtemp(join(tmpdir(), "inertia-update-reconcile-"));
        roots.push(root);
        const downloaded = await executable(
          join(root, "downloaded.AppImage"),
          "candidate",
        );
        const fixture = await linuxCandidateFixture(root, downloaded);
        const guardian = {
          pid: 2_147_480_001,
          parentPid: process.pid,
          processGroupId: 2_147_480_001,
          startTimeTicks: "1001",
          guardianExecutableDevice: "11",
          guardianExecutableInode: "12",
        };
        const payload = {
          pid: 2_147_480_002,
          parentPid: guardian.pid,
          processGroupId: guardian.pid,
          startTimeTicks: "1002",
        };
        const claimJournal = new LinuxAppUpdateCandidateClaimJournal(
          fixture.data,
        );
        expect(claimJournal.claim(
          fixture.launched,
          launchId,
          guardian,
          payload,
        )).not.toBeNull();
        const snapshot = phase === "candidate-launched"
          ? fixture.launched
          : fixture.journal.acknowledgeCandidateBootstrap(
              appUpdateHandoffOwner(fixture.launched),
              {
                operationId,
                platform: "linux",
                channel: "stable",
                oldVersion: "1.2.3",
                newVersion: "1.3.0",
                oldRuntimeGenerationId:
                  "22222222-2222-4222-8222-222222222222:7",
                candidateArtifactDigest: fixture.staged.artifactDigest,
                candidateExecutableIdentityDigest:
                  fixture.staged.executableIdentityDigest,
                profileIdentityDigest: fixture.launched.profileIdentityDigest,
                dataIdentityDigest: fixture.launched.dataIdentityDigest,
                handoffToken: token,
              },
            )!;
        let guardianAlive = true;
        await expect(recoverLinuxAppUpdateCandidateClaim({
          handoffDirectory: fixture.data,
          guardianPath: generatedGuardianPath(),
          snapshot,
          deadlineAt: Date.now() + 1_000,
          dependencies: {
            readIdentity: (pid) => {
              if (!guardianAlive) return null;
              if (pid === guardian.pid) return guardian;
              if (pid === payload.pid) return payload;
              return null;
            },
            terminalAuthority: () => true,
            recoverGuardian: () => {
              guardianAlive = false;
              return true;
            },
            processGroupTerminal: () => true,
            wait: async () => undefined,
          },
        })).resolves.toBe(true);
        expect(claimJournal.recovery(snapshot)).toBeNull();
      },
    );

    it("keeps missing or PID-reused candidate cleanup quarantined", async () => {
      const root = await mkdtemp(join(tmpdir(), "inertia-update-quarantine-"));
      roots.push(root);
      const downloaded = await executable(
        join(root, "downloaded.AppImage"),
        "candidate",
      );
      const fixture = await linuxCandidateFixture(root, downloaded);
      const guardian = {
        pid: 2_147_480_011,
        parentPid: process.pid,
        processGroupId: 2_147_480_011,
        startTimeTicks: "1011",
        guardianExecutableDevice: "21",
        guardianExecutableInode: "22",
      };
      const payload = {
        pid: 2_147_480_012,
        parentPid: guardian.pid,
        processGroupId: guardian.pid,
        startTimeTicks: "1012",
      };
      const claimJournal = new LinuxAppUpdateCandidateClaimJournal(fixture.data);
      const claim = claimJournal.claim(
        fixture.launched,
        launchId,
        guardian,
        payload,
      )!;
      const transferred = transferLinuxFixture(fixture);
      const recoveryOptions = {
        handoffDirectory: fixture.data,
        guardianPath: generatedGuardianPath(),
        snapshot: transferred,
        deadlineAt: Date.now() + 1_000,
      } as const;
      await expect(recoverLinuxAppUpdateCandidateClaim({
        ...recoveryOptions,
        dependencies: {
          readIdentity: () => null,
          terminalAuthority: () => false,
          recoverGuardian: () => false,
          processGroupTerminal: () => true,
          wait: async () => undefined,
        },
      })).resolves.toBe(false);
      expect(claimJournal.recovery(transferred)?.claim).toEqual(claim);

      expect(claimJournal.publishTerminalProof(claim)).toBe(true);
      await expect(recoverLinuxAppUpdateCandidateClaim({
        ...recoveryOptions,
        dependencies: {
          readIdentity: (pid) => pid === guardian.pid
            ? { ...guardian, startTimeTicks: "9999" }
            : null,
          terminalAuthority: () => false,
          recoverGuardian: () => false,
          processGroupTerminal: () => true,
          wait: async () => undefined,
        },
      })).resolves.toBe(false);
      expect(claimJournal.recovery(transferred)?.terminalProved).toBe(true);
    });

    it("uses durable admission plus exact absence to clear an admission crash", async () => {
      const root = await mkdtemp(join(tmpdir(), "inertia-update-admission-crash-"));
      roots.push(root);
      const downloaded = await executable(
        join(root, "downloaded.AppImage"),
        "candidate",
      );
      const fixture = await linuxCandidateFixture(root, downloaded);
      const guardian = {
        pid: 2_147_480_071,
        parentPid: 2_147_480_070,
        processGroupId: 2_147_480_071,
        startTimeTicks: "1071",
        guardianExecutableDevice: "61",
        guardianExecutableInode: "62",
      };
      const payload = {
        pid: 2_147_480_072,
        parentPid: guardian.pid,
        processGroupId: guardian.pid,
        startTimeTicks: "1072",
      };
      const claimJournal = new LinuxAppUpdateCandidateClaimJournal(fixture.data);
      expect(claimJournal.claim(
        fixture.launched,
        launchId,
        guardian,
        payload,
      )).not.toBeNull();
      const transferred = transferLinuxFixture(fixture);
      const admitted = fixture.journal.transition(
        appUpdateHandoffOwner(transferred),
        "candidate-admitted",
      )!;

      await expect(recoverLinuxAppUpdateCandidateClaim({
        handoffDirectory: fixture.data,
        guardianPath: generatedGuardianPath(),
        snapshot: admitted,
        dependencies: {
          readIdentity: () => null,
          terminalAuthority: () => false,
          recoverGuardian: () => false,
          processGroupTerminal: () => true,
          wait: async () => undefined,
        },
      })).resolves.toBe(true);
      expect(claimJournal.recovery(admitted)).toBeNull();
    });

    it.skipIf(process.platform !== "linux")(
      "waits for a typed ready event while sealing a deliberately slow image",
      async () => {
        const root = await mkdtemp(join(tmpdir(), "inertia-update-ready-copy-"));
        roots.push(root);
        const downloaded = await compiledCandidate(
          join(root, "downloaded.AppImage"),
          "#include <unistd.h>\nint main(void) { for (;;) pause(); }",
        );
        await truncate(downloaded, 16 * 1_024 * 1_024);
        const fixture = await linuxCandidateFixture(root, downloaded, 8_000);
        const guardian = compiledGuardian(root, [
          "-DINERTIA_RUNTIME_GUARDIAN_TEST_SLOW_CANDIDATE_COPY=1",
        ]);
        const startedAt = Date.now();
        const candidate = await startLinuxAppUpdateCandidate({
          executablePath: fixture.staged.candidatePath,
          guardianPath: guardian,
          environment: process.env,
          snapshot: fixture.launched,
          handoffDirectory: fixture.data,
          launchId,
        });
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_000);
        expect(candidate.alive()).toBe(true);
        await candidate.abort();
      },
      15_000,
    );

    it.skipIf(process.platform !== "linux")(
      "bounds slow sealed-copy readiness and exactly cleans a timed-out guardian",
      async () => {
        const root = await mkdtemp(join(tmpdir(), "inertia-update-slow-copy-"));
        roots.push(root);
        const downloaded = await compiledCandidate(
          join(root, "downloaded.AppImage"),
          "#include <unistd.h>\nint main(void) { for (;;) pause(); }",
        );
        await truncate(downloaded, 16 * 1_024 * 1_024);
        const guardian = compiledGuardian(root, [
          "-DINERTIA_RUNTIME_GUARDIAN_TEST_SLOW_CANDIDATE_COPY=1",
        ]);
        const fixture = await linuxCandidateFixture(root, downloaded, 8_000);
        let guardianPid = 0;
        await expect(startLinuxAppUpdateCandidate({
          executablePath: fixture.staged.candidatePath,
          guardianPath: guardian,
          environment: process.env,
          snapshot: fixture.launched,
          handoffDirectory: fixture.data,
          launchId,
          testHooks: {
            afterGuardianSpawned: (pid) => { guardianPid = pid; },
            // Verification uses real time and must complete first. Only the
            // readiness phase observes the same journal deadline as expired.
            readinessNow: () => Date.parse(fixture.launched.deadlineAt),
          },
        })).rejects.toThrow("readiness deadline expired");
        expect(guardianPid).toBeGreaterThan(1);
        expect(exactProcessGroupTerminal(guardianPid, "linux")).toBe(true);
        expect(new LinuxAppUpdateCandidateClaimJournal(fixture.data)
          .current(fixture.launched)).toBeNull();
      },
      15_000,
    );

    it("binds the exact candidate, token, profile, data root, and journal lineage", async () => {
      const root = await mkdtemp(join(tmpdir(), "inertia-update-bootstrap-"));
      roots.push(root);
      const profile = join(root, "profile");
      const data = join(root, "data");
      await Promise.all([
        mkdir(profile, { mode: 0o700 }),
        mkdir(data, { mode: 0o700 }),
      ]);
      const active = await executable(join(root, "Inertia-1.2.3.AppImage"), "old");
      const downloaded = await executable(join(root, "downloaded.AppImage"), "new");
      const staged = await prepareAppImageUpdate({
        channel: "stable",
        activePath: active,
        downloadedPath: downloaded,
        operationId,
      });
      const now = Date.now();
      const journal = new AppUpdateHandoffJournal(data);
      const prepared = journal.prepare({
        operationId,
        platform: "linux",
        channel: "stable",
        oldVersion: "1.2.3",
        newVersion: "1.3.0",
        oldRuntimeGenerationId:
          "22222222-2222-4222-8222-222222222222:7",
        systemBootId: "linux:33333333-3333-4333-8333-333333333333",
        candidateArtifactDigest: staged.artifactDigest,
        candidateExecutableIdentityDigest: staged.executableIdentityDigest,
        profileIdentityDigest: appUpdateDirectoryIdentityDigest(profile, "profile"),
        dataIdentityDigest: appUpdateDirectoryIdentityDigest(data, "data"),
        handoffTokenDigest: appUpdateHandoffTokenDigest(token)!,
        createdAt: new Date(now).toISOString(),
        deadlineAt: new Date(now + 30_000).toISOString(),
      })!;
      const launched = journal.transition(
        appUpdateHandoffOwner(prepared),
        "candidate-launched",
      )!;
      let acknowledgement = "";
      const order: string[] = [];

      const admission = await runRestrictedAppUpdateCandidate({
        request: {
          operationId,
          handoffDirectory: data,
          profileDirectory: profile,
          dataDirectory: data,
          candidatePath: staged.candidatePath,
          imageFileDescriptor: 4,
          launchId,
        },
        // A real AppImage runtime may overwrite APPIMAGE with its invocation
        // descriptor. The separately authenticated named path remains stable.
        environment: { APPIMAGE: "/proc/self/fd/4" },
        platform: "linux",
        channel: "stable",
        version: "1.3.0",
        stdin: Readable.from(JSON.stringify({
          schemaVersion: 1,
          operationId,
          handoffToken: token,
          launchId,
        })),
        writeAcknowledgement: async (packet) => {
          order.push("acknowledged");
          acknowledgement = packet;
        },
        validateBootstrap: async (id, expectedOwner) => {
          expect(id).toBe(operationId);
          expect(expectedOwner).toEqual({
            runtimeGenerationId: prepared.oldRuntimeGenerationId,
            systemBootId: prepared.systemBootId,
          });
          expect(journal.current()?.phase).toBe("candidate-launched");
          order.push("validated");
        },
        waitForTransfer: async () => {
          const acknowledged = journal.current()!;
          const cleaned = journal.transition(
            appUpdateHandoffOwner(acknowledged),
            "old-generation-cleanup-confirmed",
          )!;
          await staged.commit();
          expect(journal.transition(
            appUpdateHandoffOwner(cleaned),
            "ownership-transfer-committed",
          )).not.toBeNull();
        },
        testHooks: {
          validateExecutingCandidate: async () => "c".repeat(64),
        },
      });

      expect(JSON.parse(acknowledgement)).toMatchObject({
        schemaVersion: 1,
        operationId,
        revision: launched.revision + 1,
      });
      expect(order).toEqual(["validated", "acknowledged"]);
      expect(admission.snapshot.phase).toBe("ownership-transfer-committed");
      expect(admission.handoffToken).toBe(token);
      expect(admission.stableAppImagePath).toBe(staged.stablePath);
    });

    it("rejects a stale secret without advancing candidate readiness", async () => {
      const root = await mkdtemp(join(tmpdir(), "inertia-update-bootstrap-"));
      roots.push(root);
      const profile = join(root, "profile");
      const data = join(root, "data");
      await Promise.all([
        mkdir(profile, { mode: 0o700 }),
        mkdir(data, { mode: 0o700 }),
      ]);
      const active = await executable(join(root, "Inertia.AppImage"), "old");
      const downloaded = await executable(join(root, "downloaded.AppImage"), "new");
      const staged = await prepareAppImageUpdate({
        channel: "stable",
        activePath: active,
        downloadedPath: downloaded,
        operationId,
      });
      const now = Date.now();
      const journal = new AppUpdateHandoffJournal(data);
      const prepared = journal.prepare({
        operationId,
        platform: "linux",
        channel: "stable",
        oldVersion: "1.2.3",
        newVersion: "1.3.0",
        oldRuntimeGenerationId:
          "22222222-2222-4222-8222-222222222222:7",
        systemBootId: "linux:33333333-3333-4333-8333-333333333333",
        candidateArtifactDigest: staged.artifactDigest,
        candidateExecutableIdentityDigest: staged.executableIdentityDigest,
        profileIdentityDigest: appUpdateDirectoryIdentityDigest(profile, "profile"),
        dataIdentityDigest: appUpdateDirectoryIdentityDigest(data, "data"),
        handoffTokenDigest: appUpdateHandoffTokenDigest(token)!,
        createdAt: new Date(now).toISOString(),
        deadlineAt: new Date(now + 30_000).toISOString(),
      })!;
      journal.transition(appUpdateHandoffOwner(prepared), "candidate-launched");

      await expect(runRestrictedAppUpdateCandidate({
        request: {
          operationId,
          handoffDirectory: data,
          profileDirectory: profile,
          dataDirectory: data,
          candidatePath: staged.candidatePath,
          imageFileDescriptor: 4,
          launchId,
        },
        environment: { APPIMAGE: staged.candidatePath },
        platform: "linux",
        channel: "stable",
        version: "1.3.0",
        stdin: Readable.from(JSON.stringify({
          schemaVersion: 1,
          operationId,
          handoffToken: "B".repeat(43),
          launchId,
        })),
        writeAcknowledgement: async () => undefined,
        waitForTransfer: async () => undefined,
        testHooks: {
          validateExecutingCandidate: async () => "c".repeat(64),
        },
        validateBootstrap: async () => undefined,
      })).rejects.toThrow("acknowledgement was rejected");
      expect(journal.current()?.phase).toBe("candidate-launched");
      await staged.rollback();
    });
  },
);
