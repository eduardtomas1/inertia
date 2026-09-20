import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  finalizeAppImageUpdate,
  prepareAppImageUpdate,
  recoverAppImageUpdate,
  recoverAppImageUpdateForHandoff,
  validateCommittedAppImageUpdate,
  validateStagedAppImageUpdate,
} from "../../src/main/appimage-installed-identity";

// These fixtures exercise filesystem admission. The real token-bound bootstrap
// and runtime-readiness handshake remains covered by electron-app-updater tests.
async function completePreparedUpdate(
  options: Omit<Parameters<typeof prepareAppImageUpdate>[0], "operationId">,
): Promise<string> {
  const staged = await prepareAppImageUpdate({
    ...options,
    operationId: "44444444-4444-4444-8444-444444444444",
  });
  const authority = {
    channel: options.channel,
    operationId: staged.operationId,
    artifactDigest: staged.artifactDigest,
    executableIdentityDigest: staged.executableIdentityDigest,
  };
  await validateStagedAppImageUpdate({
    ...authority,
    candidatePath: staged.candidatePath,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
  });
  const stablePath = await staged.commit();
  await validateCommittedAppImageUpdate({
    ...authority,
    stablePath,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
  });
  await finalizeAppImageUpdate({ ...authority, stablePath });
  return stablePath;
}

const roots: string[] = [];

