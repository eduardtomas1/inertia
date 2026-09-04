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

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installAppImageUpdate,
  launchAppImage,
  finalizeAppImageUpdate,
  prepareAppImageUpdate,
  recoverAppImageUpdate,
  validateCommittedAppImageUpdate,
  validateStagedAppImageUpdate,
} from "../../src/main/appimage-installed-identity";

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

  it("never treats candidate process creation as bootstrap readiness", async () => {
    const root = await temporaryRoot();
    const marker = join(root, "candidate-ran");
    const candidate = await appImage(
      join(root, "candidate.AppImage"),
      "#!/bin/sh\nprintf launched > \"$INERTIA_TEST_APPIMAGE_MARKER\"\n",
    );

    await expect(launchAppImage(candidate, {
      INERTIA_TEST_APPIMAGE_MARKER: marker,
    })).rejects.toThrow(
      "cannot be admitted without a verified bootstrap acknowledgement",
    );
    expect(await missing(marker)).toBe(true);
  });

  it("rolls the production transaction back when no bootstrap ACK channel exists", async () => {
    const root = await temporaryRoot();
    const active = await appImage(
      join(root, "Inertia-0.0.46.AppImage"),
      "known-good",
    );
    const downloaded = await appImage(
      join(root, "downloaded.AppImage"),
      "unacknowledged-candidate",
    );

    await expect(installAppImageUpdate({
      channel: "stable",
      activePath: active,
      downloadedPath: downloaded,
    })).rejects.toThrow(
      "cannot be admitted without a verified bootstrap acknowledgement",
    );

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
    const launch = vi.fn(async (path: string) => {
      expect(await readFile(path, "utf8")).toBe("new-version");
    });

    const installed = await installAppImageUpdate({
      channel: "stable",
      activePath: join(alias, "Inertia-0.0.46.AppImage"),
      downloadedPath: downloaded,
      launch,
    });

    const stable = join(await realpath(downloads), "Inertia.AppImage");
    expect(installed).toBe(stable);
    expect(await readFile(installed, "utf8")).toBe("new-version");
    expect(await missing(active)).toBe(true);
    expect(launch).toHaveBeenCalledWith(stable, process.env);
  });

  it("keeps the unversioned name across repeated updates", async () => {
    const root = await temporaryRoot();
    const cache = join(root, "cache");
    await mkdir(cache);
    const stable = await appImage(join(root, "Inertia.AppImage"), "version-one");
    const second = await appImage(join(cache, "Inertia-0.0.47.AppImage"), "version-two");
    const third = await appImage(join(cache, "Inertia-0.0.48.AppImage"), "version-three");
    const launch = vi.fn(async () => undefined);

    await installAppImageUpdate({
      channel: "stable",
      activePath: stable,
      downloadedPath: second,
      launch,
    });
    expect(await readFile(stable, "utf8")).toBe("version-two");
    await installAppImageUpdate({
      channel: "stable",
      activePath: stable,
      downloadedPath: third,
      launch,
    });

    expect(await readFile(stable, "utf8")).toBe("version-three");
    expect(launch).toHaveBeenCalledTimes(2);
    const canonicalStable = join(await realpath(root), "Inertia.AppImage");
    expect(launch).toHaveBeenNthCalledWith(1, canonicalStable, process.env);
    expect(launch).toHaveBeenNthCalledWith(2, canonicalStable, process.env);
  });

  it("keeps Canary on its distinct durable AppImage identity", async () => {
    const root = await temporaryRoot();
    const active = await appImage(join(root, "Inertia-Canary-0.0.46.AppImage"), "canary-old");
    const downloaded = await appImage(join(root, "downloaded-canary.AppImage"), "canary-new");

    const installed = await installAppImageUpdate({
      channel: "canary",
      activePath: active,
      downloadedPath: downloaded,
      launch: async () => undefined,
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

      await expect(installAppImageUpdate({
        channel: "stable",
        activePath,
        downloadedPath,
        launch: async () => undefined,
      })).rejects.toThrow();
      expect(await readFile(active, "utf8")).toBe("active");
    },
  );

  it.each([
    ["versioned", "Inertia-0.0.46.AppImage"],
    ["unversioned", "Inertia.AppImage"],
  ] as const)("rolls back a %s installation when the replacement cannot launch", async (_kind, name) => {
    const root = await temporaryRoot();
    const active = await appImage(join(root, name), "known-good");
    const downloaded = await appImage(join(root, "downloaded.AppImage"), "broken-update");

    await expect(installAppImageUpdate({
      channel: "stable",
      activePath: active,
      downloadedPath: downloaded,
      launch: async () => { throw new Error("launch failed"); },
    })).rejects.toThrow("launch failed");

    expect(await readFile(active, "utf8")).toBe("known-good");
    if (name !== "Inertia.AppImage") {
      expect(await missing(join(root, "Inertia.AppImage"))).toBe(true);
    }
  });

  it("keeps both launchable paths when cleanup is interrupted after the replacement starts", async () => {
    const root = await temporaryRoot();
    const active = await appImage(join(root, "Inertia-0.0.46.AppImage"), "known-good");
    const downloaded = await appImage(join(root, "downloaded.AppImage"), "replacement");
    const backup = join(root, ".Inertia.AppImage.inertia-update-backup");

    const installed = await installAppImageUpdate({
      channel: "stable",
      activePath: active,
      downloadedPath: downloaded,
      launch: async (path) => {
        expect(await readFile(path, "utf8")).toBe("replacement");
        await unlink(backup);
        await appImage(backup, "interfering-file");
      },
    });

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
