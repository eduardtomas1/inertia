import { mkdir, readFile, symlink, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { cleanupLegacyAuthority, PrivateConnectPrivacyMonitor } from "../../../src/main/private-connect/host";

describe("Private Connect legacy migration", () => {
  it("samples the current lock state before access can be restored", () => {
    const events = new EventEmitter() as EventEmitter & {
      getSystemIdleState(): "active" | "idle" | "locked" | "unknown";
    };
    events.getSystemIdleState = () => "locked";
    const observed: boolean[] = [];
    const monitor = new PrivateConnectPrivacyMonitor(
      events as never,
      (locked) => observed.push(locked),
    );
    expect(monitor.isLocked()).toBe(true);
    events.emit("unlock-screen");
    expect(monitor.isLocked()).toBe(false);
    expect(observed).toEqual([false]);
    monitor.shutdown();
  });

  it("fails closed when the current lock state cannot be verified", () => {
    const events = new EventEmitter() as EventEmitter & {
      getSystemIdleState(): "active" | "idle" | "locked" | "unknown";
    };
    events.getSystemIdleState = () => "unknown";
    const monitor = new PrivateConnectPrivacyMonitor(events as never, () => undefined);
    expect(monitor.isLocked()).toBe(true);
    monitor.shutdown();
  });

  it("removes only the known regular legacy vault files and writes a marker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-private-connect-migration-"));
    try {
      await writeFile(join(directory, "remote-access.vault"), "old");
      await writeFile(join(directory, "keep.txt"), "keep");
      expect(await cleanupLegacyAuthority(directory)).toEqual({ cleaned: true });
      await expect(readFile(join(directory, "remote-access.vault"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(directory, "keep.txt"), "utf8")).toBe("keep");
      expect(await readFile(join(directory, "private-connect-migration-v1"), "utf8")).toBe("private-connect-migration-v1\n");
      expect(await cleanupLegacyAuthority(directory)).toEqual({ cleaned: false });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a legacy symlink instead of deleting through it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-private-connect-migration-"));
    try {
      const target = join(directory, "target");
      await mkdir(target);
      await symlink(target, join(directory, "remote-access.vault"));
      await expect(cleanupLegacyAuthority(directory)).rejects.toThrow("non-regular file");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
