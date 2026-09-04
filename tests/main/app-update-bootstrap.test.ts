// @inertia-test-suite portable

import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  appUpdateArtifactIdentity,
  appUpdateDirectoryIdentityDigest,
  launchRestrictedAppUpdateCandidate,
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
import { prepareAppImageUpdate } from "../../src/main/appimage-installed-identity";
import { executableProcessExists } from "../helpers/executable-process";

const roots: string[] = [];
const operationId = "11111111-1111-4111-8111-111111111111";
const token = "A".repeat(43);

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function executable(path: string, content: string): Promise<string> {
  await writeFile(path, content, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
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

  it("claims one exact receipt after ownership transfer and supports crash resume", async () => {
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
    journal.transition(
      appUpdateHandoffOwner(cleaned),
      "ownership-transfer-committed",
    );

    const request = await windowsAppUpdateCandidateBootstrapRequest({
      handoffDirectory: data,
      profileDirectory: profile,
      dataDirectory: data,
      executablePath,
      channel: "stable",
      version: "1.3.0",
      now: new Date(now + 5 * 60_000),
    });
    expect(request?.snapshot.phase).toBe("ownership-transfer-committed");
    const validations: string[] = [];
    const firstAdmission = await runRestrictedWindowsAppUpdateCandidate(
      request!,
      async (id) => { validations.push(id); },
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
      async (id) => { validations.push(id); },
    );
    expect(resumed.snapshot).toEqual(firstAdmission.snapshot);
    expect(validations).toEqual([operationId, operationId]);
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
      const root = await mkdtemp(join(tmpdir(), "inertia-update-candidate-tree-"));
      roots.push(root);
      const profile = join(root, "profile");
      const data = join(root, "data");
      await Promise.all([
        mkdir(profile, { mode: 0o700 }),
        mkdir(data, { mode: 0o700 }),
      ]);
      const candidatePath = join(root, "candidate.AppImage");
      const descendantPath = join(root, "descendant.pid");
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
        candidateArtifactDigest: "a".repeat(64),
        candidateExecutableIdentityDigest: "b".repeat(64),
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
      const acknowledged = journal.acknowledgeCandidateBootstrap(
        appUpdateHandoffOwner(launched),
        {
          operationId: launched.operationId,
          platform: launched.platform,
          channel: launched.channel,
          oldVersion: launched.oldVersion,
          newVersion: launched.newVersion,
          oldRuntimeGenerationId: launched.oldRuntimeGenerationId,
          candidateArtifactDigest: launched.candidateArtifactDigest,
          candidateExecutableIdentityDigest:
            launched.candidateExecutableIdentityDigest,
          profileIdentityDigest: launched.profileIdentityDigest,
          dataIdentityDigest: launched.dataIdentityDigest,
          handoffToken: token,
        },
      )!;
      const acknowledgement = JSON.stringify({
        schemaVersion: 1,
        operationId,
        revision: acknowledged.revision,
        checksum: acknowledged.checksum,
      });
      await executable(candidatePath, [
        "#!/usr/bin/env node",
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        "process.stdin.resume();",
        "process.stdin.once('end', () => {",
        `  const child = spawn(${JSON.stringify(process.execPath)},`,
        "    ['-e', 'setInterval(() => undefined, 1000)'],",
        "    { stdio: 'ignore' });",
        `  fs.writeFileSync(${JSON.stringify(descendantPath)}, String(child.pid));`,
        `  process.stdout.end(${JSON.stringify(acknowledgement)});`,
        "  setInterval(() => undefined, 1000);",
        "});",
      ].join("\n"));

      let descendantPid = 0;
      try {
        const candidate = await launchRestrictedAppUpdateCandidate({
          executablePath: candidatePath,
          environment: process.env,
          operationId,
          handoffToken: token,
          handoffDirectory: data,
          profileDirectory: profile,
          dataDirectory: data,
          journal,
        });
        descendantPid = Number(await readFile(descendantPath, "utf8"));
        expect(executableProcessExists(descendantPid)).toBe(true);

        const firstAbort = candidate.abort();
        expect(candidate.abort()).toBe(firstAbort);
        await firstAbort;

        expect(executableProcessExists(descendantPid)).toBe(false);
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
        },
        environment: { APPIMAGE: staged.candidatePath },
        platform: "linux",
        channel: "stable",
        version: "1.3.0",
        stdin: Readable.from(JSON.stringify({
          schemaVersion: 1,
          operationId,
          handoffToken: token,
        })),
        writeAcknowledgement: async (packet) => {
          order.push("acknowledged");
          acknowledgement = packet;
        },
        validateBootstrap: async (id) => {
          expect(id).toBe(operationId);
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
        },
        environment: { APPIMAGE: staged.candidatePath },
        platform: "linux",
        channel: "stable",
        version: "1.3.0",
        stdin: Readable.from(JSON.stringify({
          schemaVersion: 1,
          operationId,
          handoffToken: "B".repeat(43),
        })),
        writeAcknowledgement: async () => undefined,
        waitForTransfer: async () => undefined,
        validateBootstrap: async () => undefined,
      })).rejects.toThrow("acknowledgement was rejected");
      expect(journal.current()?.phase).toBe("candidate-launched");
      await staged.rollback();
    });
  },
);