async function temporaryRoot(prefix = "inertia-appimage-identity-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function appImage(path: string, content: string): Promise<string> {
  await writeFile(path, content, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

async function missing(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

function fileIdentity(metadata: Awaited<ReturnType<typeof lstat>>) {
  return { dev: String(metadata.dev), ino: String(metadata.ino) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) =>
    await rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform === "win32")("stable AppImage installed identity", () => {
  it("keeps staging, ownership commit, and rollback retirement distinct", async () => {
    const root = await temporaryRoot();
    const active = await appImage(
      join(root, "Inertia-0.0.46.AppImage"),
      "known-good",
    );
    const downloaded = await appImage(
      join(root, "downloaded.AppImage"),
      "validated-candidate",
    );
    const operationId = "11111111-1111-4111-8111-111111111111";
    const staged = await prepareAppImageUpdate({
      channel: "stable",
      activePath: active,
      downloadedPath: downloaded,
      operationId,
    });

    expect(await readFile(active, "utf8")).toBe("known-good");
    expect(await missing(staged.stablePath)).toBe(true);
    await expect(validateStagedAppImageUpdate({
      channel: "stable",
      operationId,
      candidatePath: staged.candidatePath,
      artifactDigest: staged.artifactDigest,
      executableIdentityDigest: staged.executableIdentityDigest,
      deadlineAt: new Date(Date.now() - 1).toISOString(),
    })).rejects.toThrow("validation deadline expired");
    await expect(validateStagedAppImageUpdate({
      channel: "stable",
      operationId,
      candidatePath: staged.candidatePath,
      artifactDigest: staged.artifactDigest,
      executableIdentityDigest: staged.executableIdentityDigest,
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    })).resolves.toEqual({ stablePath: staged.stablePath });

    await expect(staged.commit()).resolves.toBe(staged.stablePath);
    expect(await readFile(staged.stablePath, "utf8")).toBe("validated-candidate");
    expect(await readFile(active, "utf8")).toBe("known-good");
    await expect(validateCommittedAppImageUpdate({
      channel: "stable",
      operationId,
      stablePath: staged.stablePath,
      artifactDigest: staged.artifactDigest,
      executableIdentityDigest: staged.executableIdentityDigest,
      deadlineAt: new Date(Date.now() - 1).toISOString(),
    })).rejects.toThrow("validation deadline expired");
    await expect(validateCommittedAppImageUpdate({
      channel: "stable",
      operationId,
      stablePath: staged.stablePath,
      artifactDigest: staged.artifactDigest,
      executableIdentityDigest: staged.executableIdentityDigest,
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    })).resolves.toBeUndefined();

    await finalizeAppImageUpdate({
      channel: "stable",
      operationId,
      stablePath: staged.stablePath,
      artifactDigest: staged.artifactDigest,
      executableIdentityDigest: staged.executableIdentityDigest,
    });
    expect(await missing(active)).toBe(true);
    expect(await readFile(staged.stablePath, "utf8")).toBe("validated-candidate");
    expect(await missing(join(root, ".Inertia.AppImage.inertia-update-backup")))
      .toBe(true);
    expect(await missing(join(root, ".Inertia.AppImage.inertia-update.json")))
      .toBe(true);
  });

  it.each([
    "backup-unlinked",
    "original-unlinked",
    "next-journal-unlinked",
    "rollback-residue-synced",
    "journal-unlinked",
    "directory-synced",
  ] as const)(
    "converges when finalization is interrupted after %s",
    async (interruptedStep) => {
      const root = await temporaryRoot();
      const active = await appImage(
        join(root, "Inertia-0.0.46.AppImage"),
        "known-good",
      );
      const downloaded = await appImage(
        join(root, "downloaded.AppImage"),
        "validated-candidate",
      );
      const operationId = "33333333-3333-4333-8333-333333333333";
      const staged = await prepareAppImageUpdate({
        channel: "stable",
        activePath: active,
        downloadedPath: downloaded,
        operationId,
      });
      await staged.commit();
      let interrupt = true;

      await expect(finalizeAppImageUpdate({
        channel: "stable",
        operationId,
        stablePath: staged.stablePath,
        artifactDigest: staged.artifactDigest,
        executableIdentityDigest: staged.executableIdentityDigest,
        testHooks: {
          afterCleanupStep: (step) => {
            if (interrupt && step === interruptedStep) {
              interrupt = false;
              throw new Error("simulated finalization interruption");
            }
          },
        },
      })).rejects.toThrow("simulated finalization interruption");

      await expect(finalizeAppImageUpdate({
        channel: "stable",
        operationId,
        stablePath: staged.stablePath,
        artifactDigest: staged.artifactDigest,
        executableIdentityDigest: staged.executableIdentityDigest,
      })).resolves.toBeUndefined();
      await expect(readFile(staged.stablePath, "utf8"))
        .resolves.toBe("validated-candidate");
      expect(await missing(active)).toBe(true);
      expect(await missing(join(root, ".Inertia.AppImage.inertia-update-backup")))
        .toBe(true);
      expect(await missing(join(root, ".Inertia.AppImage.inertia-update.json")))
        .toBe(true);
    },
  );

  it.each(["candidate", "next-journal"] as const)(
    "retains finalization authority for unexpected %s residue",
    async (kind) => {
      const root = await temporaryRoot();
      const active = await appImage(
        join(root, "Inertia-0.0.46.AppImage"),
        "known-good",
      );
      const downloaded = await appImage(
        join(root, "downloaded.AppImage"),
        "validated-candidate",
      );
      const operationId = "33333333-3333-4333-8333-333333333333";
      const staged = await prepareAppImageUpdate({
        channel: "stable",
        activePath: active,
        downloadedPath: downloaded,
        operationId,
      });
      await staged.commit();
      const residuePath = kind === "candidate"
        ? staged.candidatePath
        : join(root, ".Inertia.AppImage.inertia-update-next.json");
      await writeFile(residuePath, "unexpected", { mode: 0o600 });

      await expect(finalizeAppImageUpdate({
        channel: "stable",
        operationId,
        stablePath: staged.stablePath,
        artifactDigest: staged.artifactDigest,
        executableIdentityDigest: staged.executableIdentityDigest,
      })).rejects.toThrow("finalization residue is ambiguous");

      await expect(readFile(active, "utf8")).resolves.toBe("known-good");
      expect(await missing(join(root, ".Inertia.AppImage.inertia-update-backup")))
        .toBe(false);
      expect(await missing(join(root, ".Inertia.AppImage.inertia-update.json")))
        .toBe(false);
    },
  );

  it("retains both authorities when an unversioned rollback backup is missing", async () => {
    const root = await temporaryRoot();
    const active = await appImage(join(root, "Inertia.AppImage"), "known-good");
    const downloaded = await appImage(
      join(root, "downloaded.AppImage"),
      "unadmitted-candidate",
    );
    const operationId = "33333333-3333-4333-8333-333333333333";
    const staged = await prepareAppImageUpdate({
      channel: "stable",
      activePath: active,
      downloadedPath: downloaded,
      operationId,
    });
    await staged.commit();
    await unlink(join(root, ".Inertia.AppImage.inertia-update-backup"));

    await expect(recoverAppImageUpdateForHandoff({
      channel: "stable",
      activePath: staged.stablePath,
      expected: {
        operationId,
        artifactDigest: staged.artifactDigest,
        executableIdentityDigest: staged.executableIdentityDigest,
        phases: ["ownership-committed"],
      },
    })).rejects.toThrow("known-good AppImage is unavailable");

    await expect(readFile(staged.stablePath, "utf8"))
      .resolves.toBe("unadmitted-candidate");
    expect(await missing(join(root, ".Inertia.AppImage.inertia-update.json")))
      .toBe(false);
  });

  it("never replaces a versioned rollback owner with a foreign original", async () => {
    const root = await temporaryRoot();
    const active = await appImage(
      join(root, "Inertia-0.0.46.AppImage"),
      "known-good",
    );
    const downloaded = await appImage(
      join(root, "downloaded.AppImage"),
      "unadmitted-candidate",
    );
    const operationId = "33333333-3333-4333-8333-333333333333";
    const staged = await prepareAppImageUpdate({
      channel: "stable",
      activePath: active,
      downloadedPath: downloaded,
      operationId,
    });
    await staged.commit();
    await unlink(active);
    await appImage(active, "foreign-replacement");

    await expect(recoverAppImageUpdateForHandoff({
      channel: "stable",
      activePath: staged.stablePath,
      expected: {
        operationId,
        artifactDigest: staged.artifactDigest,
        executableIdentityDigest: staged.executableIdentityDigest,
        phases: ["ownership-committed"],
      },
    })).rejects.toThrow("original AppImage changed before rollback");

    await expect(readFile(active, "utf8")).resolves.toBe("foreign-replacement");
    await expect(readFile(staged.stablePath, "utf8"))
      .resolves.toBe("unadmitted-candidate");
    expect(await missing(join(root, ".Inertia.AppImage.inertia-update-backup")))
      .toBe(false);
    expect(await missing(join(root, ".Inertia.AppImage.inertia-update.json")))
      .toBe(false);
  });

  it("can roll a committed but unadmitted candidate back exactly", async () => {
    const root = await temporaryRoot();
    const active = await appImage(join(root, "Inertia.AppImage"), "known-good");
    const downloaded = await appImage(
      join(root, "downloaded.AppImage"),
      "candidate",
    );
    const staged = await prepareAppImageUpdate({
      channel: "stable",
      activePath: active,
      downloadedPath: downloaded,
      operationId: "22222222-2222-4222-8222-222222222222",
    });

    await staged.commit();
    expect(await readFile(active, "utf8")).toBe("candidate");
    await staged.rollback();

    expect(await readFile(active, "utf8")).toBe("known-good");
    expect(await missing(join(root, ".Inertia.AppImage.inertia-update-backup")))
      .toBe(true);
    expect(await missing(join(root, ".Inertia.AppImage.inertia-update.json")))
      .toBe(true);
  });

  it.each(["contents", "identity"] as const)(
    "rejects candidate %s substitution after staging and retains recovery evidence",
    async (substitution) => {
      const root = await temporaryRoot();
      const active = await appImage(join(root, "Inertia-0.0.46.AppImage"), "known-good");
      const downloaded = await appImage(join(root, "downloaded.AppImage"), "candidate");
      const staged = await prepareAppImageUpdate({
        channel: "stable",
        activePath: active,
        downloadedPath: downloaded,
        operationId: "44444444-4444-4444-8444-444444444444",
      });
      if (substitution === "identity") {
        await rename(staged.candidatePath, join(root, "moved-candidate"));
      }
      await appImage(staged.candidatePath, "foreign-candidate");
      await expect(staged.commit()).rejects.toThrow("candidate changed before commit");
      expect(await readFile(active, "utf8")).toBe("known-good");
      expect(await missing(staged.stablePath)).toBe(true);
      expect(await readFile(join(root, ".Inertia.AppImage.inertia-update-backup"), "utf8"))
        .toBe("known-good");
      expect(await missing(join(root, ".Inertia.AppImage.inertia-update.json"))).toBe(false);
    },
  );

  it("does not replace a stable path occupied after staging", async () => {
    const root = await temporaryRoot();
    const active = await appImage(join(root, "Inertia-0.0.46.AppImage"), "known-good");
    const downloaded = await appImage(join(root, "downloaded.AppImage"), "candidate");
    const staged = await prepareAppImageUpdate({
      channel: "stable",
      activePath: active,
      downloadedPath: downloaded,
      operationId: "44444444-4444-4444-8444-444444444444",
    });
    await appImage(staged.stablePath, "foreign-stable");
    await expect(staged.commit()).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(active, "utf8")).toBe("known-good");
    expect(await readFile(staged.stablePath, "utf8")).toBe("foreign-stable");
    expect(await readFile(staged.candidatePath, "utf8")).toBe("candidate");
  });

  it("never launches a candidate during filesystem preparation", async () => {
    const root = await temporaryRoot();
    const marker = join(root, "candidate-ran");
    const candidate = await appImage(
      join(root, "candidate.AppImage"),
      `#!/bin/sh\nprintf launched > ${JSON.stringify(marker)}\n`,
    );

    const active = await appImage(join(root, "Inertia.AppImage"), "known-good");
    const staged = await prepareAppImageUpdate({
      channel: "stable",
      activePath: active,
      downloadedPath: candidate,
      operationId: "44444444-4444-4444-8444-444444444444",
    });
    expect(await readFile(active, "utf8")).toBe("known-good");
    await staged.rollback();
    expect(await missing(marker)).toBe(true);
  });

  it("rolls an unadmitted versioned candidate back without retiring the known-good executable", async () => {
    const root = await temporaryRoot();
    const active = await appImage(
      join(root, "Inertia-0.0.46.AppImage"),
      "known-good",
    );
    const downloaded = await appImage(
      join(root, "downloaded.AppImage"),
      "unacknowledged-candidate",
    );

    const staged = await prepareAppImageUpdate({
      channel: "stable",
      activePath: active,
      downloadedPath: downloaded,
      operationId: "44444444-4444-4444-8444-444444444444",
    });
    await staged.commit();
    expect(await readFile(active, "utf8")).toBe("known-good");
    await staged.rollback();

    expect(await readFile(active, "utf8")).toBe("known-good");
    for (const leaf of [
      "Inertia.AppImage",
      ".Inertia.AppImage.inertia-update-candidate",
      ".Inertia.AppImage.inertia-update-backup",
      ".Inertia.AppImage.inertia-update.json",
      ".Inertia.AppImage.inertia-update-next.json",
    ]) expect(await missing(join(root, leaf)), leaf).toBe(true);
  });

  it("migrates a versioned first download to Inertia.AppImage through spaces and a realpath-contained directory alias", async () => {
    const root = await temporaryRoot();
    const downloads = join(root, "Downloaded Applications");
    const cache = join(root, "Updater Cache");
    const alias = join(root, "download-alias");
    await Promise.all([mkdir(downloads), mkdir(cache)]);
    await symlink(downloads, alias, "dir");
    const active = await appImage(join(downloads, "Inertia-0.0.46.AppImage"), "old-version");
    const downloaded = await appImage(join(cache, "Inertia-0.0.47.AppImage"), "new-version");

    const installed = await completePreparedUpdate({
      channel: "stable",
      activePath: join(alias, "Inertia-0.0.46.AppImage"),
      downloadedPath: downloaded,
    });

    const stable = join(await realpath(downloads), "Inertia.AppImage");
    expect(installed).toBe(stable);
    expect(await readFile(installed, "utf8")).toBe("new-version");
    expect(await missing(active)).toBe(true);
  });

  it("keeps the unversioned name across repeated updates", async () => {
    const root = await temporaryRoot();
    const cache = join(root, "cache");
    await mkdir(cache);
    const stable = await appImage(join(root, "Inertia.AppImage"), "version-one");
    const second = await appImage(join(cache, "Inertia-0.0.47.AppImage"), "version-two");
    const third = await appImage(join(cache, "Inertia-0.0.48.AppImage"), "version-three");

    await completePreparedUpdate({
      channel: "stable",
      activePath: stable,
      downloadedPath: second,
    });
    expect(await readFile(stable, "utf8")).toBe("version-two");
    await completePreparedUpdate({
      channel: "stable",
      activePath: stable,
      downloadedPath: third,
    });

    expect(await readFile(stable, "utf8")).toBe("version-three");
  });

  it("keeps Canary on its distinct durable AppImage identity", async () => {
    const root = await temporaryRoot();
    const active = await appImage(join(root, "Inertia-Canary-0.0.46.AppImage"), "canary-old");
    const downloaded = await appImage(join(root, "downloaded-canary.AppImage"), "canary-new");

    const installed = await completePreparedUpdate({
      channel: "canary",
      activePath: active,
      downloadedPath: downloaded,
    });

    expect(installed).toBe(join(await realpath(root), "Inertia Canary.AppImage"));
    expect(installed).not.toBe(join(root, "Inertia.AppImage"));
    expect(await readFile(installed, "utf8")).toBe("canary-new");
  });

  it.each(["active symlink", "download symlink", "occupied stable symlink"])(
    "fails closed for a hostile %s without changing the active AppImage",
    async (fixture) => {
      const root = await temporaryRoot();
      const active = await appImage(join(root, "Inertia-0.0.46.AppImage"), "active");
      const downloaded = await appImage(join(root, "downloaded.AppImage"), "downloaded");
      let activePath = active;
      let downloadedPath = downloaded;
      if (fixture === "active symlink") {
        activePath = join(root, "active-link.AppImage");
        await symlink(active, activePath);
      } else if (fixture === "download symlink") {
        downloadedPath = join(root, "download-link.AppImage");
        await symlink(downloaded, downloadedPath);
      } else {
        await symlink(downloaded, join(root, "Inertia.AppImage"));
      }

      await expect(prepareAppImageUpdate({
        channel: "stable",
        operationId: "44444444-4444-4444-8444-444444444444",
        activePath,
        downloadedPath,
      })).rejects.toThrow();
      expect(await readFile(active, "utf8")).toBe("active");
    },
  );

  it.each([
    ["versioned", "Inertia-0.0.46.AppImage"],
    ["unversioned", "Inertia.AppImage"],
  ] as const)("rolls back a %s ownership commit when the replacement is not admitted", async (_kind, name) => {
    const root = await temporaryRoot();
    const active = await appImage(join(root, name), "known-good");
    const downloaded = await appImage(join(root, "downloaded.AppImage"), "broken-update");

    const staged = await prepareAppImageUpdate({
      channel: "stable",
      activePath: active,
      downloadedPath: downloaded,
      operationId: "44444444-4444-4444-8444-444444444444",
    });
    await staged.commit();
    await staged.rollback();

    expect(await readFile(active, "utf8")).toBe("known-good");
    if (name !== "Inertia.AppImage") {
      expect(await missing(join(root, "Inertia.AppImage"))).toBe(true);
    }
  });

  it("keeps both launchable paths and the journal when finalization finds a foreign backup", async () => {
    const root = await temporaryRoot();
    const active = await appImage(join(root, "Inertia-0.0.46.AppImage"), "known-good");
    const downloaded = await appImage(join(root, "downloaded.AppImage"), "replacement");
    const backup = join(root, ".Inertia.AppImage.inertia-update-backup");

    const staged = await prepareAppImageUpdate({
      channel: "stable",
      activePath: active,
      downloadedPath: downloaded,
      operationId: "44444444-4444-4444-8444-444444444444",
    });
    const installed = await staged.commit();
    await unlink(backup);
    await appImage(backup, "interfering-file");
    await expect(finalizeAppImageUpdate({
      channel: "stable",
      operationId: staged.operationId,
      stablePath: installed,
      artifactDigest: staged.artifactDigest,
      executableIdentityDigest: staged.executableIdentityDigest,
    })).rejects.toThrow();
    expect(await readFile(backup, "utf8")).toBe("interfering-file");
    expect(await missing(join(root, ".Inertia.AppImage.inertia-update.json"))).toBe(false);

    expect(installed).toBe(join(await realpath(root), "Inertia.AppImage"));
    expect(await readFile(installed, "utf8")).toBe("replacement");
    expect(await readFile(active, "utf8")).toBe("known-good");
  });

  it("rolls back stable-path recovery instead of treating candidate startup as readiness", async () => {
    const root = await temporaryRoot();
    const original = await appImage(join(root, "Inertia-0.0.46.AppImage"), "known-good");
    const stable = await appImage(join(root, "Inertia.AppImage"), "replacement");
    const backup = join(root, ".Inertia.AppImage.inertia-update-backup");
    await link(original, backup);
    const originalIdentity = fileIdentity(await lstat(original));
    const candidateIdentity = fileIdentity(await lstat(stable));
    await writeFile(join(root, ".Inertia.AppImage.inertia-update.json"), `${JSON.stringify({
      schema: 1,
      channel: "stable",
      phase: "prepared",
      originalName: "Inertia-0.0.46.AppImage",
      stableName: "Inertia.AppImage",
      original: originalIdentity,
      candidate: candidateIdentity,
    })}\n`, { mode: 0o600 });
    await expect(recoverAppImageUpdate({
      channel: "stable",
      activePath: stable,
    })).rejects.toThrow(
      "rolled back because candidate bootstrap was not acknowledged",
    );
    expect(await readFile(original, "utf8")).toBe("known-good");
    expect(await missing(stable)).toBe(true);
    expect(await missing(backup)).toBe(true);
    expect(await missing(join(root, ".Inertia.AppImage.inertia-update.json"))).toBe(true);
  });

  it("restores an unversioned known-good AppImage after an unacknowledged crash prefix", async () => {
    const root = await temporaryRoot();
    const stable = await appImage(join(root, "Inertia.AppImage"), "known-good");
    const backup = join(root, ".Inertia.AppImage.inertia-update-backup");
    const candidatePath = await appImage(
      join(root, ".Inertia.AppImage.inertia-update-candidate"),
      "unacknowledged",
    );
    const originalIdentity = fileIdentity(await lstat(stable));
    const candidateIdentity = fileIdentity(await lstat(candidatePath));
    await link(stable, backup);
    await rename(candidatePath, stable);
    await writeFile(join(root, ".Inertia.AppImage.inertia-update.json"), `${JSON.stringify({
      schema: 1,
      channel: "stable",
      phase: "prepared",
      originalName: "Inertia.AppImage",
      stableName: "Inertia.AppImage",
      original: originalIdentity,
      candidate: candidateIdentity,
    })}\n`, { mode: 0o600 });

    await expect(recoverAppImageUpdate({
      channel: "stable",
      activePath: stable,
    })).rejects.toThrow(
      "rolled back because candidate bootstrap was not acknowledged",
    );

    expect(await readFile(stable, "utf8")).toBe("known-good");
    expect(await missing(backup)).toBe(true);
    expect(await missing(join(root, ".Inertia.AppImage.inertia-update.json")))
      .toBe(true);
  });

  it("rolls back a crash after the stable rename and before launch when the versioned original relaunches", async () => {
    const root = await temporaryRoot();
    const original = await appImage(join(root, "Inertia-0.0.46.AppImage"), "known-good");
    const stable = await appImage(join(root, "Inertia.AppImage"), "unconfirmed");
    const backup = join(root, ".Inertia.AppImage.inertia-update-backup");
    await link(original, backup);
    await writeFile(join(root, ".Inertia.AppImage.inertia-update.json"), `${JSON.stringify({
      schema: 1,
      channel: "stable",
      phase: "prepared",
      originalName: "Inertia-0.0.46.AppImage",
      stableName: "Inertia.AppImage",
      original: fileIdentity(await lstat(original)),
      candidate: fileIdentity(await lstat(stable)),
    })}\n`, { mode: 0o600 });

    await expect(recoverAppImageUpdate({
      channel: "stable",
      activePath: original,
    })).resolves.toBe(join(await realpath(root), "Inertia-0.0.46.AppImage"));
    expect(await readFile(original, "utf8")).toBe("known-good");
    expect(await missing(stable)).toBe(true);
    expect(await missing(backup)).toBe(true);
  });
});
