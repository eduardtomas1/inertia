import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveAppUpdateCapability } from "../../src/main/app-update-capability";

const roots: string[] = [];

function fixture(marker?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "inertia-update-capability-"));
  roots.push(root);
  if (marker !== undefined) {
    writeFileSync(join(root, "package.json"), JSON.stringify({
      name: "inertia",
      inertiaUpdateCapability: marker,
    }));
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("packaged update capability", () => {
  it("never upgrades development, missing, malformed, or platform-mismatched builds", () => {
    expect(resolveAppUpdateCapability({
      isPackaged: false,
      platform: "win32",
      appPath: fixture({ delivery: "in-app", platform: "win32" }),
    })).toEqual({ delivery: "manual", reason: "development-build" });
    expect(resolveAppUpdateCapability({
      isPackaged: true,
      platform: "win32",
      appPath: fixture(),
    })).toEqual({ delivery: "manual", reason: "capability-missing" });
    expect(resolveAppUpdateCapability({
      isPackaged: true,
      platform: "win32",
      appPath: fixture({ delivery: "in-app", platform: "win32", extra: true }),
    })).toEqual({ delivery: "manual", reason: "capability-invalid" });
    expect(resolveAppUpdateCapability({
      isPackaged: true,
      platform: "linux",
      appPath: fixture({ delivery: "in-app", platform: "win32" }),
    })).toEqual({ delivery: "manual", reason: "platform-mismatch" });
  });

  it("honors only an allowlisted manual build reason", () => {
    expect(resolveAppUpdateCapability({
      isPackaged: true,
      platform: "darwin",
      appPath: fixture({ delivery: "manual", reason: "macos-signing-unavailable" }),
    })).toEqual({ delivery: "manual", reason: "macos-signing-unavailable" });
    expect(resolveAppUpdateCapability({
      isPackaged: true,
      platform: "darwin",
      appPath: fixture({ delivery: "manual", reason: "remote-controlled" }),
    })).toEqual({ delivery: "manual", reason: "capability-invalid" });
  });

  it("requires an absolute, regular, non-symlinked, replaceable AppImage", () => {
    const root = fixture({ delivery: "in-app", platform: "linux" });
    const appImage = join(root, "Inertia.AppImage");
    writeFileSync(appImage, "fixture");
    expect(resolveAppUpdateCapability({
      isPackaged: true,
      platform: "linux",
      appPath: root,
      appImagePath: appImage,
    })).toEqual({ delivery: "in-app" });

    const symlink = join(root, "linked.AppImage");
    symlinkSync(appImage, symlink);
    expect(resolveAppUpdateCapability({
      isPackaged: true,
      platform: "linux",
      appPath: root,
      appImagePath: symlink,
    })).toEqual({ delivery: "manual", reason: "appimage-invalid" });

    const directory = join(root, "not-an-appimage");
    mkdirSync(directory);
    expect(resolveAppUpdateCapability({
      isPackaged: true,
      platform: "linux",
      appPath: root,
      appImagePath: directory,
    })).toEqual({ delivery: "manual", reason: "appimage-invalid" });
  });
});
