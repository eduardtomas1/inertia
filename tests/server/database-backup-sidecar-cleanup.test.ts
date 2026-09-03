import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({
  existsSync: vi.fn(),
  lstatSync: vi.fn(),
  readdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock("node:fs", () => filesystem);

import { cleanAutomaticBackupSidecars } from
  "../../src/server/persistence/database-backup-sidecar-cleanup";

function regularFile(): {
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
} {
  return {
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

describe("automatic backup sidecar cleanup", () => {
  const profileDirectory = join("profile", "inertia-test");
  const databasePath = join(profileDirectory, "inertia.sqlite");
  const backupsDirectory = join(profileDirectory, "backups");

  beforeEach(() => {
    filesystem.existsSync.mockReset().mockReturnValue(true);
    filesystem.lstatSync.mockReset().mockReturnValue(regularFile());
    filesystem.readdirSync.mockReset().mockReturnValue([
      "inertia-20260101T000000000Z.sqlite.partial",
    ]);
    filesystem.unlinkSync.mockReset();
  });

  it("defers a Windows-locked unpublished partial until the next startup", () => {
    filesystem.unlinkSync.mockImplementationOnce(() => {
      const error = new Error("file is still in use") as NodeJS.ErrnoException;
      error.code = "EBUSY";
      throw error;
    });

    expect(() => cleanAutomaticBackupSidecars(
      databasePath,
      backupsDirectory,
    )).not.toThrow();
    expect(filesystem.unlinkSync).toHaveBeenCalledOnce();
    expect(filesystem.unlinkSync).toHaveBeenCalledWith(
      join(
        backupsDirectory,
        "inertia-20260101T000000000Z.sqlite.partial",
      ),
    );
  });

  it("still fails closed for non-transient removal errors", () => {
    filesystem.unlinkSync.mockImplementationOnce(() => {
      const error = new Error("unexpected I/O failure") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    });

    expect(() => cleanAutomaticBackupSidecars(
      databasePath,
      backupsDirectory,
    )).toThrow("unexpected I/O failure");
  });
});
